import {
  ownerKeyOf,
  recomputeOwnerExpensePaid,
  carryOwnerPayments,
  applyCarriedSettlement,
  autoSpreadOwnerPayment
} from '../managers/ownermanager.ts';

// Owner-debt ledger settlement engine — the pure money logic behind owner
// καταβολές. Mirrors the tenant rent settlement but keyed by owner charge.

describe('ownerKeyOf — owner identity', () => {
  it('prefers memberId', () => {
    expect(ownerKeyOf({ memberId: 'abc', name: 'X', taxId: '1' })).toBe('m:abc');
  });
  it('falls back to normalized name|taxId', () => {
    expect(ownerKeyOf({ name: ' Γιώργος ', taxId: '123' })).toBe(
      'n:γιώργος|123'
    );
  });
  it('two units, same owner identity → same key (aggregate)', () => {
    const a = ownerKeyOf({ name: 'Maria', taxId: '999' });
    const b = ownerKeyOf({ name: 'maria', taxId: '999' });
    expect(a).toBe(b);
  });
  it('D4: nameless + taxId-less owner → empty key (NOT merged into "n:|")', () => {
    expect(ownerKeyOf({ percentage: 50 })).toBe('');
    expect(ownerKeyOf({ name: '', taxId: '' })).toBe('');
    expect(ownerKeyOf(null)).toBe('');
  });
});

describe('recomputeOwnerExpensePaid — derived paid from payments', () => {
  it('unpaid when no payments', () => {
    const row = { amount: 100, payments: [] };
    recomputeOwnerExpensePaid(row);
    expect(row.paid).toBe(false);
    expect(row.paidDate).toBe(null);
  });
  it('partial payment is NOT paid', () => {
    const row = { amount: 100, payments: [{ amount: 40, date: '2026-06-01' }] };
    recomputeOwnerExpensePaid(row);
    expect(row.paid).toBe(false);
  });
  it('full payment (sum >= amount) is paid; paidDate = latest payment', () => {
    const row = {
      amount: 100,
      payments: [
        { amount: 40, date: '2026-06-01' },
        { amount: 60, date: '2026-06-10' }
      ]
    };
    recomputeOwnerExpensePaid(row);
    expect(row.paid).toBe(true);
    expect(new Date(row.paidDate).toISOString().slice(0, 10)).toBe('2026-06-10');
  });
  it('overpayment is paid (>= within tolerance)', () => {
    const row = { amount: 30, payments: [{ amount: 30, date: '2026-06-01' }] };
    recomputeOwnerExpensePaid(row);
    expect(row.paid).toBe(true);
  });
  it('zero-amount charge is never "paid" (avoids div-by-meaning)', () => {
    const row = { amount: 0, payments: [] };
    recomputeOwnerExpensePaid(row);
    expect(row.paid).toBe(false);
  });
});

describe('carryOwnerPayments + applyCarriedSettlement — settlement survives strip+rebuild', () => {
  // Helper: simulate a rebuild — carry from prior, build the new row with a
  // (possibly different) amount, apply settlement.
  const rebuild = (prior, newAmount) => {
    const carried = carryOwnerPayments(prior);
    const row = { amount: newAmount, payments: carried.payments };
    applyCarriedSettlement(row, carried);
    return row;
  };

  it('empty prior → empty payments, unpaid', () => {
    const carried = carryOwnerPayments(undefined);
    expect(carried.payments).toEqual([]);
    const row = { amount: 100, payments: carried.payments };
    applyCarriedSettlement(row, carried);
    expect(row.paid).toBe(false);
    expect(row.paidDate).toBe(null);
  });

  it('payments carry forward; paid derived against the (unchanged) amount', () => {
    const prior = {
      amount: 50,
      paid: true,
      payments: [{ amount: 50, date: '2026-06-05', type: 'cash', reference: 'r' }]
    };
    const row = rebuild(prior, 50);
    expect(row.payments).toHaveLength(1);
    expect(row.payments[0].type).toBe('cash');
    expect(row.paid).toBe(true); // 50 of 50 → paid survives
  });

  it('D1: paid is derived against the NEW amount, not the prior amount', () => {
    // €50 charge fully paid (50), then edited UP to €100. Must be UNPAID now.
    const prior = { amount: 50, paid: true, payments: [{ amount: 50, date: '2026-06-01' }] };
    const row = rebuild(prior, 100);
    expect(row.paid).toBe(false); // 50 of 100 → NOT fully paid (the D1 bug)
  });

  it('D1: amount edited DOWN below the paid sum → still paid', () => {
    const prior = { amount: 100, paid: true, payments: [{ amount: 100, date: '2026-06-01' }] };
    const row = rebuild(prior, 80);
    expect(row.paid).toBe(true); // 100 >= 80 → paid
  });

  it('D2: a manual paid toggle (paid=true, empty payments) survives rebuild when amount unchanged', () => {
    const prior = { amount: 30, paid: true, paidDate: new Date('2026-06-02'), payments: [] };
    const row = rebuild(prior, 30);
    expect(row.paid).toBe(true); // bare manual paid preserved
  });

  it('D2: a manual paid toggle is DROPPED when the amount changes (re-confirm needed)', () => {
    const prior = { amount: 30, paid: true, paidDate: new Date('2026-06-02'), payments: [] };
    const row = rebuild(prior, 45);
    expect(row.paid).toBe(false); // amount grew → manual paid no longer trusted
  });

  it('deep-copies payment slices (new subdoc owns them)', () => {
    const prior = { amount: 10, payments: [{ amount: 10, date: '2026-06-01' }] };
    const carried = carryOwnerPayments(prior);
    carried.payments[0].amount = 999;
    expect(prior.payments[0].amount).toBe(10); // original untouched
  });

  it('partial payment carries forward as still-unpaid', () => {
    const prior = { amount: 100, payments: [{ amount: 25, date: '2026-06-01' }] };
    const row = rebuild(prior, 100);
    expect(row.paid).toBe(false);
    expect(row.payments[0].amount).toBe(25);
  });
});

describe('autoSpreadOwnerPayment — oldest-first allocation', () => {
  const owed = [
    { ownerExpenseId: 'a', amount: 30 }, // oldest
    { ownerExpenseId: 'b', amount: 50 },
    { ownerExpenseId: 'c', amount: 20 }
  ];
  it('fills oldest first, stops when exhausted', () => {
    const alloc = autoSpreadOwnerPayment(40, owed);
    // 30 → a, 10 → b
    expect(alloc).toEqual([
      { ownerExpenseId: 'a', amount: 30 },
      { ownerExpenseId: 'b', amount: 10 }
    ]);
  });
  it('exact full settlement of all lines', () => {
    const alloc = autoSpreadOwnerPayment(100, owed);
    expect(alloc).toEqual([
      { ownerExpenseId: 'a', amount: 30 },
      { ownerExpenseId: 'b', amount: 50 },
      { ownerExpenseId: 'c', amount: 20 }
    ]);
  });
  it('surplus beyond total owed is left unallocated (caller drops it)', () => {
    const alloc = autoSpreadOwnerPayment(130, owed);
    const sum = alloc.reduce((s, a) => s + a.amount, 0);
    expect(sum).toBe(100); // only 100 owed; 30 surplus not allocated
  });
  it('partial first line', () => {
    const alloc = autoSpreadOwnerPayment(15, owed);
    expect(alloc).toEqual([{ ownerExpenseId: 'a', amount: 15 }]);
  });
  it('no owed lines → empty', () => {
    expect(autoSpreadOwnerPayment(50, [])).toEqual([]);
  });
});

// D5 dedupe-before-cap: the allocation fold logic (extracted as a pure check
// since pay() is DB-coupled). Two entries on the same charge must SUM before
// the per-row outstanding cap — otherwise each passes individually but the
// row is overpaid. This mirrors the fold in pay().
describe('D5 allocation fold — duplicate ownerExpenseId entries sum before cap', () => {
  const fold = (entries) => {
    const m = new Map();
    for (const a of entries) {
      const id = String(a.ownerExpenseId);
      const amt = Math.round((Number(a.amount) || 0) * 100) / 100;
      if (!(amt > 0.005)) continue;
      m.set(id, Math.round(((m.get(id) || 0) + amt) * 100) / 100);
    }
    return Array.from(m.entries()).map(([ownerExpenseId, amount]) => ({
      ownerExpenseId,
      amount
    }));
  };
  it('two entries on charge X sum to one folded entry', () => {
    const out = fold([
      { ownerExpenseId: 'X', amount: 60 },
      { ownerExpenseId: 'X', amount: 60 }
    ]);
    expect(out).toEqual([{ ownerExpenseId: 'X', amount: 120 }]);
    // 120 then fails a cap of outstanding=100 → rejected (the D5 fix).
    expect(out[0].amount > 100 + 0.005).toBe(true);
  });
  it('distinct charges stay separate', () => {
    const out = fold([
      { ownerExpenseId: 'X', amount: 30 },
      { ownerExpenseId: 'Y', amount: 20 }
    ]);
    expect(out).toHaveLength(2);
  });
});
