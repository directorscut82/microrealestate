/**
 * Shared 64-bit content digest for CONTENT-DERIVED idempotency keys.
 *
 * Two independent 32-bit passes (djb2-xor and FNV-1a) combined into 64 bits. One
 * 32-bit hash is too thin for money: at a few hundred payments per payer, birthday
 * collisions reach the 0.01% band, and a collision with an OLD payment silently
 * shrinks a new payment's allocation. 64 bits pushes that to ~10⁹ payments.
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
 * (POST /buildings/:id/uncollected-payment). The endpoint is append-only with no
 * DELETE/PATCH, so a duplicate cannot be undone from the UI — it just doubles the
 * building's covered figure. The server skips a submit whose key already landed.
 *
 * Two rules, both of which have caused double-counting when broken:
 * · Only fields the CLIENT sends. A server-defaulted `date` inside a key made
 *   every receipt retry derive a new key and record twice.
 * · `term` is EXCLUDED. The server re-allocates across the year's outstanding
 *   terms oldest-first, so the landing term is not client-knowable; including it
 *   would make a retry (whose outstanding has changed) derive a different key.
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
