import { _computePaidByBucket } from '../../managers/dashboardmanager.js';

// Wave-26 round-3r: this function is now an aggregator over
// payments[].allocation only. Auto-spread fallback was moved to
// rentmanager (persisted on save) and the legacy migration script.
// Payments without an allocation contribute NOTHING to the buckets —
// the round-3r migration backfills them all so this never happens
// post-deploy.
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

  test('payments without allocation contribute zero to all buckets', () => {
    // Round-3r contract: every payment must carry an explicit
    // allocation by the time the dashboard reads it. Migration script
    // backfills legacy payments.
    const rent = makeRent({
      preTaxAmount: 500,
      payments: [{ amount: 500 }]
    });
    expect(_computePaidByBucket(rent)).toEqual({});
  });

  test('explicit allocation routes amount to the requested category', () => {
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
    // expenses owed = charges (100) + cleaning (100) = 200. Allocation
    // of 200 fully covers both, prorated 100/100. Repair stays at 0
    // (it's NOT in the expenses bucket).
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

  test('multi-allocation entries each go to their respective bucket', () => {
    // Round-3r typical case: auto-spread produced rent + insurance,
    // express-pay produced rent + previousBalance.
    const rent = makeRent({
      preTaxAmount: 200,
      buildingCharges: [{ type: 'insurance', amount: 67 }],
      payments: [
        {
          amount: 150,
          allocation: [
            { category: 'rent', amount: 83 },
            { category: 'expenses', amount: 67 }
          ]
        }
      ]
    });
    // expenses (67) prorates onto charges (0) + insurance (67) → all
    // 67 lands on insurance because charges has zero owed weight.
    const out = _computePaidByBucket(rent);
    expect(out.rent).toBeCloseTo(83, 1);
    expect(out['building:insurance']).toBeCloseTo(67, 1);
    expect(out.charges).toBeUndefined();
  });

  test('multiple payments accumulate per-bucket from their allocations', () => {
    const rent = makeRent({
      preTaxAmount: 500,
      payments: [
        { amount: 200, allocation: [{ category: 'rent', amount: 200 }] },
        { amount: 150, allocation: [{ category: 'rent', amount: 150 }] }
      ]
    });
    expect(_computePaidByBucket(rent)).toEqual({ rent: 350 });
  });

  test('zero-amount allocation entries are ignored', () => {
    const rent = makeRent({
      preTaxAmount: 500,
      payments: [
        {
          amount: 100,
          allocation: [
            { category: 'rent', amount: 100 },
            { category: 'expenses', amount: 0 }
          ]
        }
      ]
    });
    expect(_computePaidByBucket(rent)).toEqual({ rent: 100 });
  });

  test('vat / previousBalance / extracharge allocations consume amount but produce no bucket entry', () => {
    // Pie chart doesn't visualise these categories. They are silently
    // skipped during bucket aggregation.
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

  test('expenses allocation with no expense buckets owed leaves no output', () => {
    // Edge case: caller allocated to expenses but the rent has
    // neither charges[] nor non-repair buildingCharges[]. _prorate
    // returns silently because total weight is 0; bucket map stays
    // empty.
    const rent = makeRent({
      preTaxAmount: 500,
      payments: [
        {
          amount: 50,
          allocation: [{ category: 'expenses', amount: 50 }]
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
          allocation: [
            { category: 'rent', amount: 99.99 },
            { category: 'expenses', amount: 0.02 }
          ]
        }
      ]
    });
    const out = _computePaidByBucket(rent);
    Object.values(out).forEach((v) => {
      expect(Math.round(v * 100) / 100).toBe(v);
    });
  });
});
