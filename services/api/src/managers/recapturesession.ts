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
  id: string
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
    status: 'waiting'
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

// test-only reset
export function _clearAll(): void {
  byRealm.clear();
  byId.clear();
}
