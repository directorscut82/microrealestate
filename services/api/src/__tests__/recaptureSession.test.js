/* eslint-env node, jest */
// Slice 6 Tier-2 — re-capture session lifecycle (in-memory, TTL, correlation).
import {
  startSession,
  getSession,
  activeSessionForRealm,
  resolveSession,
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
});
