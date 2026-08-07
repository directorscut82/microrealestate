/**
 * Owner-καταβολή helpers shared by the OwnerPaymentDialog and its tests.
 */

import { digest64 } from './txnId';

const _round = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * CONTENT-DERIVED idempotency key for one owner-payment submit.
 *
 * The server stamps this key on every recorded slice and, on a retry after a
 * multi-building PARTIAL COMMIT (mongo 4.4 standalone has no multi-doc
 * transaction, so a mid-loop save failure lands some slices and 409s the
 * caller), records only the not-yet-landed remainder — never double-recording.
 *
 * Deriving the key from STABLE payment content (owner + amount + date + type +
 * reference + allocation) rather than a random per-draft id is what makes the
 * retry durable: a resubmit of the SAME payment produces the SAME key even
 * across a dialog close/reopen, page refresh, second tab, or another device
 * (a random key had no cross-session durability — Step-7 round-5). Two
 * DIFFERENT payments derive different keys, so a genuine second payment is
 * never mistaken for a retry. The rare inverse — two GENUINELY-identical
 * payments colliding on one key — is surfaced by the server's
 * `alreadyRecorded` flag so it can never be a silent under-record.
 *
 * The digest is a small deterministic djb2-xor hash (not security-sensitive;
 * only needs to be stable per content and distinct across payments), prefixed
 * and padded to satisfy the server contract ^[A-Za-z0-9._-]{8,80}$.
 */
export function stableOwnerTxnId(ownerKey, payload) {
  const alloc = (payload?.allocation || [])
    .map((a) => `${a.ownerExpenseId}:${_round(a.amount)}`)
    .sort()
    .join(',');
  const basis = [
    ownerKey || '',
    _round(payload?.amount),
    payload?.date || '',
    payload?.type || '',
    (payload?.reference || '').trim(),
    alloc
  ].join('|');
  // 64-bit two-pass digest — see utils/txnId.js for why 32 bits is too thin
  // for money. Shared with the building-coverage key so the two can't drift.
  return `own-${digest64(basis)}`;
}
