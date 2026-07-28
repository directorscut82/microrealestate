/**
 * Tier-2 re-capture sessions — Slice 6 §15.
 *
 * When Tier-1 auto re-crop still can't produce a checksum-valid RF/IBAN, the
 * open receipt dialog offers «Θα στείλω άλλη φωτογραφία». The user sends a
 * zoomed close-up of just that line to the Telegram bot; the Slice-4 poller —
 * the SINGLE getUpdates consumer — routes the NEXT admin-chat photo to the
 * active session for that realm instead of ingesting it as an InboxItem. The
 * dialog polls GET /bills/recapture/:id until the field is recovered or times
 * out (~2 min). The field is ALWAYS manually editable, so this never
 * dead-ends.
 *
 * Correlation is "the next admin-chat photo while a session is OPEN for this
 * realm" (single-realm adminChatId, single api replica — same assumptions the
 * poller already documents). In-memory like the upload rate-limiter; a session
 * is ephemeral (2 min) so losing it on restart is harmless — the user retries.
 */

export type RecaptureTarget = 'rf' | 'iban';

export interface RecaptureSession {
  id: string;
  realmId: string;
  target: RecaptureTarget;
  createdAt: number;
  expiresAt: number;
  status: 'waiting' | 'recovered' | 'timeout';
  value?: string; // the recovered, checksum-valid token
  // The normalized billingId of the bill being corrected, when the client
  // knows it. The poller uses it to REFUSE a re-shot that parses to a DIFFERENT
  // bill (which would otherwise be swallowed + inject a foreign RF — the
  // recapture-hijack HIGH). Undefined for a bill not yet saved (billingId still
  // being captured) — then only the timestamp gate applies.
  expectedBillingId?: string;
}

const TTL_MS = 2 * 60 * 1000;

// realmId → the single active session (one open dialog per realm at a time; a
// new start supersedes any prior waiting session for that realm).
const byRealm = new Map<string, RecaptureSession>();
const byId = new Map<string, RecaptureSession>();

function _sweep(now: number): void {
  for (const [id, s] of byId) {
    if (now > s.expiresAt) {
      if (s.status === 'waiting') s.status = 'timeout';
      // keep a short grace so a late GET still reads 'timeout', then drop
      if (now > s.expiresAt + 30_000) {
        byId.delete(id);
        if (byRealm.get(s.realmId)?.id === id) byRealm.delete(s.realmId);
      }
    }
  }
}

export function startSession(
  realmId: string,
  target: RecaptureTarget,
  now: number,
  id: string,
  expectedBillingId?: string
): RecaptureSession {
  _sweep(now);
  // Supersede any prior waiting session for this realm.
  const prev = byRealm.get(realmId);
  if (prev) byId.delete(prev.id);
  const s: RecaptureSession = {
    id,
    realmId,
    target,
    createdAt: now,
    expiresAt: now + TTL_MS,
    status: 'waiting',
    ...(expectedBillingId ? { expectedBillingId } : {})
  };
  byRealm.set(realmId, s);
  byId.set(id, s);
  return s;
}

export function getSession(id: string, now: number): RecaptureSession | null {
  _sweep(now);
  const s = byId.get(id);
  if (!s) return null;
  if (s.status === 'waiting' && now > s.expiresAt) s.status = 'timeout';
  return s;
}

/** The active WAITING session for a realm (what the poller routes a photo to). */
export function activeSessionForRealm(
  realmId: string,
  now: number
): RecaptureSession | null {
  _sweep(now);
  const s = byRealm.get(realmId);
  if (!s || s.status !== 'waiting') return null;
  if (now > s.expiresAt) {
    s.status = 'timeout';
    return null;
  }
  return s;
}

export function resolveSession(
  realmId: string,
  value: string,
  now: number
): RecaptureSession | null {
  const s = byRealm.get(realmId);
  if (!s || s.status !== 'waiting') return null;
  if (now > s.expiresAt) {
    s.status = 'timeout';
    byRealm.delete(realmId);
    return null;
  }
  s.status = 'recovered';
  s.value = value;
  byRealm.delete(realmId); // consumed — the next photo is a normal ingest again
  return s;
}

/**
 * Is `incoming` photo the genuine re-shot for `session`, or a different bill
 * that must NOT be consumed (recapture-hijack HIGH)? Pure + unit-testable.
 *   - msgDate (unix seconds, optional): a re-shot is sent AFTER the session
 *     opened; a photo timestamped before createdAt (minus a 5s skew grace) is a
 *     backlog bill → reject.
 *   - parsedBillingId (normalized, optional): if the session is BOUND to a bill
 *     and the photo parses to a DIFFERENT billingId, it's another bill → reject.
 *   - parsedAsFullBill: true when the photo parsed as a complete bill (a
 *     billingId was extracted). A re-shot is a ZOOM of a single RF/IBAN line and
 *     does NOT parse as a full bill. So for an UNBOUND session (the common case —
 *     the receipt-recapture dialog sends no billingId), a photo that parses as a
 *     full bill is a NEW bill the user happened to send during the open dialog,
 *     NOT the re-shot → reject so normal ingest PRESERVES it instead of
 *     swallowing it (Step-7: unbound-session hijack, silent bill loss). A bound
 *     session already discriminates by billingId above, so this gate only bites
 *     the unbound case.
 * Returns true only when the photo should be consumed as the re-shot.
 */
export function isRecaptureCandidate(
  session: Pick<RecaptureSession, 'createdAt' | 'expectedBillingId'>,
  msgDate: number | undefined,
  parsedBillingId: string | undefined,
  parsedAsFullBill = false
): boolean {
  if (typeof msgDate === 'number' && msgDate * 1000 < session.createdAt - 5_000) {
    return false;
  }
  if (
    session.expectedBillingId &&
    parsedBillingId &&
    String(parsedBillingId) !== String(session.expectedBillingId)
  ) {
    return false;
  }
  // The photo parsed as a WHOLE bill (not a single-code zoom). Reject it as the
  // re-shot UNLESS it is provably the bound bill — i.e. only a bound session
  // whose billingId the photo matches (handled by the equality gate above) may
  // consume a full bill. Otherwise it is a NEW/different bill the user sent while
  // the dialog was open and must be INGESTED, not swallowed:
  //   - Unbound session (the live case — the receipt dialog sends no billingId):
  //     any full bill is foreign → reject.
  //   - Bound session + full bill with NO parsedBillingId (uniquely EYDAP/EPA,
  //     which never parse to a billingId): can't be confirmed as the bound bill
  //     → reject. This closes the round-4 LATENT gap (a bound session would
  //     otherwise swallow an EYDAP/EPA bill, reintroducing the round-2 silent
  //     bill-loss the instant any caller starts binding billingId).
  // A full DEH bill on a bound session with a MATCHING billingId already passed
  // the equality gate above and is (correctly) still a candidate.
  if (parsedAsFullBill && !parsedBillingId) {
    return false;
  }
  if (!session.expectedBillingId && parsedAsFullBill) {
    return false;
  }
  return true;
}

// test-only reset
export function _clearAll(): void {
  byRealm.clear();
  byId.clear();
}
