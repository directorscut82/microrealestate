import { _computePaidByBucket } from '../../managers/dashboardmanager.js';

// Test fixtures: build a "rent" record matching the shape dashboardmanager
// reads from MongoDB. Only the fields _computePaidByBucket actually touches
// (total.preTaxAmount, charges[], buildingCharges[], payments[]).
function makeRent({
  preTaxAmount = 0,
  charges = [],
  buildingCharges = [],
  payments = []
} = {}) {
  return {
    total: { preTaxAmount },
    charges,
    buildingCharges,
    payments
  };
}

describe('_computePaidByBucket', () => {
  test('returns empty buckets when no payments exist', () => {
    const rent = makeRent({ preTaxAmount: 500 });
    expect(_computePaidByBucket(rent)).toEqual({});
  });

  test('auto-spread: payment fully covers rent only when no other buckets', () => {
    const rent = makeRent({
      preTaxAmount: 500,
      payments: [{ amount: 500 }]
    });
    expect(_computePaidByBucket(rent)).toEqual({ rent: 500 });
  });

  test('auto-spread fills repair-buildings BEFORE rent (oldest-debt-first order)', () => {
    const rent = makeRent({
      preTaxAmount: 500,
      buildingCharges: [{ type: 'repair', amount: 200 }],
      payments: [{ amount: 250 }]
    });
    // 250 should fill the 200 repair first, then 50 spills onto rent.
    expect(_computePaidByBucket(rent)).toEqual({
      'building:repair': 200,
      rent: 50
    });
  });

  test('explicit allocation routes amount to the requested category bucket', () => {
    const rent = makeRent({
      preTaxAmount: 500,
      charges: [{ amount: 100 }],
      payments: [
        {
          amount: 100,
          allocation: [{ category: 'rent', amount: 100 }]
        }
      ]
    });
    // Allocation says 'rent', so rent gets 100 even though charges is owed.
    expect(_computePaidByBucket(rent)).toEqual({ rent: 100 });
  });

  test('expenses allocation prorates across charges and non-repair building types', () => {
    const rent = makeRent({
      preTaxAmount: 500,
      charges: [{ amount: 100 }],
      buildingCharges: [
        { type: 'cleaning', amount: 100 },
        { type: 'repair', amount: 50 }
      ],
      payments: [
        {
          amount: 200,
          allocation: [{ category: 'expenses', amount: 200 }]
        }
      ]
    });
    // Expenses bucket = charges (100) + non-repair building (cleaning=100) = 200 owed.
    // Allocation of 200 fully covers both, prorated 100/100.
    const out = _computePaidByBucket(rent);
    expect(out.charges).toBeCloseTo(100, 1);
    expect(out['building:cleaning']).toBeCloseTo(100, 1);
    expect(out['building:repair']).toBeUndefined();
  });

  test('repairs allocation only touches repair buildings, never expenses', () => {
    const rent = makeRent({
      preTaxAmount: 500,
      charges: [{ amount: 100 }],
      buildingCharges: [
        { type: 'cleaning', amount: 100 },
        { type: 'repair', amount: 75 }
      ],
      payments: [
        {
          amount: 75,
          allocation: [{ category: 'repairs', amount: 75 }]
        }
      ]
    });
    expect(_computePaidByBucket(rent)).toEqual({
      'building:repair': 75
    });
  });

  test('partial allocation residual auto-spreads on remaining buckets', () => {
    const rent = makeRent({
      preTaxAmount: 500,
      buildingCharges: [{ type: 'repair', amount: 200 }],
      payments: [
        {
          amount: 300,
          // Caller allocated only 100 of the 300 — residual 200 must spread.
          allocation: [{ category: 'rent', amount: 100 }]
        }
      ]
    });
    const out = _computePaidByBucket(rent);
    // Explicit alloc lands 100 in rent. Residual 200 auto-spreads:
    // repair (oldest-debt) is owed 200, fills first and exhausts the
    // residual. Rent stays at 100.
    expect(out.rent).toBeCloseTo(100, 1);
    expect(out['building:repair']).toBeCloseTo(200, 1);
  });

  test('multiple payments accumulate per-bucket', () => {
    const rent = makeRent({
      preTaxAmount: 500,
      payments: [{ amount: 200 }, { amount: 150 }]
    });
    expect(_computePaidByBucket(rent)).toEqual({ rent: 350 });
  });

  test('overpayment: amount exceeding all owed leaves residual silently dropped', () => {
    const rent = makeRent({
      preTaxAmount: 100,
      payments: [{ amount: 500 }]
    });
    // Rent caps at owed (100). The 400 overpayment has no bucket — dropped.
    expect(_computePaidByBucket(rent)).toEqual({ rent: 100 });
  });

  test('zero/negative payment amounts are skipped', () => {
    const rent = makeRent({
      preTaxAmount: 500,
      payments: [{ amount: 0 }, { amount: -50 }, { amount: 100 }]
    });
    expect(_computePaidByBucket(rent)).toEqual({ rent: 100 });
  });

  test('vat / previousBalance / extracharge allocations consume amount but no bucket', () => {
    // These categories aren't visualised on the dashboard pie. The
    // allocation is honored (the amount is "used") but no bucket grows.
    const rent = makeRent({
      preTaxAmount: 500,
      payments: [
        {
          amount: 100,
          allocation: [{ category: 'vat', amount: 100 }]
        }
      ]
    });
    expect(_computePaidByBucket(rent)).toEqual({});
  });

  test('rounds bucket values to 2 decimals (no FP drift in output)', () => {
    const rent = makeRent({
      preTaxAmount: 99.99,
      charges: [{ amount: 0.02 }],
      payments: [
        {
          amount: 100.01,
          allocation: [{ category: 'expenses', amount: 0.02 }]
        }
      ]
    });
    const out = _computePaidByBucket(rent);
    Object.values(out).forEach((v) => {
      // Detect raw floats like 0.020000000000000018; rounded values
      // multiplied by 100 should land on integers.
      expect(Math.round(v * 100) / 100).toBe(v);
    });
  });
});
