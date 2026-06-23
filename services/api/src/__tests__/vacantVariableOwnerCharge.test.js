/* eslint-env node, jest */
// Regression for the owner-tab-under-reports-vacant-variable-expense bug
// (Step-7, June 2026). A κυμαινόμενο (variable) building expense — Ρεύμα/Νερό,
// expense.amount === 0, the real per-unit figure entered per-month into
// unit.monthlyCharges — has its vacant-unit share billed in the breakdown but,
// before this fix, NEVER written to ownerMonthlyExpenses. So the owner tab
// (which reads ONLY ownerMonthlyExpenses) and the dashboard under-reported
// (live symptom: owner ΔΟΚΙΜΗ ΒΗΤΑ showed 0,21 € but owed ~48,81 €).
//
// _recomputeVacantOwnerCharges must now materialise that variable share from
// unit.monthlyCharges (the fix), AND computeOwnerEksodaByMonth must count it
// exactly once (no double-count against its own live gap-fill, which excludes
// variable expenses by the complementary predicate).
//
// type: module → use jest.unstable_mockModule + dynamic import.
import { jest } from '@jest/globals';

let TENANTS = []; // empty → every unit vacant (drives _occupiedPropertyIdsForTerm)
let _recomputeVacantOwnerCharges;
let computeOwnerEksodaByMonth;

beforeAll(async () => {
  class ServiceError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
  const OwnerStatement = await import(
    '../../../common/src/utils/ownerstatement.ts'
  );
  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: {
      Tenant: { find: () => ({ lean: async () => TENANTS }) },
      // recomputeVacantOwnerForProperties (not used here) + computeOwnerEksoda
      // never query Building in these direct-call cases.
      Building: { find: () => ({ lean: async () => [] }) }
    },
    logger: { warn() {}, info() {}, error() {} },
    ServiceError,
    OwnerStatement
  }));
  jest.unstable_mockModule('../managers/occupantmanager.js', () => ({
    _attachTenantGroupsToBuildings: async (_realmId, buildings) => {
      buildings.forEach((b) => (b._tenantGroups = []));
    }
  }));
  ({ _recomputeVacantOwnerCharges, computeOwnerEksodaByMonth } = await import(
    '../managers/buildingmanager.js'
  ));
});

// Mongoose-DocumentArray-like shim (pull + push), as the manager mutates
// building.ownerMonthlyExpenses in place.
function omeArray(initial = []) {
  const arr = [...initial];
  arr.pull = function (id) {
    const i = this.findIndex((e) => String(e._id) === String(id));
    if (i >= 0) this.splice(i, 1);
  };
  return arr;
}

const TERM = 2026060100; // June 2026

// Two units, both vacant, one variable expense (Ρεύμα, amount 0,
// chargeOwnerWhenVacant ON) with each unit's per-month share stored in
// monthlyCharges (4,86 € each). Mirrors the live ΑΓ.ΟΔΟΣ ΕΨΙΛΟΝ shape.
function makeBuilding() {
  const expenseId = 'exp-reuma';
  return {
    _id: 'b1',
    name: 'ΑΓ. ΟΔΟΣ ΕΨΙΛΟΝ 28',
    toObject() {
      return JSON.parse(JSON.stringify(this));
    },
    expenses: [
      {
        _id: expenseId,
        name: 'Ρεύμα',
        type: 'electricity_common',
        amount: 0, // VARIABLE
        allocationMethod: 'equal',
        isRecurring: true,
        startTerm: 2026010100,
        chargeOwnerWhenVacant: true
      }
    ],
    repairs: [],
    units: [
      {
        propertyId: 'p1',
        name: 'Υπόγειο',
        occupancyType: 'vacant',
        owners: [{ name: 'ΔΟΚΙΜΗ ΒΗΤΑ', taxId: '148152811', percentage: 100 }],
        monthlyCharges: [
          { term: TERM, expenseId, amount: 4.86, inputAmount: 53.44 }
        ]
      },
      {
        propertyId: 'p2',
        name: 'Όροφος 2',
        occupancyType: 'vacant',
        owners: [{ name: 'ΔΟΚΙΜΗ ΒΗΤΑ', taxId: '148152811', percentage: 100 }],
        monthlyCharges: [
          { term: TERM, expenseId, amount: 4.86, inputAmount: 53.44 }
        ]
      }
    ],
    ownerMonthlyExpenses: omeArray([])
  };
}

describe('vacant VARIABLE-expense owner charge materialisation (Step-7 fix)', () => {
  test('_recomputeVacantOwnerCharges writes a source:vacant owner row per vacant unit from monthlyCharges', async () => {
    TENANTS = []; // all vacant
    const b = makeBuilding();
    await _recomputeVacantOwnerCharges(b, 'realm1', TERM);
    const rows = b.ownerMonthlyExpenses.filter(
      (e) => e.source === 'vacant' && Number(e.term) === TERM
    );
    // Before the fix this was 0 (variable expenses were filtered out).
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.amount).sort()).toEqual([4.86, 4.86]);
    // amount comes from the persisted monthlyCharge, not expense.amount (0).
    rows.forEach((r) => expect(r.amount).toBeCloseTo(4.86, 2));
  });

  test('computeOwnerEksodaByMonth counts the materialised variable share EXACTLY once (no double-count vs live gap-fill)', async () => {
    TENANTS = [];
    const b = makeBuilding();
    await _recomputeVacantOwnerCharges(b, 'realm1', TERM);
    const { owedByTerm } = await computeOwnerEksodaByMonth('realm1', b, 2026);
    // 2 units × 4,86 = 9,72 — counted once (materialised loop), NOT 19,44.
    expect(owedByTerm.get(TERM)).toBeCloseTo(9.72, 2);
  });

  test('a recorded καταβολή on a variable vacant row survives a recompute (no payment loss)', async () => {
    TENANTS = [];
    const b = makeBuilding();
    await _recomputeVacantOwnerCharges(b, 'realm1', TERM);
    // record a payment on the first vacant row
    const row = b.ownerMonthlyExpenses.find((e) => e.source === 'vacant');
    row.payments = [{ date: '2026-06-20', amount: 4.86, type: 'cash', ownerKey: 'ΔΟΚΙΜΗ ΒΗΤΑ|148152811' }];
    // re-run the recompute (strip + re-derive) — the καταβολή must carry.
    await _recomputeVacantOwnerCharges(b, 'realm1', TERM);
    const after = b.ownerMonthlyExpenses.filter(
      (e) => e.source === 'vacant' && Number(e.term) === TERM
    );
    const totalPaid = after.reduce(
      (s, r) => s + (r.payments || []).reduce((ss, p) => ss + (Number(p.amount) || 0), 0),
      0
    );
    expect(totalPaid).toBeCloseTo(4.86, 2);
  });
});
