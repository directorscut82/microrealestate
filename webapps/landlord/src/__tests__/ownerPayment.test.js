import { stableOwnerTxnId } from '../utils/ownerPayment';

// Step-7 round-5: the owner-payment idempotency key must be DETERMINISTIC per
// payment content (so a retry of the same payment — even across a dialog
// close/reopen — reconciles server-side and records only the remainder) and
// DISTINCT across different payments (so a genuine second payment isn't dropped
// as a retry).
describe('stableOwnerTxnId — content-derived idempotency key', () => {
  const base = {
    amount: 100,
    date: '2026-07-28',
    type: 'transfer',
    reference: 'REF-1',
    allocation: [
      { ownerExpenseId: 'a', amount: 60 },
      { ownerExpenseId: 'b', amount: 40 }
    ]
  };

  it('is deterministic for identical content', () => {
    expect(stableOwnerTxnId('own:1', base)).toBe(stableOwnerTxnId('own:1', base));
  });

  it('is stable regardless of allocation ENTRY ORDER (sorted before hashing)', () => {
    const reordered = {
      ...base,
      allocation: [
        { ownerExpenseId: 'b', amount: 40 },
        { ownerExpenseId: 'a', amount: 60 }
      ]
    };
    expect(stableOwnerTxnId('own:1', reordered)).toBe(
      stableOwnerTxnId('own:1', base)
    );
  });

  it('differs when the amount differs', () => {
    expect(stableOwnerTxnId('own:1', { ...base, amount: 101 })).not.toBe(
      stableOwnerTxnId('own:1', base)
    );
  });

  it('differs when the date differs', () => {
    expect(stableOwnerTxnId('own:1', { ...base, date: '2026-07-29' })).not.toBe(
      stableOwnerTxnId('own:1', base)
    );
  });

  it('differs when the reference differs (lets a user force a distinct 2nd payment)', () => {
    expect(stableOwnerTxnId('own:1', { ...base, reference: 'REF-2' })).not.toBe(
      stableOwnerTxnId('own:1', base)
    );
  });

  it('differs when the allocation amounts differ', () => {
    const diff = {
      ...base,
      allocation: [
        { ownerExpenseId: 'a', amount: 50 },
        { ownerExpenseId: 'b', amount: 50 }
      ]
    };
    expect(stableOwnerTxnId('own:1', diff)).not.toBe(
      stableOwnerTxnId('own:1', base)
    );
  });

  it('differs per owner', () => {
    expect(stableOwnerTxnId('own:2', base)).not.toBe(
      stableOwnerTxnId('own:1', base)
    );
  });

  it('satisfies the server contract ^[A-Za-z0-9._-]{8,80}$', () => {
    const id = stableOwnerTxnId('own:1', base);
    expect(id).toMatch(/^[A-Za-z0-9._-]{8,80}$/);
  });

  it('is a 64-bit (16-hex) digest — own-XXXXXXXXXXXXXXXX (Step-7 round-6)', () => {
    // Widened from 32→64 bits so a collision with an earlier payment (which
    // would silently shrink a new payment's allocation) is unreachable.
    expect(stableOwnerTxnId('own:1', base)).toMatch(/^own-[0-9a-f]{16}$/);
  });

  it('no collisions across a large spread of distinct payments', () => {
    const seen = new Set();
    for (let amt = 1; amt <= 400; amt++) {
      for (let d = 1; d <= 9; d++) {
        const id = stableOwnerTxnId('own:1', {
          amount: amt,
          date: `2026-07-0${d}`,
          type: 'transfer',
          reference: ''
        });
        expect(seen.has(id)).toBe(false); // distinct content → distinct key
        seen.add(id);
      }
    }
    expect(seen.size).toBe(400 * 9);
  });

  it('handles an auto-spread payload (no allocation array)', () => {
    const auto = { amount: 100, date: '2026-07-28', type: 'transfer', reference: '' };
    const id = stableOwnerTxnId('own:1', auto);
    expect(id).toMatch(/^[A-Za-z0-9._-]{8,80}$/);
    expect(stableOwnerTxnId('own:1', auto)).toBe(id); // deterministic
  });
});
