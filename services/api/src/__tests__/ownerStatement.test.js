/* eslint-env node, jest */
// Tests the shared common/OwnerStatement.buildOwnerStatement — the data source
// for the owner expense statement PDF. It MUST attribute charges to the same
// canonical owner the on-screen ledger does (ownermanager._aggregateOwners) so
// the PDF and the UI never diverge. Pure function, no DB.
import {
  buildOwnerStatement,
  isOwnerExpenseRowStale,
  occupiedPropertyTermKeys,
  ownerKeyOf
} from '../../../common/src/utils/ownerstatement.ts';

const mkUnit = (propertyId, owners, extra = {}) => ({
  _id: `u_${propertyId}`,
  propertyId,
  owners,
  ...extra
});

describe('buildOwnerStatement', () => {
  it('attributes a propertyId-scoped charge to the canonical (lex-first) owner', () => {
    const beta = { name: 'ΒΗΤΑ', taxId: '111' };
    const buildings = [
      {
        _id: 'b1',
        name: 'ΑΓ. ΟΔΟΣ ΕΨΙΛΟΝ',
        // A source:'vacant' row can only be created by the recompute from a
        // flag-on, active recurring expense — fixtures must reflect that or the
        // shared read-time staleness guard correctly drops them.
        expenses: [
          {
            _id: 'e1',
            type: 'electricity_common',
            isRecurring: true,
            startTerm: 2026010100,
            chargeOwnerWhenVacant: true
          }
        ],
        units: [mkUnit('p1', [beta])],
        ownerMonthlyExpenses: [
          {
            _id: 'ome1',
            expenseId: 'e1',
            propertyId: 'p1',
            term: 2026060100,
            amount: 40,
            source: 'vacant',
            paid: false,
            payments: []
          }
        ]
      }
    ];
    const key = ownerKeyOf(beta);
    const st = buildOwnerStatement(buildings, key, []);
    expect(st.owner.name).toBe('ΒΗΤΑ');
    expect(st.owner.taxId).toBe('111');
    expect(st.charges).toHaveLength(1);
    expect(st.charges[0].amount).toBe(40);
    expect(st.charges[0].expenseType).toBe('electricity_common');
    expect(st.totals.amount).toBe(40);
    expect(st.totals.outstanding).toBe(40);
  });

  it('repair rows are typed repair and strip the English "Repair:" prefix', () => {
    const owner = { name: 'A', taxId: '1' };
    const buildings = [
      {
        _id: 'b1',
        name: 'B',
        expenses: [],
        units: [mkUnit('p1', [owner])],
        ownerMonthlyExpenses: [
          {
            _id: 'r1',
            expenseId: 'rep1',
            propertyId: 'p1',
            term: 2026050100,
            amount: 50,
            source: 'repair-vacant',
            description: 'Repair: ασανσέρ',
            paid: true,
            payments: [{ amount: 50 }]
          }
        ]
      }
    ];
    const st = buildOwnerStatement(buildings, ownerKeyOf(owner), []);
    expect(st.charges[0].expenseType).toBe('repair');
    expect(st.charges[0].description).toBe('ασανσέρ'); // prefix stripped
    expect(st.charges[0].paid).toBe(true);
    expect(st.totals.paid).toBe(50);
  });

  it('filters by requested terms', () => {
    const owner = { name: 'A', taxId: '1' };
    const buildings = [
      {
        _id: 'b1',
        name: 'B',
        expenses: [{ _id: 'e1', type: 'water_common', isRecurring: true, startTerm: 2026010100, chargeOwnerWhenVacant: true }],
        units: [mkUnit('p1', [owner])],
        ownerMonthlyExpenses: [
          { _id: 'a', expenseId: 'e1', propertyId: 'p1', term: 2026050100, amount: 10, source: 'vacant', payments: [] },
          { _id: 'b', expenseId: 'e1', propertyId: 'p1', term: 2026060100, amount: 20, source: 'vacant', payments: [] }
        ]
      }
    ];
    const st = buildOwnerStatement(buildings, ownerKeyOf(owner), [2026060100]);
    expect(st.charges).toHaveLength(1);
    expect(st.charges[0].amount).toBe(20);
  });

  it('does NOT attribute a co-owned charge to the non-canonical owner', () => {
    // Two owners on the unit; canonical (lex-first by ownerKey) gets the charge.
    const a = { name: 'AAA', taxId: '1' };
    const z = { name: 'ZZZ', taxId: '2' };
    const buildings = [
      {
        _id: 'b1',
        name: 'B',
        expenses: [{ _id: 'e1', type: 'cleaning', isRecurring: true, startTerm: 2026010100, chargeOwnerWhenVacant: true }],
        units: [mkUnit('p1', [a, z])],
        ownerMonthlyExpenses: [
          { _id: 'a', expenseId: 'e1', propertyId: 'p1', term: 2026060100, amount: 30, source: 'vacant', payments: [] }
        ]
      }
    ];
    const keyA = ownerKeyOf(a);
    const keyZ = ownerKeyOf(z);
    const canonical = [keyA, keyZ].sort()[0];
    const stCanonical = buildOwnerStatement(buildings, canonical, []);
    const stOther = buildOwnerStatement(buildings, canonical === keyA ? keyZ : keyA, []);
    expect(stCanonical.charges).toHaveLength(1); // counted once on canonical
    expect(stOther.charges).toHaveLength(0); // NOT double-counted on the other
  });

  it('returns null owner + empty charges for an unknown ownerKey', () => {
    const buildings = [
      { _id: 'b1', name: 'B', expenses: [], units: [], ownerMonthlyExpenses: [] }
    ];
    const st = buildOwnerStatement(buildings, 'n:nobody|', []);
    expect(st.owner).toBeNull();
    expect(st.charges).toHaveLength(0);
    expect(st.totals.amount).toBe(0);
  });

  // ── R2 round-4-review: the statement is the SETTLEMENT document, so it must
  // drop a stale 'vacant'/'owner-resident' row whose unit is actually
  // tenant-occupied (the euro is the tenant's rent, not the owner's) — same
  // guard the breakdown + dashboard apply, via the injected occupiedKeys set.
  it('drops a vacant owner row when a TENANT occupies the unit for the term (no owner double-count)', () => {
    const owner = { name: 'A', taxId: '1' };
    const buildings = [
      {
        _id: 'b1',
        name: 'B',
        expenses: [
          {
            _id: 'e1',
            type: 'water_common',
            isRecurring: true,
            startTerm: 2026010100,
            chargeOwnerWhenVacant: true
          }
        ],
        units: [mkUnit('p1', [owner])],
        ownerMonthlyExpenses: [
          { _id: 'a', expenseId: 'e1', propertyId: 'p1', term: 2026060100, amount: 20, source: 'vacant', payments: [] }
        ]
      }
    ];
    const key = ownerKeyOf(owner);
    // No occupancy → row kept (genuinely vacant).
    expect(buildOwnerStatement(buildings, key, []).charges).toHaveLength(1);
    // Tenant occupies p1 in June → the same euro is the tenant's rent; drop it.
    const occ = new Set(['p1|2026060100']);
    const st = buildOwnerStatement(buildings, key, [], occ);
    expect(st.charges).toHaveLength(0);
    expect(st.totals.amount).toBe(0);
  });

  it('drops an owner-resident row (flag OFF) when the unit is no longer owner_occupied', () => {
    const owner = { name: 'A', taxId: '1' };
    const expense = {
      _id: 'e1',
      type: 'cleaning',
      isRecurring: true,
      startTerm: 2026010100,
      chargeOwnerWhenVacant: false // owner-resident is NOT flag-governed
    };
    const row = { _id: 'a', expenseId: 'e1', propertyId: 'p1', term: 2026060100, amount: 30, source: 'owner-resident', payments: [] };
    // unit STILL owner-occupied → kept.
    const occupied = [
      { _id: 'b1', name: 'B', expenses: [expense], units: [mkUnit('p1', [owner], { occupancyType: 'owner_occupied' })], ownerMonthlyExpenses: [row] }
    ];
    expect(buildOwnerStatement(occupied, ownerKeyOf(owner), []).charges).toHaveLength(1);
    // unit flipped to vacant TODAY (no longer owner_occupied) but NO tenant
    // occupies term 202606 → the historical owner-resident liability the owner
    // DID incur that month must STILL be kept (a current-day occupancy flip
    // must not retroactively erase a past term — round-4-review-2). Only a
    // TENANT occupying THAT term drops it (covered by the tenant-occupied test).
    const flipped = [
      { _id: 'b1', name: 'B', expenses: [expense], units: [mkUnit('p1', [owner], { occupancyType: 'vacant' })], ownerMonthlyExpenses: [row] }
    ];
    expect(buildOwnerStatement(flipped, ownerKeyOf(owner), []).charges).toHaveLength(1);
  });

  // Step-7 round-4: cancel→un-cancel (or chargeOwnerWhenVacant OFF→ON on a paid
  // vacant repair) leaves an inert source:'credit' {amount 0, paid X} beside a
  // re-opened liability {amount X, paid 0} for the SAME obligation. The statement
  // must NET them (€0 outstanding, settled) — not sum each row's own clamped
  // outstanding into a phantom X debt.
  it('nets a same-obligation credit + re-opened liability to €0 outstanding (no phantom debt)', () => {
    const owner = { name: 'A', taxId: '1' };
    const buildings = [
      {
        _id: 'b1',
        name: 'B',
        expenses: [],
        repairs: [{ _id: 'rep1', title: 'roof', chargeableTo: 'owners' }],
        units: [mkUnit('p1', [owner])],
        ownerMonthlyExpenses: [
          {
            _id: 'credit1',
            expenseId: 'rep1',
            term: 2026060100,
            amount: 0,
            source: 'credit',
            paid: true,
            payments: [{ amount: 100, date: '2026-06-01', type: 'cash' }]
          },
          {
            _id: 'liab1',
            expenseId: 'rep1',
            term: 2026060100,
            amount: 100,
            source: 'repair',
            paid: false,
            payments: []
          }
        ]
      }
    ];
    const st = buildOwnerStatement(buildings, ownerKeyOf(owner), []);
    expect(st.totals.paid).toBeCloseTo(100, 2);
    expect(st.totals.outstanding).toBeCloseTo(0, 2); // netted, NOT 100
  });

  // SCOPE GUARD: a credit must NOT mask a DIFFERENT obligation's debt. Same owner,
  // a paid credit on repair A and a genuinely-unpaid liability on repair B → B's
  // €50 must STILL show outstanding (the credit only offsets its own obligation).
  it('does NOT net a credit against a DIFFERENT obligation (cross-obligation debt survives)', () => {
    const owner = { name: 'A', taxId: '1' };
    const buildings = [
      {
        _id: 'b1',
        name: 'B',
        expenses: [],
        repairs: [
          { _id: 'repA', title: 'a', chargeableTo: 'owners' },
          { _id: 'repB', title: 'b', chargeableTo: 'owners' }
        ],
        units: [mkUnit('p1', [owner])],
        ownerMonthlyExpenses: [
          {
            _id: 'creditA',
            expenseId: 'repA',
            term: 2026060100,
            amount: 0,
            source: 'credit',
            paid: true,
            payments: [{ amount: 100, date: '2026-06-01', type: 'cash' }]
          },
          {
            _id: 'liabB',
            expenseId: 'repB',
            term: 2026060100,
            amount: 50,
            source: 'repair',
            paid: false,
            payments: []
          }
        ]
      }
    ];
    const st = buildOwnerStatement(buildings, ownerKeyOf(owner), []);
    expect(st.totals.paid).toBeCloseTo(100, 2);
    expect(st.totals.outstanding).toBeCloseTo(50, 2); // repB still owed, NOT masked
  });

  it('NEVER drops an owner row that carries a recorded payment, even when its expense is gone', () => {
    const owner = { name: 'A', taxId: '1' };
    // expense deleted (not in expenses[]), but the owner already PAID this row.
    const buildings = [
      {
        _id: 'b1',
        name: 'B',
        expenses: [],
        units: [mkUnit('p1', [owner])],
        ownerMonthlyExpenses: [
          { _id: 'a', expenseId: 'gone', propertyId: 'p1', term: 2026060100, amount: 30, source: 'vacant', payments: [{ amount: 30 }] }
        ]
      }
    ];
    const st = buildOwnerStatement(buildings, ownerKeyOf(owner), []);
    expect(st.charges).toHaveLength(1); // recorded money survives
    expect(st.totals.paid).toBe(30);
  });
});

describe('isOwnerExpenseRowStale — shared read-time staleness predicate', () => {
  const activeFlagOn = { isRecurring: true, startTerm: 2026010100, chargeOwnerWhenVacant: true };
  const activeFlagOff = { isRecurring: true, startTerm: 2026010100, chargeOwnerWhenVacant: false };
  // signature: (row, expense, isOccupied) — term-anchored, no current-occupancy arg.
  const row = (source, extra = {}) => ({ source, expenseId: 'e1', propertyId: 'p1', term: 2026060100, payments: [], ...extra });

  it('keeps a live vacant row (flag on, active, unoccupied)', () => {
    expect(isOwnerExpenseRowStale(row('vacant'), activeFlagOn, false)).toBe(false);
  });
  it('drops a vacant row whose expense is gone', () => {
    expect(isOwnerExpenseRowStale(row('vacant'), null, false)).toBe(true);
  });
  it('drops a vacant row when the flag is off', () => {
    expect(isOwnerExpenseRowStale(row('vacant'), activeFlagOff, false)).toBe(true);
  });
  it('drops a vacant row when a tenant occupies the unit FOR THE TERM', () => {
    expect(isOwnerExpenseRowStale(row('vacant'), activeFlagOn, true)).toBe(true);
  });
  it('drops a vacant row when the expense is inactive for the term', () => {
    const ended = { isRecurring: true, startTerm: 2026010100, endTerm: 2026030100, chargeOwnerWhenVacant: true };
    expect(isOwnerExpenseRowStale(row('vacant'), ended, false)).toBe(true);
  });
  it('keeps an owner-resident row (flag OFF) when the term is unoccupied — NOT flag-governed', () => {
    expect(isOwnerExpenseRowStale(row('owner-resident'), activeFlagOff, false)).toBe(false);
  });
  it('drops an owner-resident row when a tenant occupies the unit FOR THE TERM (double-count)', () => {
    expect(isOwnerExpenseRowStale(row('owner-resident'), activeFlagOff, true)).toBe(true);
  });
  it('keeps a historical owner-resident row regardless of current occupancy (term-anchored, no current-state drop)', () => {
    // No 4th occupancy arg exists; a past owner-resident liability is never
    // erased by today's state. Only a same-term tenant or inactive expense drops it.
    expect(isOwnerExpenseRowStale(row('owner-resident'), activeFlagOff, false)).toBe(false);
  });
  it('NEVER drops a row carrying recorded payments, even if expense is gone / flag off / tenant-occupied', () => {
    const paid = { payments: [{ amount: 10 }] };
    expect(isOwnerExpenseRowStale(row('vacant', paid), null, true)).toBe(false);
    expect(isOwnerExpenseRowStale(row('owner-resident', paid), activeFlagOff, true)).toBe(false);
  });
  it('NEVER drops repair/expense/owner-fixed rows (not re-derived from a building expense)', () => {
    for (const s of ['repair', 'repair-vacant', 'expense', 'owner-fixed']) {
      expect(isOwnerExpenseRowStale(row(s), null, true)).toBe(false);
    }
  });
});

describe('occupiedPropertyTermKeys — shared occupancy key-set', () => {
  it('keys a unit occupied for a covered term, excludes a terminated/out-of-window term', () => {
    const tenants = [
      {
        beginDate: '2026-01-01',
        terminationDate: '2026-06-30',
        properties: [{ propertyId: 'p1', entryDate: '2026-01-01' }]
      }
    ];
    const keys = occupiedPropertyTermKeys(tenants, [2026060100, 2026080100]);
    expect(keys.has('p1|2026060100')).toBe(true); // within lease
    expect(keys.has('p1|2026080100')).toBe(false); // after terminationDate
  });

  // Step-7 (delete-payment preservation): a 'credit' row (amount=0 with
  // preserved καταβολές from a deleted expense) MUST surface on the statement
  // PDF as paid — the statement and the ledger must agree on owner paid amount.
  it("surfaces a delete-time 'credit' row (amount 0, payments>0) as preserved paid", () => {
    const alpha = { name: 'ALPHA', taxId: '1' };
    const buildings = [
      {
        _id: 'b1',
        name: 'B1',
        expenses: [],
        repairs: [],
        units: [mkUnit('p1', [alpha])],
        ownerMonthlyExpenses: [
          {
            _id: 'credit1',
            expenseId: 'gone',
            term: 2026060100,
            amount: 0,
            source: 'credit',
            paid: true,
            payments: [{ amount: 40, date: '2026-06-01', type: 'cash' }]
          }
        ]
      }
    ];
    const st = buildOwnerStatement(buildings, ownerKeyOf(alpha), []);
    const credit = st.charges.find((c) => c.source === 'credit');
    expect(credit).toBeTruthy(); // not dropped by the amount>0 skip
    expect(credit.paidAmount).toBeCloseTo(40, 2);
    expect(st.totals.paid).toBeCloseTo(40, 2); // statement agrees with ledger
    expect(st.totals.outstanding).toBeCloseTo(0, 2); // clamped, not negative
  });
});
