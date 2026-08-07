/**
 * Shared 64-bit content digest for CONTENT-DERIVED idempotency keys.
 *
 * Extracted from utils/ownerPayment.js so every money endpoint that dedupes a
 * retry uses the SAME digest rather than a per-surface copy that drifts.
 *
 * TWO independent 32-bit passes (djb2-xor and FNV-1a) combined into a 64-bit
 * hex digest. One 32-bit hash is thin for money: with a few hundred payments
 * per payer, birthday collisions (~n²/2³³) reach the 0.01% band, and a
 * collision with an OLD payment silently shrinks a new payment's allocation
 * (Step-7 round-6). At 64 bits the same band needs ~10⁹ payments.
 *
 * Not security-sensitive — it only needs to be stable per content and distinct
 * across payments.
 */
export function digest64(basis) {
  const s = String(basis ?? '');
  let h1 = 5381;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // eslint-disable-next-line no-bitwise
    h1 = ((h1 << 5) + h1) ^ c;
    // eslint-disable-next-line no-bitwise
    h2 = Math.imul(h2 ^ c, 0x01000193);
  }
  // eslint-disable-next-line no-bitwise
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  // eslint-disable-next-line no-bitwise
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${hex1}${hex2}`;
}

const _round = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * CONTENT-DERIVED idempotency key for one building-coverage contribution
 * (POST /buildings/:id/uncollected-payment).
 *
 * The endpoint is append-only and has no DELETE/PATCH, so a duplicate cannot
 * be undone from the UI — a retry after a timeout that actually persisted, or
 * a reopen-and-resubmit, silently DOUBLED the building's covered figure. The
 * server skips a submit whose key already appears on a recorded row.
 *
 * Every field in the basis is one the CLIENT actually sends (see
 * project_source_derived_identity_keys): the dialog always supplies `date`, so
 * the key can never disagree with the row the server writes. Do NOT add a
 * field the server defaults — a server-defaulted `date` inside a key is
 * exactly what double-counted every receipt retry.
 *
 * `term` is deliberately EXCLUDED: the server re-allocates the amount across
 * that year's outstanding terms oldest-first, so the term a row lands on is
 * not client-knowable, and including it would make a retry (whose outstanding
 * has since changed) derive a different key and double-record.
 */
export function stableUncollectedTxnId(buildingId, payload) {
  const basis = [
    String(buildingId || ''),
    _round(payload?.amount),
    payload?.date || '',
    String(payload?.reference || '').trim()
  ].join('|');
  return `unc-${digest64(basis)}`;
}
