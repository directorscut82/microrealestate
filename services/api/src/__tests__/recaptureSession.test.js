/* eslint-env node, jest */
// Slice 6 Tier-2 — re-capture session lifecycle (in-memory, TTL, correlation).
import {
  startSession,
  getSession,
  activeSessionForRealm,
  resolveSession,
  isRecaptureCandidate,
  _clearAll
} from '../managers/recapturesession.js';

const R = 'realm-1';
beforeEach(() => _clearAll());

describe('recapture sessions', () => {
  it('start → waiting; active session found for the realm', () => {
    const now = 1_000_000;
    const s = startSession(R, 'iban', now, 'sess-1');
    expect(s.status).toBe('waiting');
    expect(activeSessionForRealm(R, now)).toBeTruthy();
    expect(activeSessionForRealm(R, now).target).toBe('iban');
  });

  it('resolve fills value + flips to recovered; poll reads it', () => {
    const now = 2_000_000;
    startSession(R, 'rf', now, 'sess-2');
    const r = resolveSession(R, 'RF33999000000000000000001', now);
    expect(r.status).toBe('recovered');
    expect(getSession('sess-2', now).value).toBe('RF33999000000000000000001');
    // consumed: no longer the active session for the realm
    expect(activeSessionForRealm(R, now)).toBeNull();
  });

  it('times out after TTL; active returns null', () => {
    const now = 3_000_000;
    startSession(R, 'iban', now, 'sess-3');
    const later = now + 2 * 60 * 1000 + 1;
    expect(activeSessionForRealm(R, later)).toBeNull();
    expect(getSession('sess-3', later).status).toBe('timeout');
  });

  it('a new start supersedes a prior waiting session for the same realm', () => {
    const now = 4_000_000;
    startSession(R, 'rf', now, 'old');
    startSession(R, 'iban', now + 10, 'new');
    // old id is dropped; realm points at the new one
    expect(getSession('old', now + 20)).toBeNull();
    expect(activeSessionForRealm(R, now + 20).id).toBe('new');
  });

  it('resolve on an expired session does not recover', () => {
    const now = 5_000_000;
    startSession(R, 'rf', now, 'sess-5');
    const r = resolveSession(R, 'RF00', now + 2 * 60 * 1000 + 1);
    expect(r).toBeNull();
  });

  it('sessions are realm-scoped (no cross-realm resolve)', () => {
    const now = 6_000_000;
    startSession(R, 'rf', now, 'sess-6');
    expect(resolveSession('other-realm', 'RF00', now)).toBeNull();
    expect(activeSessionForRealm(R, now)).toBeTruthy();
  });

  it('start binds expectedBillingId when provided', () => {
    const now = 7_000_000;
    const s = startSession(R, 'rf', now, 'sess-7', '999000935032');
    expect(s.expectedBillingId).toBe('999000935032');
  });
});

// recapture-hijack HIGH (ingress+error-path audit 2026-07): the two gates that
// stop a DIFFERENT/older bill photo from being swallowed as the re-shot.
describe('isRecaptureCandidate — recapture-hijack gates', () => {
  const session = { createdAt: 1_000_000, expectedBillingId: undefined };

  it('accepts a photo sent after the session opened (no binding, no date)', () => {
    expect(isRecaptureCandidate(session, undefined, undefined)).toBe(true);
  });

  it('GATE 1: rejects a photo timestamped BEFORE the session (backlog bill)', () => {
    // msgDate is unix SECONDS; createdAt is ms. Reject when msgDate*1000 <
    // createdAt-5000 = 995_000, i.e. msgDate < 995. 990s → 990_000 < 995_000 → reject.
    expect(isRecaptureCandidate(session, 990, undefined)).toBe(false);
  });

  it('GATE 1: accepts a photo within the 5s skew grace', () => {
    // 998s = 998_000ms >= 995_000 → accepted.
    expect(isRecaptureCandidate(session, 998, undefined)).toBe(true);
  });

  it('GATE 1: accepts a photo sent well after the session', () => {
    expect(isRecaptureCandidate(session, 2000, undefined)).toBe(true);
  });

  it('GATE 2: rejects a photo parsing to a DIFFERENT bound bill', () => {
    const bound = { createdAt: 1_000_000, expectedBillingId: 'BILL-A' };
    expect(isRecaptureCandidate(bound, 2000, 'BILL-B')).toBe(false);
  });

  it('GATE 2: accepts a photo parsing to the SAME bound bill', () => {
    const bound = { createdAt: 1_000_000, expectedBillingId: 'BILL-A' };
    expect(isRecaptureCandidate(bound, 2000, 'BILL-A')).toBe(true);
  });

  it('GATE 2: accepts a pure RF-line zoom (no billingId) on a bound session', () => {
    const bound = { createdAt: 1_000_000, expectedBillingId: 'BILL-A' };
    expect(isRecaptureCandidate(bound, 2000, undefined)).toBe(true);
  });

  // GATE 3 (Step-7 unbound-session follow-up): the receipt-recapture dialog
  // opens sessions with NO billingId, so gate 2 is inert there. A NEW bill photo
  // sent during the open dialog parses as a full bill and must be REJECTED
  // (→ normal ingest), not swallowed as the re-shot.
  it('GATE 3: rejects a full bill on an UNBOUND session (new bill, not a re-shot)', () => {
    const unbound = { createdAt: 1_000_000, expectedBillingId: undefined };
    // parsedAsFullBill = true (4th arg) → a whole bill arrived → reject.
    expect(isRecaptureCandidate(unbound, 2000, 'BILL-X', true)).toBe(false);
  });

  it('GATE 3: accepts a pure RF-line zoom (not a full bill) on an UNBOUND session', () => {
    const unbound = { createdAt: 1_000_000, expectedBillingId: undefined };
    // parsedAsFullBill = false (default) → a single-line zoom → accept (re-shot).
    expect(isRecaptureCandidate(unbound, 2000, undefined, false)).toBe(true);
  });

  it('GATE 3: does NOT bite a BOUND session that matches (full bill, same id)', () => {
    const bound = { createdAt: 1_000_000, expectedBillingId: 'BILL-A' };
    // Bound + same billingId + full bill → still accepted (gate 3 is unbound-only).
    expect(isRecaptureCandidate(bound, 2000, 'BILL-A', true)).toBe(true);
  });

  it('GATE 3: default 4th arg (absent) preserves prior accept behavior', () => {
    const unbound = { createdAt: 1_000_000, expectedBillingId: undefined };
    // No 4th arg → parsedAsFullBill defaults false → accept.
    expect(isRecaptureCandidate(unbound, 2000, undefined)).toBe(true);
  });

  // GATE 4 (Step-7 round-4 closure): a full bill with NO parsedBillingId
  // (uniquely EYDAP/EPA — they never parse to a billingId) can never be
  // confirmed as the bound bill, so it must be rejected on a BOUND session too —
  // otherwise a bound session would swallow an EYDAP/EPA bill (the round-2
  // silent-bill-loss) the instant any caller starts binding billingId. A full
  // DEH bill on a bound session DOES carry a billingId and is governed by the
  // equality gate, so this doesn't touch the legitimate bound-DEH path.
  describe('GATE 4 — full bill with no billingId is never a re-shot', () => {
    const bound = { createdAt: 1_000_000, expectedBillingId: 'BILL-A' };
    const unbound = { createdAt: 1_000_000, expectedBillingId: undefined };

    it('rejects an EYDAP/EPA-style full bill (no billingId) on a BOUND session', () => {
      expect(isRecaptureCandidate(bound, 2000, undefined, true)).toBe(false);
    });

    it('rejects an EYDAP/EPA-style full bill (no billingId) on an UNBOUND session', () => {
      expect(isRecaptureCandidate(unbound, 2000, undefined, true)).toBe(false);
    });

    it('still accepts a bound full DEH bill whose billingId MATCHES', () => {
      expect(isRecaptureCandidate(bound, 2000, 'BILL-A', true)).toBe(true);
    });

    it('still rejects a bound full DEH bill whose billingId DIFFERS (gate 2)', () => {
      expect(isRecaptureCandidate(bound, 2000, 'BILL-B', true)).toBe(false);
    });

    it('still accepts a single-code zoom (not a full bill) on either session', () => {
      expect(isRecaptureCandidate(bound, 2000, undefined, false)).toBe(true);
      expect(isRecaptureCandidate(unbound, 2000, undefined, false)).toBe(true);
    });
  });
});
