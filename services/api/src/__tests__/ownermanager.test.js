import {
  ownerKeyOf,
  recomputeOwnerExpensePaid,
  carryOwnerPayments,
  applyCarriedSettlement,
  autoSpreadOwnerPayment,
  _aggregateOwners,
  _serializeOwnerSummary
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

// ───────────────────────────────────────────────────────────────────────────
// Step-7 (Batch 1) regression: the payments-driven settlements GRID must
// reconcile EXACTLY with the header totalPaid, and same-name co-owners must
// each get their own charge/payments. These guard the 7 money bugs the
// adversarial review found in the multi-owner slice path.
// ───────────────────────────────────────────────────────────────────────────
describe('owner settlements grid reconciles with header (Step-7 batch1)', () => {
  // minimal building: one repair-owner-portion row (propertyId null →
  // building-wide), co-owned, paid in 3 awkward installments.
  const mkBuilding = (owners, payments) => ({
    _id: 'b1',
    name: 'B1',
    units: [{ propertyId: 'p1', atakNumber: 'AK1', floor: 1, owners }],
    expenses: [],
    repairs: [{ _id: 'r1' }],
    ownerMonthlyExpenses: [
      {
        _id: 'ome1',
        expenseId: 'r1',
        term: 2026060100,
        amount: 100,
        source: 'repair',
        propertyId: null,
        payments
      }
    ]
  });

  const gridSum = (summary) =>
    Math.round(
      (summary.settlements || [])
        .filter(Boolean)
        .flat()
        .reduce((s, e) => s + (Number(e.amount) || 0), 0) * 100
    ) / 100;

  it('50/50 co-owners, installments 33.33/33.33/33.34: each grid Σ == header totalPaid, no cent drift', () => {
    const owners = [
      { name: 'ALPHA', taxId: '111', percentage: 50 },
      { name: 'BETA', taxId: '222', percentage: 50 }
    ];
    const pays = [
      { amount: 33.33, date: '2026-06-02', type: 'cash' },
      { amount: 33.33, date: '2026-06-03', type: 'cash' },
      { amount: 33.34, date: '2026-06-04', type: 'cash' }
    ];
    const map = _aggregateOwners([mkBuilding(owners, pays)], new Set());
    for (const key of map.keys()) {
      const summary = _serializeOwnerSummary(map.get(key));
      // the grid (Σ per-payment sliced amounts) equals the header totalPaid
      expect(gridSum(summary)).toBeCloseTo(summary.totalPaid, 2);
      // and never exceeds this owner's sliced charge amount
      expect(summary.totalPaid).toBeLessThanOrEqual(summary.totalAmount + 0.005);
    }
  });

  it('same-name co-owners (distinct taxId): each owner gets their OWN charge + payments (no drop/double)', () => {
    const owners = [
      { name: 'ΠΑΠΑΔΟΠΟΥΛΟΣ', taxId: '111', percentage: 50 },
      { name: 'ΠΑΠΑΔΟΠΟΥΛΟΣ', taxId: '222', percentage: 50 }
    ];
    const pays = [{ amount: 100, date: '2026-06-02', type: 'transfer' }];
    const map = _aggregateOwners([mkBuilding(owners, pays)], new Set());
    const k1 = ownerKeyOf(owners[0]);
    const k2 = ownerKeyOf(owners[1]);
    expect(k1).not.toBe(k2);
    // both owners exist, each with a €50 charge and €50 paid — not one with 100
    expect(map.get(k1)).toBeTruthy();
    expect(map.get(k2)).toBeTruthy();
    const s1 = _serializeOwnerSummary(map.get(k1));
    const s2 = _serializeOwnerSummary(map.get(k2));
    expect(s1.totalAmount).toBeCloseTo(50, 2);
    expect(s2.totalAmount).toBeCloseTo(50, 2);
    expect(s1.totalPaid).toBeCloseTo(50, 2);
    expect(s2.totalPaid).toBeCloseTo(50, 2);
    expect(gridSum(s1)).toBeCloseTo(50, 2);
    expect(gridSum(s2)).toBeCloseTo(50, 2);
  });

  // ΔΟΚΙΜΗ ΒΗΤΑ owner-tracked bug, fixed at the WRITER (per-unit
  // materialisation). The owner amount is now stored as PER-UNIT source:'expense'
  // rows (propertyId set), each carrying that unit's allocated share. A unit
  // owned 50% bills the owner only €X·50%; a unit owned 100% bills the full
  // share. The owner's ledger total = Σ of her per-unit shares — NOT the full
  // building amount dumped on her. (Was: one building-wide lump → full €100.)
  it('per-unit owner-expense rows bill each unit owner their declared % share (ΒΗΤΑ fix)', () => {
    const beta = (pct) => ({ name: 'ΔΟΚΙΜΗ ΒΗΤΑ', taxId: '111', percentage: pct });
    // €100 owner-water, equal across 2 units = €50/unit. Unit A: Beta 50%
    // (co-owner absent) → she owes €25. Unit B: Beta 100% → she owes €50.
    // Her ledger total = €75, NOT €100.
    const building = {
      _id: 'b1',
      name: 'AG ODOS EPSILON',
      units: [
        { propertyId: 'pA', atakNumber: 'AKA', floor: 0, owners: [beta(50)] },
        { propertyId: 'pB', atakNumber: 'AKB', floor: 1, owners: [beta(100)] }
      ],
      expenses: [{ _id: 'water', type: 'water_common' }],
      repairs: [],
      ownerMonthlyExpenses: [
        { _id: 'a', expenseId: 'water', term: 2026060100, amount: 50, source: 'expense', propertyId: 'pA', payments: [] },
        { _id: 'b', expenseId: 'water', term: 2026060100, amount: 50, source: 'expense', propertyId: 'pB', payments: [] }
      ]
    };
    const map = _aggregateOwners([building], new Set());
    const s = _serializeOwnerSummary(map.get(ownerKeyOf(beta(50))));
    // €25 (50% of unit A's €50) + €50 (100% of unit B's €50) = €75 — her share.
    expect(s.totalAmount).toBeCloseTo(75, 2);
    expect(s.totalOutstanding).toBeCloseTo(75, 2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Delete-time owner-payment preservation: when an expense/repair is hard-
// deleted, an owner row that carried recorded καταβολές must NOT vanish — it
// becomes a zero-amount 'credit' row (payments kept) and MUST still surface on
// the owner ledger as preserved money (outstanding clamped to 0).
// ───────────────────────────────────────────────────────────────────────────
describe('deleted-expense owner payment survives as a credit row', () => {
  it('a source:credit row (amount 0, payments>0) is aggregated, not skipped, and shows as credit', () => {
    const building = {
      _id: 'b1',
      name: 'B1',
      units: [
        { propertyId: 'p1', atakNumber: 'AK1', floor: 1,
          owners: [{ name: 'ALPHA', taxId: '1', percentage: 100 }] }
      ],
      expenses: [],
      repairs: [],
      ownerMonthlyExpenses: [
        {
          _id: 'c1', expenseId: 'gone-expense', term: 2026060100,
          amount: 0, source: 'credit', paid: true,
          payments: [{ amount: 40, date: '2026-06-01', type: 'cash' }]
        }
      ]
    };
    const map = _aggregateOwners([building], new Set());
    const agg = map.get(ownerKeyOf(building.units[0].owners[0]));
    expect(agg).toBeTruthy();
    // the €40 preserved payment surfaces as paid; owed/outstanding are 0.
    expect(agg.totalPaid).toBeCloseTo(40, 2);
    expect(agg.totalAmount).toBeCloseTo(0, 2);
    expect(agg.totalOutstanding).toBeCloseTo(0, 2); // clamped, never negative
    const credit = agg.charges.find((c) => c.source === 'credit');
    expect(credit).toBeTruthy();
    expect(credit.paidAmount).toBeCloseTo(40, 2);
    expect(credit.outstanding).toBe(0);
  });

  // Step-7 round-4: cancel→un-cancel (or chargeOwnerWhenVacant OFF→ON on a paid
  // vacant repair) leaves an inert credit {amount 0, paid X} beside a re-opened
  // liability {amount X, paid 0} for the SAME obligation. The ledger must NET them
  // to €0 totalOutstanding — else the owner shows a phantom debt AND it leaks into
  // the collectible owed-lines (double-charge path).
  it('nets a same-obligation credit + re-opened liability to €0 totalOutstanding (no phantom debt)', () => {
    const building = {
      _id: 'b1',
      name: 'B1',
      units: [
        { propertyId: 'p1', atakNumber: 'AK1', floor: 1,
          owners: [{ name: 'ALPHA', taxId: '1', percentage: 100 }] }
      ],
      expenses: [],
      repairs: [{ _id: 'rep1', title: 'roof', chargeableTo: 'owners' }],
      ownerMonthlyExpenses: [
        {
          _id: 'c1', expenseId: 'rep1', term: 2026060100,
          amount: 0, source: 'credit', paid: true,
          payments: [{ amount: 100, date: '2026-06-01', type: 'cash' }]
        },
        {
          _id: 'l1', expenseId: 'rep1', term: 2026060100,
          amount: 100, source: 'repair', paid: false, payments: []
        }
      ]
    };
    const map = _aggregateOwners([building], new Set());
    const agg = map.get(ownerKeyOf(building.units[0].owners[0]));
    expect(agg).toBeTruthy();
    expect(agg.totalPaid).toBeCloseTo(100, 2);
    expect(agg.totalOutstanding).toBeCloseTo(0, 2); // netted, NOT 100 phantom
  });

  // Step-7 round-5: a CO-OWNED obligation with non-terminating shares (33.33%/
  // 66.67%) — credit + re-opened liability — must net to EXACTLY €0 per owner.
  // The credit's preserved payment is split by the same carrier-corrected
  // ownerSlicesOf euros as the liability (was 1-decimal % → a €0.03 phantom that
  // _ownerOwedLines surfaced as a collectible debt on a settled obligation).
  it('co-owned credit + liability (33.33/66.67) nets to €0 — no sub-cent phantom', () => {
    const owners = [
      { name: 'ALFA', taxId: '1', percentage: 33.33 },
      { name: 'BETA', taxId: '2', percentage: 66.67 }
    ];
    const building = {
      _id: 'b1',
      name: 'B1',
      units: [{ propertyId: 'p1', atakNumber: 'AK1', floor: 1, owners }],
      expenses: [],
      repairs: [{ _id: 'rep1', title: 'roof', chargeableTo: 'owners' }],
      ownerMonthlyExpenses: [
        {
          _id: 'c1', expenseId: 'rep1', term: 2026060100, propertyId: 'p1',
          amount: 0, source: 'credit', paid: true,
          payments: [{ amount: 100, date: '2026-06-01', type: 'cash' }]
        },
        {
          _id: 'l1', expenseId: 'rep1', term: 2026060100, propertyId: 'p1',
          amount: 100, source: 'repair-vacant', paid: false, payments: []
        }
      ]
    };
    const map = _aggregateOwners([building], new Set());
    for (const o of owners) {
      const agg = map.get(ownerKeyOf(o));
      expect(agg).toBeTruthy();
      // each co-owner's obligation is fully settled — no sub-cent phantom owed.
      expect(agg.totalOutstanding).toBeCloseTo(0, 2);
    }
  });

  // SCOPE GUARD: a credit must NOT mask a DIFFERENT obligation's debt.
  it('does NOT net a credit against a DIFFERENT obligation (cross-obligation debt survives)', () => {
    const building = {
      _id: 'b1',
      name: 'B1',
      units: [
        { propertyId: 'p1', atakNumber: 'AK1', floor: 1,
          owners: [{ name: 'ALPHA', taxId: '1', percentage: 100 }] }
      ],
      expenses: [],
      repairs: [
        { _id: 'repA', title: 'a', chargeableTo: 'owners' },
        { _id: 'repB', title: 'b', chargeableTo: 'owners' }
      ],
      ownerMonthlyExpenses: [
        {
          _id: 'cA', expenseId: 'repA', term: 2026060100,
          amount: 0, source: 'credit', paid: true,
          payments: [{ amount: 100, date: '2026-06-01', type: 'cash' }]
        },
        {
          _id: 'lB', expenseId: 'repB', term: 2026060100,
          amount: 50, source: 'repair', paid: false, payments: []
        }
      ]
    };
    const map = _aggregateOwners([building], new Set());
    const agg = map.get(ownerKeyOf(building.units[0].owners[0]));
    expect(agg.totalPaid).toBeCloseTo(100, 2);
    expect(agg.totalOutstanding).toBeCloseTo(50, 2); // repB still owed, NOT masked
  });
});

// C2 (audit 2026-06-21): a building-wide co-owned charge's payments[] is shared.
// A payment is attributed to the PAYING owner via payment.ownerKey; _aggregateOwners
// must credit ONLY that owner — never re-split one owner's καταβολή to a co-owner.
describe('C2 — co-owner payment attribution (no cross-owner credit)', () => {
  const ALPHA = { name: 'ALPHA', taxId: '1', percentage: 50 };
  const BETA = { name: 'BETA', taxId: '2', percentage: 50 };
  // Building-wide owner charge (propertyId null) co-owned 50/50; €100 owner-portion.
  const mk = (payments) => ({
    _id: 'b1',
    name: 'B1',
    units: [
      { propertyId: 'p1', atakNumber: 'AK1', floor: 1, owners: [{ ...ALPHA }] },
      { propertyId: 'p2', atakNumber: 'AK2', floor: 1, owners: [{ ...BETA }] }
    ],
    expenses: [],
    repairs: [{ _id: 'rep1', title: 'roof', chargeableTo: 'owners' }],
    ownerMonthlyExpenses: [
      {
        _id: 'r1', expenseId: 'rep1', term: 2026060100, amount: 100,
        source: 'repair', paid: false, payments
      }
    ]
  });

  it('ALPHA pays their €50 slice (tagged ownerKey) → ALPHA settled, BETA untouched', () => {
    const map = _aggregateOwners(
      [mk([{ amount: 50, date: '2026-06-01', type: 'cash', ownerKey: ownerKeyOf(ALPHA) }])],
      new Set()
    );
    const a = map.get(ownerKeyOf(ALPHA));
    const b = map.get(ownerKeyOf(BETA));
    // ALPHA's €50 lands fully on ALPHA's €50 slice → settled.
    expect(a.totalPaid).toBeCloseTo(50, 2);
    expect(a.totalOutstanding).toBeCloseTo(0, 2);
    // BETA gets NONE of ALPHA's money — still owes their full €50.
    expect(b.totalPaid).toBeCloseTo(0, 2);
    expect(b.totalOutstanding).toBeCloseTo(50, 2);
  });

  it('legacy UNTAGGED payment falls back to the proportional split (no regression)', () => {
    const map = _aggregateOwners(
      [mk([{ amount: 50, date: '2026-06-01', type: 'cash' }])], // no ownerKey
      new Set()
    );
    const a = map.get(ownerKeyOf(ALPHA));
    const b = map.get(ownerKeyOf(BETA));
    // Untagged €50 splits 50/50 (the documented legacy behavior).
    expect(a.totalPaid).toBeCloseTo(25, 2);
    expect(b.totalPaid).toBeCloseTo(25, 2);
  });

  it('both owners pay their own tagged slice → both settled, no double/mis-credit', () => {
    const map = _aggregateOwners(
      [mk([
        { amount: 50, date: '2026-06-01', type: 'cash', ownerKey: ownerKeyOf(ALPHA) },
        { amount: 50, date: '2026-06-02', type: 'cash', ownerKey: ownerKeyOf(BETA) }
      ])],
      new Set()
    );
    expect(map.get(ownerKeyOf(ALPHA)).totalOutstanding).toBeCloseTo(0, 2);
    expect(map.get(ownerKeyOf(BETA)).totalOutstanding).toBeCloseTo(0, 2);
  });

  // C2-1 (Step-7 self-bug): carryOwnerPayments MUST carry ownerKey, else the
  // first recompute (saveMonthlyStatement / _recomputeVacantOwnerCharges strips
  // + rebuilds the row via carryOwnerPayments) drops the tag → _aggregateOwners
  // re-splits the payment proportionally → one owner's debt re-opens and a
  // co-owner is credited money they never paid. This guards attribution
  // SURVIVAL across the carry round-trip, not just a freshly-tagged row.
  it('ownerKey survives carryOwnerPayments (no attribution loss on recompute)', () => {
    const carried = carryOwnerPayments({
      payments: [
        { amount: 50, date: '2026-06-01', type: 'cash', ownerKey: ownerKeyOf(ALPHA) }
      ],
      paid: false,
      amount: 100
    });
    expect(carried.payments[0].ownerKey).toBe(ownerKeyOf(ALPHA));
  });

  it('attribution HOLDS after a carry round-trip (ALPHA stays settled, BETA not credited)', () => {
    // Simulate a recompute: strip the row, carry payments via carryOwnerPayments,
    // rebuild the row with the carried payments, re-aggregate.
    const carried = carryOwnerPayments({
      payments: [
        { amount: 50, date: '2026-06-01', type: 'cash', ownerKey: ownerKeyOf(ALPHA) }
      ],
      paid: false,
      amount: 100
    });
    const map = _aggregateOwners([mk(carried.payments)], new Set());
    const a = map.get(ownerKeyOf(ALPHA));
    const b = map.get(ownerKeyOf(BETA));
    // Pre-fix, this re-split 25/25 and re-opened ALPHA's debt to €25.
    expect(a.totalPaid).toBeCloseTo(50, 2);
    expect(a.totalOutstanding).toBeCloseTo(0, 2);
    expect(b.totalPaid).toBeCloseTo(0, 2);
    expect(b.totalOutstanding).toBeCloseTo(50, 2);
  });

  // C2-1 round-2 (Step-7): a tagged ownerKey that no longer maps to a current
  // owner slice (payer renamed / ΑΦΜ-corrected / departed) must NOT zero the
  // payment. useTaggedPaidForSlices degrades to the lossless proportional split.
  // INVARIANT: Σ totalPaid across owners === paidAmount, ALWAYS — never drop a euro.
  it('payer ΑΦΜ-corrected after paying → money conserved (degrades to proportional, not zeroed)', () => {
    // ALPHA paid €50 tagged with their OLD ownerKey, then taxId corrected.
    const ALPHA_OLD = { name: 'ALPHA', taxId: '1', percentage: 50 };
    const oldKey = ownerKeyOf(ALPHA_OLD); // 'n:alpha|1'
    // Building now has ALPHA with the corrected taxId '999' (key 'n:alpha|999').
    const building = {
      _id: 'b1',
      name: 'B1',
      units: [
        { propertyId: 'p1', atakNumber: 'AK1', floor: 1, owners: [{ name: 'ALPHA', taxId: '999', percentage: 50 }] },
        { propertyId: 'p2', atakNumber: 'AK2', floor: 1, owners: [{ ...BETA }] }
      ],
      expenses: [],
      repairs: [{ _id: 'rep1', title: 'roof', chargeableTo: 'owners' }],
      ownerMonthlyExpenses: [
        {
          _id: 'r1', expenseId: 'rep1', term: 2026060100, amount: 100,
          source: 'repair', paid: false,
          payments: [{ amount: 50, date: '2026-06-01', type: 'cash', ownerKey: oldKey }]
        }
      ]
    };
    const map = _aggregateOwners([building], new Set());
    const totalPaid = Array.from(map.values()).reduce((s, a) => s + a.totalPaid, 0);
    // Pre-fix the €50 vanished (totalPaid===0). The guard conserves it.
    expect(totalPaid).toBeCloseTo(50, 2);
  });

  it('payer DEPARTED the building after paying → money conserved on surviving owners', () => {
    // GAMMA paid €50 then left; building now co-owned BETA/DELTA 50/50.
    const GAMMA = { name: 'GAMMA', taxId: '7', percentage: 50 };
    const DELTA = { name: 'DELTA', taxId: '8', percentage: 50 };
    const building = {
      _id: 'b1',
      name: 'B1',
      units: [
        { propertyId: 'p1', atakNumber: 'AK1', floor: 1, owners: [{ ...BETA }] },
        { propertyId: 'p2', atakNumber: 'AK2', floor: 1, owners: [{ ...DELTA }] }
      ],
      expenses: [],
      repairs: [{ _id: 'rep1', title: 'roof', chargeableTo: 'owners' }],
      ownerMonthlyExpenses: [
        {
          _id: 'r1', expenseId: 'rep1', term: 2026060100, amount: 100,
          source: 'repair', paid: false,
          payments: [{ amount: 50, date: '2026-06-01', type: 'cash', ownerKey: ownerKeyOf(GAMMA) }]
        }
      ]
    };
    const map = _aggregateOwners([building], new Set());
    const totalPaid = Array.from(map.values()).reduce((s, a) => s + a.totalPaid, 0);
    // The departed owner's €50 must not vanish — proportional fallback keeps it.
    expect(totalPaid).toBeCloseTo(50, 2);
  });
});
