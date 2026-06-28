/* eslint-env node, jest */
/**
 * OWNER PAYMENT PRESERVATION — round-1 audit C1 + C2, hardened across 5 Step-7
 * rounds. The invariant under test: a recorded owner καταβολή (or a bare manual
 * paid flag) on a vacant/owner-fixed/owner-resident/repair/repair-vacant row
 * must SURVIVE any strip+rebuild (flag flip, move-in/out, reclassify, chargeTerm
 * change, innocuous edit) — never silently deleted (C1/C2-a/b), never inflating
 * OWED, never producing a negative outstanding, never double-counted.
 *
 * Final model: owner repair payments are pooled across BOTH repair sources
 * pre-strip and re-applied across the rebuilt liability rows; an overpay surplus
 * stays on a live row (over-paid), and every read surface clamps owed/paid to
 * the row amount + outstanding to ≥0. (No separate 'repair-overpay' source —
 * that leaked across surfaces; Step-7-r5.)
 *
 * type: module → jest.unstable_mockModule + dynamic import (see realmmanager).
 */
import { jest } from '@jest/globals';

let TENANTS = [];
let computeOwnerEksodaByMonth;
let _recomputeVacantOwnerCharges;
let _distributeRepairCharge;
let _aggregateOwners;
let _serializeOwnerSummary;
let ownerKeyOf;
let buildOwnerStatement;

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
  buildOwnerStatement = OwnerStatement.buildOwnerStatement;
  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: { Tenant: { find: () => ({ lean: async () => TENANTS }) } },
    logger: { warn() {}, info() {}, error() {} },
    ServiceError,
    OwnerStatement
  }));
  jest.unstable_mockModule('../managers/occupantmanager.js', () => ({
    _attachTenantGroupsToBuildings: async (_realmId, buildings) => {
      buildings.forEach((b) => (b._tenantGroups = []));
    }
  }));
  ({
    computeOwnerEksodaByMonth,
    _recomputeVacantOwnerCharges,
    _distributeRepairCharge
  } = await import('../managers/buildingmanager.js'));
  ({ _aggregateOwners, _serializeOwnerSummary, ownerKeyOf } = await import(
    '../managers/ownermanager.js'
  ));
});

beforeEach(() => {
  TENANTS = [];
});

// Mirror Mongoose's DocumentArray: .pull(_id) removes by id, and .push() ASSIGNS
// an _id when the row lacks one (real subdocs always get an _id). Without the
// auto-id, a row pushed by the manager (e.g. a preserved 'credit') had _id
// undefined, and a later .pull(undefined) matched the FIRST id-less row by
// accident — silently removing the wrong row (a test-harness artifact, not a
// production bug; the real DocumentArray never yields an id-less subdoc).
let _omeSeq = 0;
function omeArray(initial = []) {
  const arr = initial.map((x) => ({ _id: x._id || `ome_${++_omeSeq}`, ...x }));
  arr.pull = function (id) {
    const i = this.findIndex((e) => String(e._id) === String(id));
    if (i >= 0) this.splice(i, 1);
  };
  arr.push = function (row) {
    const withId = { _id: row._id || `ome_${++_omeSeq}`, ...row };
    Array.prototype.push.call(this, withId);
    return withId;
  };
  return arr;
}
const term = (mm, year) => Number(`${year}${String(mm).padStart(2, '0')}0100`);
const mkUnit = (propertyId, extra = {}) => ({
  _id: `u_${propertyId}`,
  propertyId,
  isManaged: true,
  surface: 50,
  generalThousandths: 0,
  heatingThousandths: 0,
  elevatorThousandths: 0,
  // Default: a single shared owner (real units always have owners). Same-owner
  // repair money may migrate across that owner's rows; tests needing DISTINCT
  // per-unit owners override `owners` explicitly.
  owners: [{ name: 'OWNER_SHARED', taxId: '000000000', percentage: 100 }],
  // monthlyCharges needs the Mongoose-DocumentArray .pull shim: the repair
  // distribution removes a unit's prior repair monthlyCharge via .pull when the
  // unit is occupied and the repair is re-distributed.
  monthlyCharges: omeArray([]),
  ...extra
});
const recordedPayment = (amount) => ({
  _id: `pay_${amount}`,
  amount,
  date: '15/06/2026',
  type: 'transfer',
  reference: 'KATABOLH'
});
const paymentsTotal = (row) =>
  (row && Array.isArray(row.payments) ? row.payments : []).reduce(
    (s, p) => s + (Number(p && p.amount) || 0),
    0
  );
const cashFor = (building, expenseId) =>
  building.ownerMonthlyExpenses
    .filter((r) => String(r.expenseId) === String(expenseId))
    .reduce((s, r) => s + paymentsTotal(r), 0);

// ── C1: vacant-owner recompute must not delete recorded καταβολές ──
describe('C1 _recomputeVacantOwnerCharges — recorded καταβολές survive', () => {
  const mkBuilding = (over = {}) => ({
    _id: 'b_c1',
    realmId: 'r1',
    units: [mkUnit('p1')],
    expenses: [
      {
        _id: 'e_fixed',
        name: 'Ρεύμα',
        type: 'electricity_common',
        amount: 0,
        allocationMethod: 'fixed',
        isRecurring: true,
        startTerm: 2026010100,
        chargeOwnerWhenVacant: true,
        customAllocations: [{ propertyId: 'p1', value: 40 }]
      }
    ],
    repairs: [],
    ownerMonthlyExpenses: omeArray([]),
    ...over
  });

  it('C1-a: flipping chargeOwnerWhenVacant OFF must NOT delete a recorded €40 καταβολή', async () => {
    const building = mkBuilding();
    const T = term(6, 2026);
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    let row = building.ownerMonthlyExpenses.find(
      (r) => Number(r.term) === T && String(r.propertyId) === 'p1'
    );
    expect(row).toBeTruthy();
    expect(row.amount).toBe(40);
    row.payments = [recordedPayment(40)];
    building.expenses[0].chargeOwnerWhenVacant = false;
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    expect(cashFor(building, 'e_fixed')).toBe(40); // survived
  });

  it('C1-b: a tenant moving INTO a paid vacant unit must NOT delete the €40 καταβολή', async () => {
    const building = mkBuilding();
    const T = term(6, 2026);
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    building.ownerMonthlyExpenses.find(
      (r) => Number(r.term) === T && String(r.propertyId) === 'p1'
    ).payments = [recordedPayment(40)];
    TENANTS = [
      {
        _id: 't1',
        beginDate: '2026-06-01',
        endDate: '2027-06-01',
        properties: [{ propertyId: 'p1', entryDate: '2026-06-01' }]
      }
    ];
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    expect(cashFor(building, 'e_fixed')).toBe(40); // survived
  });

  it('C1 guard: a fully-paid orphan shows €0 OUTSTANDING (owed===paid, no phantom)', async () => {
    const building = mkBuilding();
    const T = term(6, 2026);
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    building.ownerMonthlyExpenses.find(
      (r) => Number(r.term) === T && String(r.propertyId) === 'p1'
    ).payments = [recordedPayment(40)];
    building.expenses[0].chargeOwnerWhenVacant = false;
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    const { owedByTerm, paidByTerm } = await computeOwnerEksodaByMonth(
      'r1',
      building,
      2026
    );
    expect(paidByTerm.get(T) || 0).toBe(40);
    expect((owedByTerm.get(T) || 0) - (paidByTerm.get(T) || 0)).toBe(0);
  });

  it('C1 guard: a zero-payment flag-off orphan is correctly DROPPED (not a phantom owed)', async () => {
    const building = mkBuilding();
    const T = term(6, 2026);
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    // no payment recorded
    building.expenses[0].chargeOwnerWhenVacant = false;
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    const { owedByTerm } = await computeOwnerEksodaByMonth('r1', building, 2026);
    expect(owedByTerm.get(T) || 0).toBe(0); // dropped, no phantom liability
  });
});

// ── C2: repair distribution must not delete owner payments ──
describe('C2 _distributeRepairCharge — owner repair payments survive', () => {
  const mkRepairBuilding = (over = {}) => ({
    _id: 'b_rep',
    realmId: 'r1',
    name: 'Rep',
    atakPrefix: '011172',
    units: [mkUnit('p1', { generalThousandths: 1000 })],
    expenses: [],
    repairs: [],
    contractors: [],
    ownerMonthlyExpenses: omeArray([]),
    save: async function () {
      return this;
    },
    toObject: function () {
      return this;
    },
    ...over
  });
  const mk5Unit = () =>
    mkRepairBuilding({
      _id: 'b_rep5',
      units: ['p1', 'p2', 'p3', 'p4', 'p5'].map((p) =>
        mkUnit(p, { generalThousandths: 200 })
      )
    });

  it('C2-a: reclassify owner→tenant must NOT delete the recorded €200 καταβολή', async () => {
    TENANTS = [];
    const building = mkRepairBuilding();
    const repair = {
      _id: 'rep1',
      title: 'Roof',
      chargeableTo: 'owners',
      tenantSharePercentage: 0,
      allocationMethod: 'general_thousandths',
      // §2: these C2 payment-MIGRATION tests assume a vacant unit's repair
      // tenant-share routes to the OWNER (a source:'repair-vacant' row) — the
      // precondition every assertion below depends on. Post-§2 that routing is
      // opt-in via chargeOwnerWhenVacant (default false → Αχρέωτα), so the flag
      // must be ON to reproduce the world these tests verify. The migration
      // engine under test (pool re-apply, owner-identity reconciliation,
      // cross-owner safety) is unchanged by §2. Flag-OFF behavior (share →
      // Αχρέωτα, no owner row) is covered separately in the §2 describe below.
      chargeOwnerWhenVacant: true,
      actualCost: 200,
      chargeTerm: 2026060100,
      status: 'completed'
    };
    building.repairs = [repair];
    await _distributeRepairCharge(building, repair, 'r1');
    building.ownerMonthlyExpenses.find(
      (r) => r.source === 'repair' && String(r.expenseId) === 'rep1'
    ).payments = [recordedPayment(200)];
    repair.chargeableTo = 'tenants';
    repair.tenantSharePercentage = 100;
    await _distributeRepairCharge(building, repair, 'r1');
    expect(cashFor(building, 'rep1')).toBe(200); // survived
  });

  it('C2-b: changing chargeTerm A→B must NOT orphan the €150 καταβολή', async () => {
    TENANTS = [];
    const building = mkRepairBuilding();
    const repair = {
      _id: 'rep2',
      title: 'Boiler',
      chargeableTo: 'owners',
      tenantSharePercentage: 0,
      allocationMethod: 'general_thousandths',
      // §2: these C2 payment-MIGRATION tests assume a vacant unit's repair
      // tenant-share routes to the OWNER (a source:'repair-vacant' row) — the
      // precondition every assertion below depends on. Post-§2 that routing is
      // opt-in via chargeOwnerWhenVacant (default false → Αχρέωτα), so the flag
      // must be ON to reproduce the world these tests verify. The migration
      // engine under test (pool re-apply, owner-identity reconciliation,
      // cross-owner safety) is unchanged by §2. Flag-OFF behavior (share →
      // Αχρέωτα, no owner row) is covered separately in the §2 describe below.
      chargeOwnerWhenVacant: true,
      actualCost: 150,
      chargeTerm: 2026060100,
      status: 'completed'
    };
    building.repairs = [repair];
    await _distributeRepairCharge(building, repair, 'r1');
    building.ownerMonthlyExpenses.find(
      (r) => r.source === 'repair' && String(r.expenseId) === 'rep2'
    ).payments = [recordedPayment(150)];
    repair.chargeTerm = 2026070100;
    await _distributeRepairCharge(building, repair, 'r1');
    expect(cashFor(building, 'rep2')).toBe(150); // followed the repair
  });

  it('C2 guard: reclassify owner→tenant (occupied, partial owner share retained) — owed not inflated, no negative, money on a row', async () => {
    // Use a SPLIT 50% so the owner retains a real €100 liability row that can
    // hold the owner's recorded payment after the reclassify (the realistic
    // shape). p1 occupied → the tenant 50% bills the tenant; owner-portion €100
    // stays, and the owner's €100 payment lands on it (owed===paid, no negative,
    // no double-count). [The pathological "100% tenant + occupied + already
    // fully paid" leaves NO owner row to hold surplus — documented as a logged
    // drop / manual-refund per the no-owner-carry-forward design, not asserted
    // here.]
    TENANTS = [
      {
        _id: 't1',
        beginDate: '2026-01-01',
        endDate: '2027-01-01',
        properties: [{ propertyId: 'p1', entryDate: '2026-01-01' }]
      }
    ];
    const T = 2026060100;
    const building = mkRepairBuilding();
    const repair = {
      _id: 'rep3',
      title: 'Roof',
      chargeableTo: 'owners',
      tenantSharePercentage: 0,
      allocationMethod: 'general_thousandths',
      // §2: these C2 payment-MIGRATION tests assume a vacant unit's repair
      // tenant-share routes to the OWNER (a source:'repair-vacant' row) — the
      // precondition every assertion below depends on. Post-§2 that routing is
      // opt-in via chargeOwnerWhenVacant (default false → Αχρέωτα), so the flag
      // must be ON to reproduce the world these tests verify. The migration
      // engine under test (pool re-apply, owner-identity reconciliation,
      // cross-owner safety) is unchanged by §2. Flag-OFF behavior (share →
      // Αχρέωτα, no owner row) is covered separately in the §2 describe below.
      chargeOwnerWhenVacant: true,
      actualCost: 200,
      chargeTerm: T,
      status: 'completed'
    };
    building.repairs = [repair];
    await _distributeRepairCharge(building, repair, 'r1');
    building.ownerMonthlyExpenses.find(
      (r) => r.source === 'repair' && String(r.expenseId) === 'rep3'
    ).payments = [recordedPayment(200)];
    // reclassify to SPLIT 50% tenant → owner retains a €100 liability; the
    // owner's €100 (of the €200 paid) lands on it; the €100 OVERPAYMENT beyond
    // the now-smaller owner liability is DROPPED (no owner carry-forward ledger,
    // matching payOwner auto-mode). The €100 that is still genuinely owed is
    // preserved — that is the real C2 bug class.
    repair.chargeableTo = 'split';
    repair.tenantSharePercentage = 50;
    await _distributeRepairCharge(building, repair, 'r1');
    expect(cashFor(building, 'rep3')).toBe(100); // owed portion preserved; surplus dropped
    // read side: owed €100, paid €100, outstanding €0 — internally consistent,
    // no inflated totalPaid, no phantom.
    const { owedByTerm, paidByTerm } = await computeOwnerEksodaByMonth(
      'r1',
      building,
      2026
    );
    expect(owedByTerm.get(T) || 0).toBe(100);
    expect(paidByTerm.get(T) || 0).toBe(100);
    expect((owedByTerm.get(T) || 0) - (paidByTerm.get(T) || 0)).toBe(0);
    // no row carries payments beyond its amount (no over-pay → no inflated total).
    for (const r of building.ownerMonthlyExpenses.filter(
      (x) => String(x.expenseId) === 'rep3'
    )) {
      expect(paymentsTotal(r)).toBeLessThanOrEqual(Number(r.amount) + 0.005);
    }
  });

  it('C2 guard: owners→tenants(vacant)→owners round-trip keeps ONE €200, no €400 phantom', async () => {
    TENANTS = [];
    const T = 2026060100;
    const building = mkRepairBuilding();
    const repair = {
      _id: 'rep6',
      title: 'Lift',
      chargeableTo: 'owners',
      tenantSharePercentage: 0,
      allocationMethod: 'general_thousandths',
      // §2: these C2 payment-MIGRATION tests assume a vacant unit's repair
      // tenant-share routes to the OWNER (a source:'repair-vacant' row) — the
      // precondition every assertion below depends on. Post-§2 that routing is
      // opt-in via chargeOwnerWhenVacant (default false → Αχρέωτα), so the flag
      // must be ON to reproduce the world these tests verify. The migration
      // engine under test (pool re-apply, owner-identity reconciliation,
      // cross-owner safety) is unchanged by §2. Flag-OFF behavior (share →
      // Αχρέωτα, no owner row) is covered separately in the §2 describe below.
      chargeOwnerWhenVacant: true,
      actualCost: 200,
      chargeTerm: T,
      status: 'completed'
    };
    building.repairs = [repair];
    await _distributeRepairCharge(building, repair, 'r1');
    building.ownerMonthlyExpenses.find(
      (r) => r.source === 'repair' && String(r.expenseId) === 'rep6'
    ).payments = [recordedPayment(200)];
    repair.chargeableTo = 'tenants';
    repair.tenantSharePercentage = 100;
    await _distributeRepairCharge(building, repair, 'r1');
    repair.chargeableTo = 'owners';
    repair.tenantSharePercentage = 0;
    await _distributeRepairCharge(building, repair, 'r1');
    expect(cashFor(building, 'rep6')).toBe(200);
    const { owedByTerm, paidByTerm } = await computeOwnerEksodaByMonth(
      'r1',
      building,
      2026
    );
    expect(owedByTerm.get(T) || 0).toBe(200); // not 400
    expect((owedByTerm.get(T) || 0) - (paidByTerm.get(T) || 0)).toBe(0);
  });

  it('C2 guard: multi-unit overpay — genuine €40 vacant share preserved, €160 surplus dropped (no inflated total, no phantom)', async () => {
    // p1 vacant (€40 owner share), p2..p5 occupied. Owner paid €200; after
    // reclassify to 100% tenant only p1's €40 stays owner-borne. The €160 beyond
    // the (now-smaller) owner liability is an OVERPAYMENT → dropped (no owner
    // carry-forward ledger). The genuine €40 owed is preserved.
    const T = 2026060100;
    TENANTS = ['p2', 'p3', 'p4', 'p5'].map((p) => ({
      _id: `t_${p}`,
      beginDate: '2026-01-01',
      endDate: '2027-01-01',
      properties: [{ propertyId: p, entryDate: '2026-01-01' }]
    }));
    const building = mk5Unit();
    const repair = {
      _id: 'rep5',
      title: 'Facade',
      chargeableTo: 'owners',
      tenantSharePercentage: 0,
      allocationMethod: 'general_thousandths',
      // §2: these C2 payment-MIGRATION tests assume a vacant unit's repair
      // tenant-share routes to the OWNER (a source:'repair-vacant' row) — the
      // precondition every assertion below depends on. Post-§2 that routing is
      // opt-in via chargeOwnerWhenVacant (default false → Αχρέωτα), so the flag
      // must be ON to reproduce the world these tests verify. The migration
      // engine under test (pool re-apply, owner-identity reconciliation,
      // cross-owner safety) is unchanged by §2. Flag-OFF behavior (share →
      // Αχρέωτα, no owner row) is covered separately in the §2 describe below.
      chargeOwnerWhenVacant: true,
      actualCost: 200,
      chargeTerm: T,
      status: 'completed'
    };
    building.repairs = [repair];
    await _distributeRepairCharge(building, repair, 'r1');
    building.ownerMonthlyExpenses.find(
      (r) => r.source === 'repair' && String(r.expenseId) === 'rep5'
    ).payments = [recordedPayment(200)];
    repair.chargeableTo = 'tenants';
    repair.tenantSharePercentage = 100;
    await _distributeRepairCharge(building, repair, 'r1');
    expect(cashFor(building, 'rep5')).toBe(40); // genuine owed preserved; €160 surplus dropped
    const { owedByTerm, paidByTerm } = await computeOwnerEksodaByMonth(
      'r1',
      building,
      2026
    );
    // owed is the genuine vacant share (p1 €40); paid === owed (no surplus, no
    // inflated total, outstanding 0).
    expect(owedByTerm.get(T) || 0).toBe(40);
    expect(paidByTerm.get(T) || 0).toBe(40);
    expect((owedByTerm.get(T) || 0) - (paidByTerm.get(T) || 0)).toBe(0);
    // no row over-paid → totalPaid can't be inflated on the ledger/statement.
    for (const r of building.ownerMonthlyExpenses.filter(
      (x) => String(x.expenseId) === 'rep5'
    )) {
      expect(paymentsTotal(r)).toBeLessThanOrEqual(Number(r.amount) + 0.005);
    }
  });

  it('C2 guard: a bare manual paid flag survives an innocuous repair edit', async () => {
    TENANTS = [];
    const T = 2026060100;
    const building = mkRepairBuilding();
    const repair = {
      _id: 'rep8',
      title: 'Gutter',
      chargeableTo: 'owners',
      tenantSharePercentage: 0,
      allocationMethod: 'general_thousandths',
      // §2: these C2 payment-MIGRATION tests assume a vacant unit's repair
      // tenant-share routes to the OWNER (a source:'repair-vacant' row) — the
      // precondition every assertion below depends on. Post-§2 that routing is
      // opt-in via chargeOwnerWhenVacant (default false → Αχρέωτα), so the flag
      // must be ON to reproduce the world these tests verify. The migration
      // engine under test (pool re-apply, owner-identity reconciliation,
      // cross-owner safety) is unchanged by §2. Flag-OFF behavior (share →
      // Αχρέωτα, no owner row) is covered separately in the §2 describe below.
      chargeOwnerWhenVacant: true,
      actualCost: 200,
      chargeTerm: T,
      status: 'completed'
    };
    building.repairs = [repair];
    await _distributeRepairCharge(building, repair, 'r1');
    const row = building.ownerMonthlyExpenses.find(
      (r) => r.source === 'repair' && String(r.expenseId) === 'rep8'
    );
    row.paid = true; // setOwnerExpensePaid: bare flag, no payments
    row.paidDate = new Date('2026-06-15');
    row.payments = [];
    repair.title = 'Gutter (edited)';
    await _distributeRepairCharge(building, repair, 'r1');
    const { owedByTerm, paidByTerm } = await computeOwnerEksodaByMonth(
      'r1',
      building,
      2026
    );
    expect(owedByTerm.get(T) || 0).toBe(200);
    expect(paidByTerm.get(T) || 0).toBe(200); // NOT reverted to 0
  });

  it('C2 guard (r7): a bare paid flag on ONE row of a split repair must NOT mark its equal-amount sibling paid too', async () => {
    // Split repair €200, 50% tenant, p1 VACANT → rebuild yields TWO €100 owner
    // rows: owner-portion 'repair' (€100) + 'repair-vacant' (€100). Owner marks
    // ONLY the owner-portion paid via the bare flag. An innocuous edit must NOT
    // light up BOTH €100 rows (that double-counted paid on the eksoda dashboard
    // → owed 200 / paid 200 when only 100 was flagged — Step-7-r7).
    TENANTS = [];
    const T = 2026060100;
    const building = mkRepairBuilding();
    const repair = {
      _id: 'repSplit',
      title: 'Stairs',
      chargeableTo: 'split',
      tenantSharePercentage: 50,
      allocationMethod: 'general_thousandths',
      // §2: these C2 payment-MIGRATION tests assume a vacant unit's repair
      // tenant-share routes to the OWNER (a source:'repair-vacant' row) — the
      // precondition every assertion below depends on. Post-§2 that routing is
      // opt-in via chargeOwnerWhenVacant (default false → Αχρέωτα), so the flag
      // must be ON to reproduce the world these tests verify. The migration
      // engine under test (pool re-apply, owner-identity reconciliation,
      // cross-owner safety) is unchanged by §2. Flag-OFF behavior (share →
      // Αχρέωτα, no owner row) is covered separately in the §2 describe below.
      chargeOwnerWhenVacant: true,
      actualCost: 200,
      chargeTerm: T,
      status: 'completed'
    };
    building.repairs = [repair];
    await _distributeRepairCharge(building, repair, 'r1');
    // mark ONLY the owner-portion 'repair' row paid (bare flag).
    const ownerPortion = building.ownerMonthlyExpenses.find(
      (r) => r.source === 'repair' && String(r.expenseId) === 'repSplit'
    );
    expect(ownerPortion).toBeTruthy();
    expect(ownerPortion.amount).toBe(100);
    ownerPortion.paid = true;
    ownerPortion.paidDate = new Date('2026-06-15');
    ownerPortion.payments = [];
    repair.title = 'Stairs (edited)';
    await _distributeRepairCharge(building, repair, 'r1');
    const { owedByTerm, paidByTerm } = await computeOwnerEksodaByMonth(
      'r1',
      building,
      2026
    );
    // owed €200 (both €100 rows owed), but only €100 was flagged paid → paid
    // must be €100, NOT €200 (the double-flag bug).
    expect(owedByTerm.get(T) || 0).toBe(200);
    expect(paidByTerm.get(T) || 0).toBe(100); // exactly ONE row got the flag
  });

  it('C2 guard (r7 #2): in a multi-vacant building, a καταβολή stays attributed to the SAME unit on re-distribute', async () => {
    // p1 + p2 both VACANT, equal thousandths → an owners-repair €200 splits
    // €100/€100 across two repair-vacant rows (one per unit). Owner pays €100
    // ONLY on p1's row. An innocuous re-distribute must keep that €100 on p1's
    // row — a flat pool re-filled in array order and could move it to p2's row
    // (a DIFFERENT owner's liability in a real co-owned building — Step-7-r7).
    TENANTS = [];
    const T = 2026060100;
    const building = mkRepairBuilding({
      _id: 'b_rep2v',
      units: [
        mkUnit('p1', {
          generalThousandths: 500,
          owners: [{ name: 'OWNER_A', taxId: '111', percentage: 100 }]
        }),
        mkUnit('p2', {
          generalThousandths: 500,
          owners: [{ name: 'OWNER_B', taxId: '222', percentage: 100 }]
        })
      ]
    });
    const repair = {
      _id: 'repMV',
      title: 'Roof',
      chargeableTo: 'owners',
      tenantSharePercentage: 0,
      allocationMethod: 'general_thousandths',
      // §2: these C2 payment-MIGRATION tests assume a vacant unit's repair
      // tenant-share routes to the OWNER (a source:'repair-vacant' row) — the
      // precondition every assertion below depends on. Post-§2 that routing is
      // opt-in via chargeOwnerWhenVacant (default false → Αχρέωτα), so the flag
      // must be ON to reproduce the world these tests verify. The migration
      // engine under test (pool re-apply, owner-identity reconciliation,
      // cross-owner safety) is unchanged by §2. Flag-OFF behavior (share →
      // Αχρέωτα, no owner row) is covered separately in the §2 describe below.
      chargeOwnerWhenVacant: true,
      actualCost: 200,
      chargeTerm: T,
      status: 'completed'
    };
    building.repairs = [repair];
    // tenants-100% repair on TWO vacant units → two repair-vacant owner rows
    // (€100 each), one per owner. (Step-7-r8 exact shape.)
    repair.chargeableTo = 'tenants';
    repair.tenantSharePercentage = 100;
    await _distributeRepairCharge(building, repair, 'r1');
    const rowsBefore = building.ownerMonthlyExpenses.filter(
      (r) => String(r.expenseId) === 'repMV'
    );
    const p1Row = rowsBefore.find((r) => String(r.propertyId) === 'p1');
    const p2Row = rowsBefore.find((r) => String(r.propertyId) === 'p2');
    // precondition MUST hold (fail loud, not a silent no-op): the scenario
    // requires per-unit repair-vacant rows for two different owners.
    expect(p1Row).toBeTruthy(); // p1 repair-vacant row must exist
    expect(p2Row).toBeTruthy(); // p2 repair-vacant row must exist
    const p1Amt = Number(p1Row.amount);
    // OWNER_A records €100 on p1's row.
    p1Row.payments = [recordedPayment(p1Amt)];
    // p1 becomes OCCUPIED → its share now bills the tenant; p1's owner row will
    // NOT be rebuilt. Then a repair edit re-runs distribution (the trigger).
    TENANTS = [
      {
        _id: 't1',
        beginDate: '2026-01-01',
        endDate: '2027-01-01',
        properties: [{ propertyId: 'p1', entryDate: '2026-01-01' }]
      }
    ];
    repair.title = 'Roof (edited)';
    await _distributeRepairCharge(building, repair, 'r1');
    const after = building.ownerMonthlyExpenses.filter(
      (r) => String(r.expenseId) === 'repMV'
    );
    const p2After = after.find((r) => String(r.propertyId) === 'p2');
    const paidOf = (row) =>
      (row?.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    // OWNER_A's €100 (p1, now occupied) must NOT migrate onto OWNER_B's p2 row.
    // It is OWNER_A's overpayment for a now-tenant-billed unit → dropped, NOT
    // credited to a different owner (Step-7-r8 cross-owner mis-attribution).
    expect(paidOf(p2After)).toBe(0);
  });

  it('C2 guard (r9): building-wide owner-portion payment REACHES a sole-owned unit in a mixed building (subset coverage, not dropped)', async () => {
    // The owner-signature gate must use SUBSET coverage, not strict equality:
    // a 100%-owners repair pays ONE building-wide 'repair' row (signature = ALL
    // building owners). Reclassify to tenants on a vacant unit → the money must
    // reach that unit's repair-vacant row even though the unit's owner-set is a
    // strict SUBSET of the building owners. Strict equality (Step-7-r9) DROPPED
    // this still-owed money. Single managed unit owned by OWNER_A; building also
    // has a second unit owned by OWNER_B (so the building-wide set is {A,B} ⊋ {A}).
    TENANTS = [];
    const T = 2026060100;
    const building = mkRepairBuilding({
      _id: 'b_mixed',
      units: [
        mkUnit('p1', {
          generalThousandths: 1000,
          owners: [{ name: 'OWNER_A', taxId: '111', percentage: 100 }]
        }),
        // a second, OCCUPIED unit owned by B — makes the building-wide owner set
        // {A,B}, a strict superset of p1's {A}. (occupied so it takes no repair.)
        mkUnit('p2', {
          generalThousandths: 0,
          owners: [{ name: 'OWNER_B', taxId: '222', percentage: 100 }]
        })
      ]
    });
    const repair = {
      _id: 'repMix',
      title: 'Roof',
      chargeableTo: 'owners',
      tenantSharePercentage: 0,
      allocationMethod: 'general_thousandths',
      // §2: these C2 payment-MIGRATION tests assume a vacant unit's repair
      // tenant-share routes to the OWNER (a source:'repair-vacant' row) — the
      // precondition every assertion below depends on. Post-§2 that routing is
      // opt-in via chargeOwnerWhenVacant (default false → Αχρέωτα), so the flag
      // must be ON to reproduce the world these tests verify. The migration
      // engine under test (pool re-apply, owner-identity reconciliation,
      // cross-owner safety) is unchanged by §2. Flag-OFF behavior (share →
      // Αχρέωτα, no owner row) is covered separately in the §2 describe below.
      chargeOwnerWhenVacant: true,
      actualCost: 200,
      chargeTerm: T,
      status: 'completed'
    };
    building.repairs = [repair];
    await _distributeRepairCharge(building, repair, 'r1');
    // building-wide owner-portion 'repair' row (propertyId null), pay €200.
    const ownerRow = building.ownerMonthlyExpenses.find(
      (r) => r.source === 'repair' && !r.propertyId && String(r.expenseId) === 'repMix'
    );
    expect(ownerRow).toBeTruthy();
    ownerRow.payments = [recordedPayment(200)];
    // reclassify to tenants → p1 vacant → its share routes to a repair-vacant
    // row; the building-wide €200 must migrate onto it (subset coverage).
    repair.chargeableTo = 'tenants';
    repair.tenantSharePercentage = 100;
    await _distributeRepairCharge(building, repair, 'r1');
    const paidOf = (row) =>
      (row?.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const p1rv = building.ownerMonthlyExpenses.find(
      (r) => r.source === 'repair-vacant' && String(r.propertyId) === 'p1'
    );
    expect(p1rv).toBeTruthy();
    // p1's owner share is €200 (1000/1000 thousandths) → the building-wide €200
    // reaches it (NOT dropped by strict-equality).
    expect(paidOf(p1rv)).toBe(Number(p1rv.amount));
  });

  it('C2 guard (r10): same owner keyed differently (taxId present vs absent) across two units must NOT drop the migrating καταβολή', async () => {
    // The owner-coverage gate must reconcile the SAME human across identity-key
    // drift (ownerKeyOf prefers memberId, else name|taxId — so taxId-on-p1 vs
    // taxId-absent-on-p2 for the same name yields DIFFERENT keys). A repair on
    // two same-owner vacant units, payment on p1, p1 becomes occupied + edit →
    // p1's money must migrate to p2 (same human), NOT be dropped as overpayment
    // (Step-7-r10: strict-key drift silently deleted the still-owed payment).
    TENANTS = [];
    const T = 2026060100;
    const building = mkRepairBuilding({
      _id: 'b_drift',
      units: [
        mkUnit('p1', {
          generalThousandths: 500,
          owners: [{ name: 'ALICE', taxId: '999', percentage: 100 }]
        }),
        mkUnit('p2', {
          generalThousandths: 500,
          // SAME human ALICE, but taxId ABSENT → ownerKeyOf differs from p1's.
          owners: [{ name: 'ALICE', percentage: 100 }]
        })
      ]
    });
    const repair = {
      _id: 'repDrift',
      title: 'Roof',
      chargeableTo: 'tenants',
      tenantSharePercentage: 100,
      allocationMethod: 'general_thousandths',
      // §2: these C2 payment-MIGRATION tests assume a vacant unit's repair
      // tenant-share routes to the OWNER (a source:'repair-vacant' row) — the
      // precondition every assertion below depends on. Post-§2 that routing is
      // opt-in via chargeOwnerWhenVacant (default false → Αχρέωτα), so the flag
      // must be ON to reproduce the world these tests verify. The migration
      // engine under test (pool re-apply, owner-identity reconciliation,
      // cross-owner safety) is unchanged by §2. Flag-OFF behavior (share →
      // Αχρέωτα, no owner row) is covered separately in the §2 describe below.
      chargeOwnerWhenVacant: true,
      actualCost: 200,
      chargeTerm: T,
      status: 'completed'
    };
    building.repairs = [repair];
    await _distributeRepairCharge(building, repair, 'r1');
    const p1rv = building.ownerMonthlyExpenses.find(
      (r) => r.source === 'repair-vacant' && String(r.propertyId) === 'p1'
    );
    expect(p1rv).toBeTruthy();
    const p1Amt = Number(p1rv.amount);
    p1rv.payments = [recordedPayment(p1Amt)];
    // p1 becomes occupied → its row won't be rebuilt; p1's payment must migrate
    // to p2's still-vacant row (same owner ALICE, despite the key drift).
    TENANTS = [
      {
        _id: 't1',
        beginDate: '2026-01-01',
        endDate: '2027-01-01',
        properties: [{ propertyId: 'p1', entryDate: '2026-01-01' }]
      }
    ];
    repair.title = 'Roof (edited)';
    await _distributeRepairCharge(building, repair, 'r1');
    // the payment is preserved (migrated to p2 — same owner), NOT dropped.
    expect(cashFor(building, 'repDrift')).toBe(p1Amt);
  });

  it('C2 guard (r11 B1/B2): single-owner multi-unit — a per-unit repair-vacant payment migrates to the owner-portion row (building-wide owner-set deduped)', async () => {
    // Single owner O owns 3 units. Split repair (ownerPortion>0) with p1 vacant
    // → owner-portion 'repair' row (€__) + p1 repair-vacant row. Pay on p1's
    // row; then ALL units occupied + edit → only the owner-portion row remains.
    // The p1 payment must migrate to the owner-portion row (same sole owner) —
    // a non-deduped building-wide owner list (length 3) vs p1's (length 1)
    // defeated the length check and dropped the money (Step-7-r11).
    const T = 2026060100;
    const O = { name: 'OWNER_O', taxId: '777', percentage: 100 };
    TENANTS = [];
    const building = mkRepairBuilding({
      _id: 'b_1owner3unit',
      units: [
        mkUnit('p1', { generalThousandths: 400, owners: [{ ...O }] }),
        mkUnit('p2', { generalThousandths: 300, owners: [{ ...O }] }),
        mkUnit('p3', { generalThousandths: 300, owners: [{ ...O }] })
      ]
    });
    const repair = {
      _id: 'rep1o3u',
      title: 'Facade',
      chargeableTo: 'split',
      tenantSharePercentage: 50, // ownerPortion = 50% > 0 → owner-portion row
      allocationMethod: 'general_thousandths',
      // §2: these C2 payment-MIGRATION tests assume a vacant unit's repair
      // tenant-share routes to the OWNER (a source:'repair-vacant' row) — the
      // precondition every assertion below depends on. Post-§2 that routing is
      // opt-in via chargeOwnerWhenVacant (default false → Αχρέωτα), so the flag
      // must be ON to reproduce the world these tests verify. The migration
      // engine under test (pool re-apply, owner-identity reconciliation,
      // cross-owner safety) is unchanged by §2. Flag-OFF behavior (share →
      // Αχρέωτα, no owner row) is covered separately in the §2 describe below.
      chargeOwnerWhenVacant: true,
      actualCost: 1000,
      chargeTerm: T,
      status: 'completed'
    };
    building.repairs = [repair];
    await _distributeRepairCharge(building, repair, 'r1');
    const p1rv = building.ownerMonthlyExpenses.find(
      (r) => r.source === 'repair-vacant' && String(r.propertyId) === 'p1'
    );
    expect(p1rv).toBeTruthy();
    const p1Amt = Number(p1rv.amount);
    p1rv.payments = [recordedPayment(p1Amt)];
    // all units occupied → no repair-vacant rows next run; only owner-portion.
    TENANTS = ['p1', 'p2', 'p3'].map((p) => ({
      _id: `t_${p}`,
      beginDate: '2026-01-01',
      endDate: '2027-01-01',
      properties: [{ propertyId: p, entryDate: '2026-01-01' }]
    }));
    repair.title = 'Facade (edited)';
    await _distributeRepairCharge(building, repair, 'r1');
    // p1's payment migrates to the owner-portion row (same sole owner), NOT dropped.
    expect(cashFor(building, 'rep1o3u')).toBe(p1Amt);
  });

  it('C2 guard (r11 B3): two DIFFERENT same-name owners with CONFLICTING taxIds are NOT merged (no cross-owner credit)', async () => {
    // p1 owner "ΔΟΚΙΜΗ" taxId 111; p2 owner "ΔΟΚΙΜΗ" taxId 222 — same
    // normalized name, DIFFERENT humans. A payment on p1 must NOT migrate to p2
    // (sameOwner must return false on conflicting taxIds despite equal names).
    TENANTS = [];
    const T = 2026060100;
    const building = mkRepairBuilding({
      _id: 'b_samename',
      units: [
        mkUnit('p1', {
          generalThousandths: 500,
          owners: [{ name: 'ΔΟΚΙΜΗ', taxId: '111', percentage: 100 }]
        }),
        mkUnit('p2', {
          generalThousandths: 500,
          owners: [{ name: 'ΔΟΚΙΜΗ', taxId: '222', percentage: 100 }]
        })
      ]
    });
    const repair = {
      _id: 'repSameName',
      title: 'Roof',
      chargeableTo: 'tenants',
      tenantSharePercentage: 100,
      allocationMethod: 'general_thousandths',
      // §2: these C2 payment-MIGRATION tests assume a vacant unit's repair
      // tenant-share routes to the OWNER (a source:'repair-vacant' row) — the
      // precondition every assertion below depends on. Post-§2 that routing is
      // opt-in via chargeOwnerWhenVacant (default false → Αχρέωτα), so the flag
      // must be ON to reproduce the world these tests verify. The migration
      // engine under test (pool re-apply, owner-identity reconciliation,
      // cross-owner safety) is unchanged by §2. Flag-OFF behavior (share →
      // Αχρέωτα, no owner row) is covered separately in the §2 describe below.
      chargeOwnerWhenVacant: true,
      actualCost: 200,
      chargeTerm: T,
      status: 'completed'
    };
    building.repairs = [repair];
    await _distributeRepairCharge(building, repair, 'r1');
    const p1rv = building.ownerMonthlyExpenses.find(
      (r) => r.source === 'repair-vacant' && String(r.propertyId) === 'p1'
    );
    expect(p1rv).toBeTruthy();
    p1rv.payments = [recordedPayment(Number(p1rv.amount))];
    TENANTS = [
      {
        _id: 't1',
        beginDate: '2026-01-01',
        endDate: '2027-01-01',
        properties: [{ propertyId: 'p1', entryDate: '2026-01-01' }]
      }
    ];
    repair.title = 'Roof (edited)';
    await _distributeRepairCharge(building, repair, 'r1');
    const p2rv = building.ownerMonthlyExpenses.find(
      (r) => r.source === 'repair-vacant' && String(r.propertyId) === 'p2'
    );
    const paidOf = (row) =>
      (row?.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    // taxId 111's payment must NOT land on taxId 222's row.
    expect(paidOf(p2rv)).toBe(0);
  });

  it('C2 guard (r12): building-wide owner-portion payment must NOT over-spread onto a DIFFERENT owner in a mixed building', async () => {
    // Mixed building: p1 → owner A, p2 → owner B. A split repair makes a
    // building-wide owner-portion 'repair' row (attributed read-side to the
    // canonical owner A). A pays it. Reclassify so ownerPortion→0 while p2 (B)
    // is vacant with an unpaid repair-vacant row. A's payment must NOT migrate
    // onto B's row (Step-7-r12 cross-owner over-spread). It is A's overpayment →
    // dropped, NOT credited to B.
    TENANTS = [
      {
        _id: 't_p1',
        beginDate: '2026-01-01',
        endDate: '2027-01-01',
        properties: [{ propertyId: 'p1', entryDate: '2026-01-01' }]
      }
    ]; // p1 occupied so the owner-portion is the building-wide row; p2 vacant
    const T = 2026060100;
    const building = mkRepairBuilding({
      _id: 'b_mixed_r12',
      units: [
        mkUnit('p1', {
          generalThousandths: 500,
          owners: [{ name: 'AAA_OWNER', taxId: '111', percentage: 100 }]
        }),
        mkUnit('p2', {
          generalThousandths: 500,
          owners: [{ name: 'BBB_OWNER', taxId: '222', percentage: 100 }]
        })
      ]
    });
    const repair = {
      _id: 'repMixR12',
      title: 'Lift',
      chargeableTo: 'split',
      tenantSharePercentage: 40, // ownerPortion 60% > 0 → building-wide row
      allocationMethod: 'general_thousandths',
      // §2: these C2 payment-MIGRATION tests assume a vacant unit's repair
      // tenant-share routes to the OWNER (a source:'repair-vacant' row) — the
      // precondition every assertion below depends on. Post-§2 that routing is
      // opt-in via chargeOwnerWhenVacant (default false → Αχρέωτα), so the flag
      // must be ON to reproduce the world these tests verify. The migration
      // engine under test (pool re-apply, owner-identity reconciliation,
      // cross-owner safety) is unchanged by §2. Flag-OFF behavior (share →
      // Αχρέωτα, no owner row) is covered separately in the §2 describe below.
      chargeOwnerWhenVacant: true,
      actualCost: 1000,
      chargeTerm: T,
      status: 'completed'
    };
    building.repairs = [repair];
    await _distributeRepairCharge(building, repair, 'r1');
    const ownerRow = building.ownerMonthlyExpenses.find(
      (r) => r.source === 'repair' && !r.propertyId && String(r.expenseId) === 'repMixR12'
    );
    expect(ownerRow).toBeTruthy();
    ownerRow.payments = [recordedPayment(Number(ownerRow.amount))];
    // reclassify to 100% tenant → ownerPortion 0, no owner-portion row rebuilt.
    repair.chargeableTo = 'tenants';
    repair.tenantSharePercentage = 100;
    await _distributeRepairCharge(building, repair, 'r1');
    const paidOf = (row) =>
      (row?.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const p2rv = building.ownerMonthlyExpenses.find(
      (r) => r.source === 'repair-vacant' && String(r.propertyId) === 'p2'
    );
    // owner A's building-wide payment must NOT land on owner B's p2 row.
    expect(paidOf(p2rv)).toBe(0);
  });

  // DOCUMENTED LIMITATION (user decision, Step-7-r13/r14): moving a repair's
  // chargeTerm A→B in the SAME edit that the unit becomes occupied at B leaves
  // the term-A καταβολή with no liability row at B and no same-owner live row to
  // absorb it. Preserving it required synthetic rows that re-introduced
  // double-count/over-pay leaks on every adjacent edit shape (r14), so the
  // chosen design DROPS it (logged) — the same no-owner-carry-forward contract
  // as payOwner auto-mode and the r11-B4 reclassify case. This shape needs a
  // chargeTerm-move + simultaneous move-in, which does not occur on the real
  // data. The test pins the decided behavior (no phantom/over-pay), NOT a
  // money-preservation claim.
  it('C2 limitation (r13/r14): chargeTerm-move + move-in drops the orphaned payment cleanly (no phantom owed, no over-pay)', async () => {
    const A = 2026050100;
    const B = 2026060100;
    TENANTS = []; // May: p1 vacant
    const building = mkRepairBuilding();
    const repair = {
      _id: 'repTermMove',
      title: 'Plumbing',
      chargeableTo: 'tenants',
      tenantSharePercentage: 100,
      allocationMethod: 'general_thousandths',
      // §2: these C2 payment-MIGRATION tests assume a vacant unit's repair
      // tenant-share routes to the OWNER (a source:'repair-vacant' row) — the
      // precondition every assertion below depends on. Post-§2 that routing is
      // opt-in via chargeOwnerWhenVacant (default false → Αχρέωτα), so the flag
      // must be ON to reproduce the world these tests verify. The migration
      // engine under test (pool re-apply, owner-identity reconciliation,
      // cross-owner safety) is unchanged by §2. Flag-OFF behavior (share →
      // Αχρέωτα, no owner row) is covered separately in the §2 describe below.
      chargeOwnerWhenVacant: true,
      actualCost: 100,
      chargeTerm: A,
      status: 'completed'
    };
    building.repairs = [repair];
    await _distributeRepairCharge(building, repair, 'r1');
    const rvA = building.ownerMonthlyExpenses.find(
      (r) => r.source === 'repair-vacant' && Number(r.term) === A
    );
    expect(rvA).toBeTruthy();
    rvA.payments = [recordedPayment(Number(rvA.amount))];
    // move charge to June; p1 occupied in June.
    repair.chargeTerm = B;
    TENANTS = [
      {
        _id: 't1',
        beginDate: '2026-06-01',
        endDate: '2027-06-01',
        properties: [{ propertyId: 'p1', entryDate: '2026-06-01' }]
      }
    ];
    await _distributeRepairCharge(building, repair, 'r1');
    // the orphaned payment is DROPPED (accepted limitation) — crucially NO
    // phantom owed row survives and NO row is over-paid (the leak-free property).
    const { owedByTerm, paidByTerm } = await computeOwnerEksodaByMonth(
      'r1',
      building,
      2026
    );
    expect(paidByTerm.get(A) || 0).toBe(0); // dropped, not preserved (by design)
    expect(owedByTerm.get(A) || 0).toBe(0); // and NO phantom owed at term A
    // no owner row over-paid anywhere (no negative outstanding / inflated total).
    for (const r of building.ownerMonthlyExpenses.filter(
      (x) => String(x.expenseId) === 'repTermMove'
    )) {
      const paid = (r.payments || []).reduce(
        (s, p) => s + (Number(p.amount) || 0),
        0
      );
      expect(paid).toBeLessThanOrEqual(Number(r.amount) + 0.005);
    }
  });

  // ── §2: chargeOwnerWhenVacant gates whether a vacant unit's repair share
  // routes to the owner. Default FALSE → the share is NOT billed to the owner
  // (it becomes Αχρέωτα, computed live, not persisted) — no repair-vacant row.
  // (The mkRepairBuilding fixtures above set the flag TRUE; these build repairs
  // WITHOUT going through that line so the flag defaults to undefined/false.)
  describe('§2 chargeOwnerWhenVacant gating (flag OFF → Αχρέωτα, not owner-billed)', () => {
    const mkBareBuilding = () => ({
      _id: 'b_s2',
      realmId: 'r1',
      name: 'S2',
      atakPrefix: '011172',
      units: [mkUnit('p1', { generalThousandths: 1000 })],
      expenses: [],
      repairs: [],
      contractors: [],
      ownerMonthlyExpenses: omeArray([]),
      save: async function () {
        return this;
      },
      toObject: function () {
        return this;
      }
    });

    it('flag OFF: a vacant unit tenants-repair creates NO repair-vacant owner row', async () => {
      TENANTS = []; // p1 vacant
      const building = mkBareBuilding();
      const repair = {
        _id: 'repS2off',
        title: 'Roof',
        chargeableTo: 'tenants',
        tenantSharePercentage: 100,
        allocationMethod: 'general_thousandths',
        actualCost: 100,
        chargeTerm: 2026060100,
        status: 'completed'
        // chargeOwnerWhenVacant intentionally absent → default false
      };
      building.repairs = [repair];
      await _distributeRepairCharge(building, repair, 'r1');
      const rv = building.ownerMonthlyExpenses.find(
        (r) => r.source === 'repair-vacant' && String(r.expenseId) === 'repS2off'
      );
      expect(rv).toBeFalsy(); // share went to Αχρέωτα, not the owner ledger
      // and the eksoda owed for that term is €0 (uncollected, not owner-borne).
      const { owedByTerm } = await computeOwnerEksodaByMonth(
        'r1',
        building,
        2026
      );
      expect(owedByTerm.get(2026060100) || 0).toBe(0);
    });

    it('flag ON: the SAME vacant unit tenants-repair DOES create a repair-vacant owner row', async () => {
      TENANTS = [];
      const building = mkBareBuilding();
      const repair = {
        _id: 'repS2on',
        title: 'Roof',
        chargeableTo: 'tenants',
        tenantSharePercentage: 100,
        allocationMethod: 'general_thousandths',
        actualCost: 100,
        chargeTerm: 2026060100,
        status: 'completed',
        chargeOwnerWhenVacant: true
      };
      building.repairs = [repair];
      await _distributeRepairCharge(building, repair, 'r1');
      const rv = building.ownerMonthlyExpenses.find(
        (r) => r.source === 'repair-vacant' && String(r.expenseId) === 'repS2on'
      );
      expect(rv).toBeTruthy();
      expect(Number(rv.amount)).toBe(100); // full tenant share routed to owner
    });

    const cashFor2 = (building, expenseId) =>
      building.ownerMonthlyExpenses
        .filter((r) => String(r.expenseId) === String(expenseId))
        .reduce((s, r) => s + paymentsTotal(r), 0);

    // Step-7 re-review (inert-credit model): a credit remnant + a later liability
    // share that ends up re-billed to an occupied tenant. Credits are INERT
    // (never re-captured/re-dropped), so the owner's full recorded €100 survives
    // as a credit, the tenant is billed the corrected €70 SEPARATELY, and there
    // is NO double-count (the €70 tenant charge is the tenant's own obligation,
    // not netted against the owner credit) and NO loss (the owner's €100 stays).
    // The owner genuinely paid €100 toward a repair later corrected to €70 and
    // re-billed to the tenant → they hold a €100 credit, owe €0. Natural 4-step
    // sequence, all via the real writer.
    it('contamination: credit survives in full + tenant billed separately (no double-count, no loss)', async () => {
      const T = 2026060100;
      const mkB = () => ({
        _id: 'b_contam',
        realmId: 'r1',
        name: 'C',
        atakPrefix: '011172',
        units: [mkUnit('p1', { generalThousandths: 1000 })],
        expenses: [],
        repairs: [],
        contractors: [],
        ownerMonthlyExpenses: omeArray([]),
        save: async function () {
          return this;
        },
        toObject: function () {
          return this;
        }
      });
      TENANTS = []; // p1 vacant
      const building = mkB();
      const repair = {
        _id: 'repContam',
        title: 'Lift',
        chargeableTo: 'tenants',
        tenantSharePercentage: 100,
        allocationMethod: 'general_thousandths',
        actualCost: 100,
        chargeTerm: T,
        status: 'completed',
        chargeOwnerWhenVacant: true
      };
      building.repairs = [repair];
      // Step 1: vacant + flag ON → €100 repair-vacant; owner pays €100.
      await _distributeRepairCharge(building, repair, 'r1');
      building.ownerMonthlyExpenses.find(
        (r) => r.source === 'repair-vacant'
      ).payments = [recordedPayment(100)];
      // Step 2: flag OFF → €100 preserved as a credit (Αχρέωτα, no tenant twin).
      repair.chargeOwnerWhenVacant = false;
      await _distributeRepairCharge(building, repair, 'r1');
      expect(
        building.ownerMonthlyExpenses.filter((r) => r.source === 'credit')
      ).toHaveLength(1);
      // Step 3: cost corrected to €70 + flag back ON → €70 repair-vacant absorbs
      // €70, €30 residual credit, both at bucket p1.
      repair.actualCost = 70;
      repair.chargeOwnerWhenVacant = true;
      await _distributeRepairCharge(building, repair, 'r1');
      // Step 4: tenant occupies p1 → €70 re-bills to rent; repair re-distributed.
      TENANTS = [
        {
          _id: 't1',
          beginDate: '2026-01-01',
          endDate: '2027-01-01',
          properties: [{ propertyId: 'p1', entryDate: '2026-01-01' }]
        }
      ];
      repair.title = 'Lift (edited)';
      await _distributeRepairCharge(building, repair, 'r1');
      // The €70 corrected share is now the tenant's (a monthlyCharge on p1). The
      // owner's recorded €100 survives IN FULL as an inert credit (they overpaid a
      // repair later corrected + moved to the tenant → they hold a €100 credit).
      // No double-count: the €70 tenant charge is the tenant's own obligation, not
      // summed against the owner credit. No loss: the full €100 stays on the owner.
      const tenantCharge = building.units[0].monthlyCharges
        .filter((c) => String(c.repairId) === 'repContam')
        .reduce((s, c) => s + Number(c.amount), 0);
      expect(tenantCharge).toBe(70);
      expect(cashFor2(building, 'repContam')).toBe(100); // owner's full recorded €
      // owner owes nothing now (liability moved to tenant): no live repair/repair-
      // vacant liability row remains, only the inert credit.
      const liveLiab = building.ownerMonthlyExpenses.filter(
        (r) =>
          String(r.expenseId) === 'repContam' &&
          (r.source === 'repair' || r.source === 'repair-vacant')
      );
      expect(liveLiab).toHaveLength(0);
    });

    // Step-7 finding 4: owners→split-on-vacant-flag-off reclassify of a PAID
    // owner-portion. The owner paid the full owners repair; reclassify so a share
    // routes to a flag-off vacant unit (Αχρέωτα). That share has NO tenant twin →
    // the already-paid money must be PRESERVED as a credit, not dropped.
    it('owners→split-on-vacant (flag off) reclassify preserves the paid owner καταβολή (no money loss)', async () => {
      const T = 2026060100;
      const building = {
        _id: 'b_f4',
        realmId: 'r1',
        name: 'F4',
        atakPrefix: '011172',
        units: [mkUnit('p1', { generalThousandths: 1000 })],
        expenses: [],
        repairs: [],
        contractors: [],
        ownerMonthlyExpenses: omeArray([]),
        save: async function () {
          return this;
        },
        toObject: function () {
          return this;
        }
      };
      TENANTS = []; // p1 vacant
      const repair = {
        _id: 'repF4',
        title: 'Facade',
        chargeableTo: 'owners',
        tenantSharePercentage: 0,
        allocationMethod: 'general_thousandths',
        actualCost: 100,
        chargeTerm: T,
        status: 'completed'
        // chargeOwnerWhenVacant absent → false
      };
      building.repairs = [repair];
      await _distributeRepairCharge(building, repair, 'r1');
      // owner pays the full €100 owner-portion.
      building.ownerMonthlyExpenses.find(
        (r) => r.source === 'repair' && String(r.expenseId) === 'repF4'
      ).payments = [recordedPayment(100)];
      // reclassify to 60% tenant → owner-portion shrinks to €40; the €60 tenant
      // share falls on the VACANT p1 with flag OFF → Αχρέωτα (no tenant twin).
      repair.chargeableTo = 'split';
      repair.tenantSharePercentage = 60;
      await _distributeRepairCharge(building, repair, 'r1');
      // The €100 the owner paid must survive in full: €40 on the rebuilt owner-
      // portion + €60 preserved as a credit (the Αχρέωτα-bound share). NOT dropped.
      expect(cashFor2(building, 'repF4')).toBe(100);
    });
  });
});

// ── ΒΗΤΑ: owner-fixed (ownerAmount) is materialised PER-UNIT, sliced per ──
// ── owner — END-TO-END through the real writer + the real ledger reader.   ──
// Reproduces the live ΑΓ. ΟΔΟΣ ΕΨΙΛΟΝ 28 shape: an expense with a FIXED owner-only
// amount (trackOwnerExpense + ownerAmount=100, equal allocation) across units
// the SAME owner holds at MIXED percentages (50% on some, 100% on others), the
// 50% units' co-owner ABSENT from the data. Before the fix this wrote ONE
// building-wide owner-fixed lump (propertyId null) and the ledger billed the
// full €100 to the sole identified owner. After: per-unit owner-fixed rows
// (Σ === ownerAmount) and the ledger bills only her real share.
describe('ΒΗΤΑ owner-fixed per-unit materialisation + per-owner slice (end-to-end)', () => {
  const beta = (pct) => ({
    name: 'ΔΟΚΙΜΗ ΒΗΤΑ',
    taxId: '111111111',
    percentage: pct
  });
  // 4 units at 50% (co-owner absent), 2 units at 100% — all vacant.
  const mkBuilding = () => ({
    _id: 'b_beta',
    realmId: 'r1',
    name: 'ΑΓ. ΟΔΟΣ ΕΨΙΛΟΝ 28',
    units: [
      mkUnit('pA', { owners: [beta(50)], occupancyType: 'vacant' }),
      mkUnit('pB', { owners: [beta(50)], occupancyType: 'vacant' }),
      mkUnit('pC', { owners: [beta(50)], occupancyType: 'vacant' }),
      mkUnit('pD', { owners: [beta(50)], occupancyType: 'vacant' }),
      mkUnit('pE', { owners: [beta(100)], occupancyType: 'vacant' }),
      mkUnit('pF', { owners: [beta(100)], occupancyType: 'vacant' })
    ],
    expenses: [
      {
        _id: 'water',
        name: 'Κοινόχρηστο Νερό',
        type: 'water_common',
        amount: 0,
        ownerAmount: 100,
        trackOwnerExpense: true,
        chargeOwnerWhenVacant: false, // owner-fixed is owner-only, flag-independent
        allocationMethod: 'equal',
        isRecurring: true,
        startTerm: 2026010100
      }
    ],
    repairs: [],
    ownerMonthlyExpenses: omeArray([])
  });

  it('writes PER-UNIT owner-fixed rows whose Σ === ownerAmount (no building-wide lump)', async () => {
    TENANTS = [];
    const building = mkBuilding();
    const T = term(6, 2026);
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    const fixedRows = building.ownerMonthlyExpenses.filter(
      (r) => r.source === 'owner-fixed' && Number(r.term) === T
    );
    // One row per unit (6), each propertyId-scoped — NOT one null-propertyId lump.
    expect(fixedRows.length).toBe(6);
    expect(fixedRows.every((r) => !!r.propertyId)).toBe(true);
    const sum = fixedRows.reduce((s, r) => s + r.amount, 0);
    expect(sum).toBeCloseTo(100, 2); // conservation
  });

  it('ledger bills ΒΗΤΑ only her real share (< full €100, == Σ of her per-unit slices)', async () => {
    TENANTS = [];
    const building = mkBuilding();
    const T = term(6, 2026);
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    // Plain copy for the reader (the reader resolves owners from units[].owners).
    const plain = JSON.parse(JSON.stringify(building));
    plain.ownerMonthlyExpenses = building.ownerMonthlyExpenses.map((r) => ({
      ...r
    }));
    const map = _aggregateOwners([plain], new Set());
    const s = _serializeOwnerSummary(map.get(ownerKeyOf(beta(50))));
    // Her share: 100% units bill their full per-unit share; 50% units bill half
    // (the other half is the absent co-owner's, billed to nobody). So strictly
    // less than the full €100, and strictly more than €50 (she fully owns 2 of 6
    // units). Equality to the slice arithmetic: 4 units × (share/2) + 2 × share.
    expect(s.totalAmount).toBeGreaterThan(50);
    expect(s.totalAmount).toBeLessThan(100);
    // Reconstruct expected from the persisted per-unit rows + her declared %.
    // Round EACH per-unit slice (mirrors ownerSlicesOf's per-row rounding) so
    // the reconstruction matches the ledger's cent-exact aggregation — a naive
    // unrounded Σ drifts a cent or two from the per-row-rounded ledger total.
    const fixedRows = building.ownerMonthlyExpenses.filter(
      (r) => r.source === 'owner-fixed' && Number(r.term) === T
    );
    const unitPct = { pA: 50, pB: 50, pC: 50, pD: 50, pE: 100, pF: 100 };
    const expected =
      Math.round(
        fixedRows.reduce(
          (acc, r) =>
            acc + Math.round(r.amount * (unitPct[r.propertyId] / 100) * 100) / 100,
          0
        ) * 100
      ) / 100;
    expect(s.totalAmount).toBeCloseTo(expected, 2);
  });

  it('dashboard eksoda still totals the FULL ownerAmount for the building (no double-count, no loss)', async () => {
    TENANTS = [];
    const building = mkBuilding();
    const T = term(6, 2026);
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    const { owedByTerm } = await computeOwnerEksodaByMonth('r1', building, 2026);
    // The building-level liability is the full €100 (per-unit rows sum back up);
    // the per-owner split is a LEDGER concern, not a building-total concern.
    expect(owedByTerm.get(T) || 0).toBeCloseTo(100, 2);
  });

  it('a recorded καταβολή on the legacy building-wide owner-fixed lump migrates onto the per-unit rows (no money lost)', async () => {
    TENANTS = [];
    const building = mkBuilding();
    const T = term(6, 2026);
    // Simulate legacy state: one building-wide owner-fixed lump with €30 paid.
    building.ownerMonthlyExpenses.push({
      expenseId: 'water',
      term: T,
      amount: 100,
      propertyId: null,
      source: 'owner-fixed',
      description: 'Κοινόχρηστο Νερό',
      payments: [recordedPayment(30)]
    });
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    // The €30 must survive, re-applied across the per-unit rows. Total cash on
    // the expense's owner-fixed rows === €30, and there is no surviving lump.
    expect(cashFor(building, 'water')).toBe(30);
    const lump = building.ownerMonthlyExpenses.find(
      (r) => r.source === 'owner-fixed' && !r.propertyId && Number(r.term) === T
    );
    expect(lump).toBeUndefined();
  });
});

// ── Step-7 adversarial fixes: owner-amount per-unit materialisation hardening ──
describe('owner-fixed per-unit materialisation — Step-7 hardening', () => {
  const ownerOf = (name, pct) => ({ name, taxId: `tx_${name}`, percentage: pct });

  // #1/#2 CRITICAL: a FIXED-allocation expense stores customAllocations for the
  // TENANT amount. Splitting the ownerAmount by 'fixed' would bill each unit its
  // tenant figure (Σ === tenant total, not ownerAmount). It MUST split equally.
  it('#1/#2: fixed-method owner amount splits EQUALLY (not by tenant customAllocations)', async () => {
    TENANTS = [];
    const T = term(6, 2026);
    const building = {
      _id: 'b_fx', realmId: 'r1', name: 'FX',
      units: [
        mkUnit('p1', { owners: [ownerOf('A', 100)], occupancyType: 'vacant' }),
        mkUnit('p2', { owners: [ownerOf('B', 100)], occupancyType: 'vacant' }),
        mkUnit('p3', { owners: [ownerOf('C', 100)], occupancyType: 'vacant' })
      ],
      expenses: [
        {
          _id: 'clean', name: 'Καθαριότητα', type: 'cleaning',
          amount: 300, // tenant fixed total
          allocationMethod: 'fixed',
          customAllocations: [
            { propertyId: 'p1', value: 100 },
            { propertyId: 'p2', value: 100 },
            { propertyId: 'p3', value: 100 }
          ],
          ownerAmount: 60, // owner-only fixed amount — MUST split €20/€20/€20
          trackOwnerExpense: true,
          isRecurring: true,
          startTerm: 2026010100
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: omeArray([])
    };
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    const fixedRows = building.ownerMonthlyExpenses.filter(
      (r) => r.source === 'owner-fixed' && Number(r.term) === T
    );
    const sum = fixedRows.reduce((s, r) => s + r.amount, 0);
    expect(sum).toBeCloseTo(60, 2); // NOT €300 (the tenant customAllocations)
    fixedRows.forEach((r) => expect(r.amount).toBeCloseTo(20, 2));
    const { owedByTerm } = await computeOwnerEksodaByMonth('r1', building, 2026);
    expect(owedByTerm.get(T) || 0).toBeCloseTo(60, 2);
  });

  // #6/#10/#12 HIGH: the owner amount must split per UNIT, not per tenant PARTY.
  // A single tenant renting 2 units collapses them into ONE equal-party on the
  // tenant allocator → one unit's owner billed €0, the carrier's double-billed.
  it('#6/#10/#12: equal owner amount splits per UNIT even when one tenant rents two units', async () => {
    const T = term(6, 2026);
    // Tenant T1 rents p1 + p2 (one tenant group); p3 vacant. Distinct owners.
    TENANTS = [
      {
        _id: 't1', beginDate: '2026-01-01', endDate: '2027-01-01',
        properties: [
          { propertyId: 'p1', entryDate: '2026-01-01' },
          { propertyId: 'p2', entryDate: '2026-01-01' }
        ]
      }
    ];
    const building = {
      _id: 'b_mu', realmId: 'r1', name: 'MU',
      units: [
        mkUnit('p1', { owners: [ownerOf('A', 100)], occupancyType: 'occupied' }),
        mkUnit('p2', { owners: [ownerOf('B', 100)], occupancyType: 'occupied' }),
        mkUnit('p3', { owners: [ownerOf('C', 100)], occupancyType: 'vacant' })
      ],
      expenses: [
        {
          _id: 'mgmt', name: 'Διαχείριση', type: 'management',
          amount: 0, allocationMethod: 'equal',
          ownerAmount: 90, // owner-only — MUST split €30/€30/€30 by UNIT
          trackOwnerExpense: true, isRecurring: true, startTerm: 2026010100
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: omeArray([])
    };
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    const fixedRows = building.ownerMonthlyExpenses.filter(
      (r) => r.source === 'owner-fixed' && Number(r.term) === T
    );
    // One row per managed unit (3), €30 each — NOT €45/€45 on two carriers.
    expect(fixedRows.length).toBe(3);
    fixedRows.forEach((r) => expect(r.amount).toBeCloseTo(30, 2));
    const byPid = Object.fromEntries(fixedRows.map((r) => [r.propertyId, r.amount]));
    expect(byPid.p1).toBeCloseTo(30, 2);
    expect(byPid.p2).toBeCloseTo(30, 2); // the non-carrier unit is NOT €0
    expect(byPid.p3).toBeCloseTo(30, 2);
    // Each owner billed their own unit's €30 on the ledger.
    const map = _aggregateOwners(
      [JSON.parse(JSON.stringify(building))],
      new Set()
    );
    expect(_serializeOwnerSummary(map.get(ownerKeyOf(ownerOf('B', 100)))).totalAmount).toBeCloseTo(30, 2);
  });

  // #4 HIGH: a legacy lump holding MORE than the (now-lowered) ownerAmount must
  // not lose the undrained overpayment — it survives as a credit row.
  it('#4: undrained legacy overpayment survives as a credit (no money lost)', async () => {
    TENANTS = [];
    const T = term(6, 2026);
    const building = {
      _id: 'b_op', realmId: 'r1', name: 'OP',
      units: [mkUnit('p1', { owners: [ownerOf('A', 100)], occupancyType: 'vacant' })],
      expenses: [
        {
          _id: 'w', name: 'Νερό', type: 'water_common',
          amount: 0, allocationMethod: 'equal',
          ownerAmount: 60, // lowered from a prior €100
          trackOwnerExpense: true, isRecurring: true, startTerm: 2026010100
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: omeArray([
        {
          expenseId: 'w', term: T, amount: 100, propertyId: null,
          source: 'owner-fixed', description: 'Νερό', payments: [recordedPayment(100)]
        }
      ])
    };
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    // The full €100 recorded must survive: €60 on the per-unit owner-fixed row +
    // €40 preserved on a credit row. Total cash on the expense === €100.
    expect(cashFor(building, 'w')).toBe(100);
    const credit = building.ownerMonthlyExpenses.find(
      (r) => r.source === 'credit' && String(r.expenseId) === 'w'
    );
    expect(credit).toBeTruthy();
    expect(paymentsTotal(credit)).toBeCloseTo(40, 2);
  });

  // #8/#13 HIGH/MED: a per-unit owner-fixed row must NOT suppress the DISTINCT
  // owner-resident/vacant building-expense gap-fill for the same (expense, unit,
  // term) on the dashboard. An expense that is BOTH trackOwnerExpense AND has a
  // tenant amount on an owner-occupied unit owes BOTH the fixed owner amount AND
  // the tenant-amount share.
  it('#8/#13: owner-fixed per-unit row does not suppress the owner-resident gap-fill (dashboard counts both)', async () => {
    const T = term(6, 2026);
    TENANTS = []; // p1 is owner-occupied, not tenant-rented
    const building = {
      _id: 'b_both', realmId: 'r1', name: 'BOTH',
      units: [
        mkUnit('p1', { owners: [ownerOf('A', 100)], occupancyType: 'owner_occupied' })
      ],
      expenses: [
        {
          _id: 'e', name: 'Νερό', type: 'water_common',
          amount: 60, // tenant amount (→ owner-resident share for the owner-occupied unit)
          allocationMethod: 'equal',
          ownerAmount: 60, // fixed owner-only amount
          trackOwnerExpense: true,
          chargeOwnerWhenVacant: false,
          isRecurring: true, startTerm: 2026010100
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: omeArray([])
    };
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    const { owedByTerm } = await computeOwnerEksodaByMonth('r1', building, 2026);
    // €60 owner-fixed + €60 owner-resident building-expense share = €120.
    expect(owedByTerm.get(T) || 0).toBeCloseTo(120, 2);
  });

  // ── Step-7 ROUND 2 fixes ──

  // #7/#10: custom_percentage owner amount must allocate per-unit by the
  // expense's customAllocations (NOT fall back to a building-wide lump that
  // dumps the full amount on the canonical owner).
  it('#7/#10: custom_percentage owner amount allocates per-unit (not a building-wide lump)', async () => {
    TENANTS = [];
    const T = term(6, 2026);
    const building = {
      _id: 'b_cp', realmId: 'r1', name: 'CP',
      units: [
        mkUnit('p1', { owners: [ownerOf('A', 100)], occupancyType: 'vacant' }),
        mkUnit('p2', { owners: [ownerOf('B', 100)], occupancyType: 'vacant' })
      ],
      expenses: [
        {
          _id: 'cp', name: 'Ασφάλιση', type: 'insurance',
          amount: 0, allocationMethod: 'custom_percentage',
          customAllocations: [
            { propertyId: 'p1', value: 70 },
            { propertyId: 'p2', value: 30 }
          ],
          ownerAmount: 100, trackOwnerExpense: true, isRecurring: true,
          startTerm: 2026010100
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: omeArray([])
    };
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    const rows = building.ownerMonthlyExpenses.filter(
      (r) => r.source === 'owner-fixed' && Number(r.term) === T
    );
    // Per-unit: €70 (p1, 70%) + €30 (p2, 30%) = €100; NOT one null-pid lump.
    expect(rows.length).toBe(2);
    expect(rows.every((r) => !!r.propertyId)).toBe(true);
    const byPid = Object.fromEntries(rows.map((r) => [r.propertyId, r.amount]));
    expect(byPid.p1).toBeCloseTo(70, 2);
    expect(byPid.p2).toBeCloseTo(30, 2);
  });

  // #1/#4: the PDF statement (buildOwnerStatement) MUST mirror the ledger
  // (_aggregateOwners) for tagged payments — a co-owner who didn't pay must show
  // OUTSTANDING on BOTH surfaces, not paid on the PDF.
  it('#1/#4: tagged co-owner payment → ledger and PDF agree (non-payer still owes)', async () => {
    TENANTS = [];
    const T = term(6, 2026);
    const A = ownerOf('A', 60);
    const B = ownerOf('B', 40);
    const building = {
      _id: 'b_tag', realmId: 'r1', name: 'TAG',
      units: [mkUnit('p1', { owners: [A, B], occupancyType: 'vacant' })],
      expenses: [
        {
          _id: 'w', name: 'Νερό', type: 'water_common',
          amount: 0, allocationMethod: 'equal',
          ownerAmount: 100, trackOwnerExpense: true, isRecurring: true,
          startTerm: 2026010100
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: omeArray([])
    };
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    // Owner A pays €60 (their full slice), TAGGED to A.
    const row = building.ownerMonthlyExpenses.find(
      (r) => r.source === 'owner-fixed' && String(r.propertyId) === 'p1'
    );
    row.payments = [
      { _id: 'payA', amount: 60, date: '15/06/2026', type: 'transfer', ownerKey: ownerKeyOf(A) }
    ];
    const plain = JSON.parse(JSON.stringify(building));
    const map = _aggregateOwners([plain], new Set());
    const ledgerA = _serializeOwnerSummary(map.get(ownerKeyOf(A)));
    const ledgerB = _serializeOwnerSummary(map.get(ownerKeyOf(B)));
    const pdfA = buildOwnerStatement([plain], ownerKeyOf(A), []);
    const pdfB = buildOwnerStatement([plain], ownerKeyOf(B), []);
    // Ledger: A paid €60 owes €0; B paid €0 owes €40.
    expect(ledgerA.totalPaid).toBeCloseTo(60, 2);
    expect(ledgerA.totalOutstanding).toBeCloseTo(0, 2);
    expect(ledgerB.totalPaid).toBeCloseTo(0, 2);
    expect(ledgerB.totalOutstanding).toBeCloseTo(40, 2);
    // PDF MUST agree to the cent — B is NOT shown as paid.
    expect(pdfA.totals.paid).toBeCloseTo(ledgerA.totalPaid, 2);
    expect(pdfA.totals.outstanding).toBeCloseTo(ledgerA.totalOutstanding, 2);
    expect(pdfB.totals.paid).toBeCloseTo(ledgerB.totalPaid, 2);
    expect(pdfB.totals.outstanding).toBeCloseTo(ledgerB.totalOutstanding, 2);
  });

  // #8/#9: a bare manual-paid toggle (paid=true, no payments) on a legacy
  // building-wide owner-fixed lump must survive the per-unit migration — the
  // settled liability must NOT silently re-open.
  it('#8/#9: manual paid toggle survives the legacy lump → per-unit migration', async () => {
    TENANTS = [];
    const T = term(6, 2026);
    const building = {
      _id: 'b_mp', realmId: 'r1', name: 'MP',
      units: [
        mkUnit('p1', { owners: [ownerOf('A', 100)], occupancyType: 'vacant' }),
        mkUnit('p2', { owners: [ownerOf('A', 100)], occupancyType: 'vacant' })
      ],
      expenses: [
        {
          _id: 'w', name: 'Νερό', type: 'water_common',
          amount: 0, allocationMethod: 'equal',
          ownerAmount: 100, trackOwnerExpense: true, isRecurring: true,
          startTerm: 2026010100
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: omeArray([
        // legacy lump marked paid via the toggle: paid=true, EMPTY payments.
        {
          expenseId: 'w', term: T, amount: 100, propertyId: null,
          source: 'owner-fixed', description: 'Νερό', payments: [], paid: true,
          paidDate: new Date('2026-06-10')
        }
      ])
    };
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    const rows = building.ownerMonthlyExpenses.filter(
      (r) => r.source === 'owner-fixed' && Number(r.term) === T
    );
    expect(rows.length).toBe(2);
    // Every per-unit row must remain marked paid (the settled state survived).
    expect(rows.every((r) => r.paid === true)).toBe(true);
    const { owedByTerm, paidByTerm } = await computeOwnerEksodaByMonth('r1', building, 2026);
    expect(owedByTerm.get(T) || 0).toBeCloseTo(100, 2);
    expect(paidByTerm.get(T) || 0).toBeCloseTo(100, 2); // still fully settled
  });

  // ── Step-7 ROUND 3 fixes ──

  // #3: custom_percentage allocations summing to <100% are INTENTIONALLY partial
  // (the tenant engine leaves the remainder unbilled). The owner-fixed snap must
  // NOT force the gap onto one unit — it bills each unit its own %, gap unbilled.
  it('#3: custom_percentage <100% owner amount does NOT dump the gap onto one unit', async () => {
    TENANTS = [];
    const T = term(6, 2026);
    const building = {
      _id: 'b_cp2', realmId: 'r1', name: 'CP2',
      units: [
        mkUnit('p1', { owners: [ownerOf('A', 100)], occupancyType: 'vacant' }),
        mkUnit('p2', { owners: [ownerOf('B', 100)], occupancyType: 'vacant' })
      ],
      expenses: [
        {
          _id: 'cp', name: 'Ασφάλιση', type: 'insurance',
          amount: 0, allocationMethod: 'custom_percentage',
          // sums to 60% — deliberately partial (40% unbilled)
          customAllocations: [
            { propertyId: 'p1', value: 40 },
            { propertyId: 'p2', value: 20 }
          ],
          ownerAmount: 100, trackOwnerExpense: true, isRecurring: true,
          startTerm: 2026010100
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: omeArray([])
    };
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    const rows = building.ownerMonthlyExpenses.filter(
      (r) => r.source === 'owner-fixed' && Number(r.term) === T
    );
    const byPid = Object.fromEntries(rows.map((r) => [r.propertyId, r.amount]));
    // p1 = 40% of €100 = €40; p2 = 20% = €20. The 40% gap (€40) stays UNBILLED
    // — NOT snapped onto p1 (which would make it €80, mis-billing owner A).
    expect(byPid.p1).toBeCloseTo(40, 2);
    expect(byPid.p2).toBeCloseTo(20, 2);
    const total = rows.reduce((s, r) => s + r.amount, 0);
    expect(total).toBeCloseTo(60, 2); // partial by design, NOT forced to 100
  });

  // #1 (round 3): an owner-fixed overpay credit must NOT cross-net a DISTINCT
  // vacant liability. The credit is building-level (propertyId null) so it stands
  // alone; the vacant row keeps its full outstanding.
  it('#1(r3): overpay credit does not cross-net a distinct vacant liability', async () => {
    TENANTS = [];
    const T = term(6, 2026);
    const building = {
      _id: 'b_xn', realmId: 'r1', name: 'XN',
      units: [
        mkUnit('p1', { owners: [ownerOf('A', 100)], occupancyType: 'vacant' })
      ],
      expenses: [
        {
          _id: 'e', name: 'Νερό', type: 'water_common',
          amount: 80, // tenant amount → vacant owner share when flag on
          allocationMethod: 'equal',
          ownerAmount: 50, // fixed owner amount
          trackOwnerExpense: true,
          chargeOwnerWhenVacant: true,
          isRecurring: true, startTerm: 2026010100
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: omeArray([
        // legacy owner-fixed lump overpaid €70 (now ownerAmount is €50).
        {
          expenseId: 'e', term: T, amount: 50, propertyId: null,
          source: 'owner-fixed', description: 'Νερό', payments: [recordedPayment(70)]
        }
      ])
    };
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    // owner-fixed per-unit row p1 = €50 (paid €50); credit (null pid) = €20 paid;
    // vacant row p1 = €80 (paid €0) — the €20 credit must NOT pay down the vacant.
    const plain = JSON.parse(JSON.stringify(building));
    const map = _aggregateOwners([plain], new Set());
    const s = _serializeOwnerSummary(map.get(ownerKeyOf(ownerOf('A', 100))));
    // owed: €50 owner-fixed + €80 vacant = €130; paid €70 (€50 fixed + €20 credit).
    // outstanding: vacant €80 stays (credit can't touch it) → €80, NOT €60.
    expect(s.totalOutstanding).toBeCloseTo(80, 2);
  });

  // #1 (round 4): thousandths owner amount must be CONSERVED across MANAGED units
  // — an UNMANAGED unit carrying thousandths must NOT silently absorb part of the
  // owner amount (the tenant engine's full-building denominator leaked it).
  it('#1(r4): thousandths owner amount conserves across managed units (unmanaged unit does not leak it)', async () => {
    TENANTS = [];
    const T = term(6, 2026);
    const building = {
      _id: 'b_th', realmId: 'r1', name: 'TH',
      units: [
        mkUnit('p1', { owners: [ownerOf('A', 100)], occupancyType: 'vacant', generalThousandths: 400 }),
        mkUnit('p2', { owners: [ownerOf('B', 100)], occupancyType: 'vacant', generalThousandths: 400 }),
        // UNMANAGED unit (no propertyId) carrying 200‰ — must not absorb owner €.
        { _id: 'u_unmanaged', generalThousandths: 200 }
      ],
      expenses: [
        {
          _id: 'th', name: 'Κοινόχρηστα', type: 'common',
          amount: 0, allocationMethod: 'general_thousandths',
          ownerAmount: 100, trackOwnerExpense: true, isRecurring: true,
          startTerm: 2026010100
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: omeArray([])
    };
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    const rows = building.ownerMonthlyExpenses.filter(
      (r) => r.source === 'owner-fixed' && Number(r.term) === T
    );
    const sum = rows.reduce((s, r) => s + r.amount, 0);
    // €100 must be split €50/€50 across the two MANAGED units (400/800, 400/800),
    // NOT €40/€40 with €20 leaking to the unmanaged unit.
    expect(sum).toBeCloseTo(100, 2);
    const byPid = Object.fromEntries(rows.map((r) => [r.propertyId, r.amount]));
    expect(byPid.p1).toBeCloseTo(50, 2);
    expect(byPid.p2).toBeCloseTo(50, 2);
  });

  // #2 (round 4): a per-unit owner-fixed row on a managed unit with EMPTY
  // owners[] (legacy/E9-corrupt — the real Beta realm shape) must NOT slice by
  // a borrowed building-owner %; it keeps the FULL per-unit amount on the
  // canonical building owner so the ledger matches the dashboard/panel.
  it('#2(r4): per-unit row on an unowned unit keeps full amount (no borrowed-% mis-attribution)', async () => {
    TENANTS = [];
    const T = term(6, 2026);
    const A = ownerOf('A', 50); // declared 50% on her own unit (co-owner absent)
    const building = {
      _id: 'b_unowned', realmId: 'r1', name: 'UNOWNED',
      units: [
        mkUnit('p1', { owners: [A], occupancyType: 'vacant' }),
        // p2 managed but owners[] EMPTY (import dropped the owner).
        mkUnit('p2', { owners: [], occupancyType: 'vacant' })
      ],
      expenses: [
        {
          _id: 'w', name: 'Νερό', type: 'water_common',
          amount: 0, allocationMethod: 'equal',
          ownerAmount: 100, trackOwnerExpense: true, isRecurring: true,
          startTerm: 2026010100
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: omeArray([])
    };
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    // Per-unit: €50 each. p1 → A 50% (co-owner absent) → she owes €25. p2 has no
    // owner → it falls back to the building set [A], but sliceFromUnit is false
    // for p2, so it keeps the FULL €50 on A (NOT a €25 borrowed-% slice).
    const plain = JSON.parse(JSON.stringify(building));
    const map = _aggregateOwners([plain], new Set());
    const s = _serializeOwnerSummary(map.get(ownerKeyOf(A)));
    // p1: €25 (her real 50% slice) + p2: €50 (full, unowned → canonical) = €75.
    // If p2 wrongly sliced by her borrowed 50% it'd be €25 → total €50 (wrong).
    expect(s.totalAmount).toBeCloseTo(75, 2);
  });

  // ── Step-7 ROUND 5 fixes ──

  // #1/#3: a single_unit owner-fixed RETARGET after a payment must ROUTE the
  // payment to the NEW target unit (not strand a credit on the old unit) so the
  // ledger, PDF and dashboard all agree — owner shows €0 outstanding (paid).
  it('#1/#3(r5): single_unit owner-fixed retarget routes the payment to the new unit (all surfaces agree)', async () => {
    TENANTS = [];
    const T = term(6, 2026);
    const A = ownerOf('A', 100);
    const building = {
      _id: 'b_rt', realmId: 'r1', name: 'RT',
      units: [
        mkUnit('pA', { owners: [A], occupancyType: 'vacant' }),
        mkUnit('pB', { owners: [A], occupancyType: 'vacant' })
      ],
      expenses: [
        {
          _id: 'w', name: 'Νερό', type: 'water_common',
          amount: 0, allocationMethod: 'single_unit',
          customAllocations: [{ propertyId: 'pA', value: 1 }],
          ownerAmount: 100, trackOwnerExpense: true, isRecurring: true,
          startTerm: 2026010100
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: omeArray([])
    };
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    // Owner pays €100 on pA (tagged to A).
    const rowA = building.ownerMonthlyExpenses.find(
      (r) => r.source === 'owner-fixed' && String(r.propertyId) === 'pA'
    );
    expect(rowA).toBeTruthy();
    rowA.payments = [
      { _id: 'payA', amount: 100, date: '15/06/2026', type: 'transfer', ownerKey: ownerKeyOf(A) }
    ];
    // Retarget single_unit pA → pB; recompute.
    building.expenses[0].customAllocations = [{ propertyId: 'pB', value: 1 }];
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    // The €100 payment must now sit on pB's row (the live liability), NOT strand
    // as a credit on pA. Total cash preserved; owner fully settled on every
    // surface.
    expect(cashFor(building, 'w')).toBe(100);
    const rows = building.ownerMonthlyExpenses.filter(
      (r) => r.source === 'owner-fixed' && Number(r.term) === T
    );
    expect(rows.length).toBe(1); // only pB
    expect(String(rows[0].propertyId)).toBe('pB');
    expect(paymentsTotal(rows[0])).toBeCloseTo(100, 2);
    const plain = JSON.parse(JSON.stringify(building));
    const map = _aggregateOwners([plain], new Set());
    const s = _serializeOwnerSummary(map.get(ownerKeyOf(A)));
    expect(s.totalOutstanding).toBeCloseTo(0, 2); // fully settled, no phantom
    const { owedByTerm, paidByTerm } = await computeOwnerEksodaByMonth('r1', building, 2026);
    expect((owedByTerm.get(T) || 0) - (paidByTerm.get(T) || 0)).toBeCloseTo(0, 2);
  });

  // #2(r5): an owner-fixed/expense overpay CREDIT must NOT net a DISTINCT vacant
  // building-expense liability that shares the same expenseId|term|propertyId.
  it('#2(r5): owner-amount credit does not net a distinct vacant liability (PDF/ledger)', () => {
    const owner = { name: 'A', taxId: '1' };
    const buildings = [
      {
        _id: 'b1', name: 'B',
        expenses: [
          { _id: 'e1', type: 'water_common', isRecurring: true, startTerm: 2026010100, chargeOwnerWhenVacant: true }
        ],
        units: [mkUnit('p1', { owners: [owner] })],
        ownerMonthlyExpenses: [
          // owner-amount overpay credit on the unit (€20 preserved).
          { _id: 'c', expenseId: 'e1', term: 2026060100, amount: 0, propertyId: 'p1', source: 'credit', paid: true, payments: [{ amount: 20, date: '2026-06-01', type: 'cash' }] },
          // DISTINCT vacant building-expense share €15 genuinely unpaid.
          { _id: 'v', expenseId: 'e1', term: 2026060100, amount: 15, propertyId: 'p1', source: 'vacant', paid: false, payments: [] }
        ]
      }
    ];
    const st = buildOwnerStatement(buildings, ownerKeyOf(owner), []);
    // The €15 vacant share must STILL be outstanding — the €20 owner-amount
    // credit belongs to a different obligation and cannot settle it.
    expect(st.totals.outstanding).toBeCloseTo(15, 2);
  });

  // ── Step-7 ROUND 6 fixes ──

  // #1(r6) CRITICAL: a single_unit retarget where the two units have DIFFERENT
  // owners must NOT move BETA's payment onto ALPHA's unit. BETA's money stays a
  // credit on her own (old) unit; ALPHA's new liability is NOT falsely credited.
  it('#1(r6): retarget across DISTINCT owners does not mis-attribute the payment', async () => {
    TENANTS = [];
    const T = term(6, 2026);
    const ALPHA = { name: 'ALPHA', taxId: 'A1', percentage: 100 };
    const BETA = { name: 'BETA', taxId: 'B1', percentage: 100 };
    const building = {
      _id: 'b_xowner', realmId: 'r1', name: 'XOWNER',
      units: [
        mkUnit('p1', { owners: [ALPHA], occupancyType: 'vacant' }),
        mkUnit('p2', { owners: [BETA], occupancyType: 'vacant' })
      ],
      expenses: [
        {
          _id: 'w', name: 'Νερό', type: 'water_common',
          amount: 0, allocationMethod: 'single_unit',
          customAllocations: [{ propertyId: 'p2', value: 1 }],
          ownerAmount: 100, trackOwnerExpense: true, isRecurring: true,
          startTerm: 2026010100
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: omeArray([])
    };
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    // BETA pays €100 on p2 (tagged to BETA).
    const rowB = building.ownerMonthlyExpenses.find(
      (r) => r.source === 'owner-fixed' && String(r.propertyId) === 'p2'
    );
    rowB.payments = [
      { _id: 'payB', amount: 100, date: '15/06/2026', type: 'transfer', ownerKey: ownerKeyOf(BETA) }
    ];
    // Retarget single_unit p2 → p1 (ALPHA's unit); recompute.
    building.expenses[0].customAllocations = [{ propertyId: 'p1', value: 1 }];
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    const plain = JSON.parse(JSON.stringify(building));
    const map = _aggregateOwners([plain], new Set());
    const sAlpha = _serializeOwnerSummary(map.get(ownerKeyOf(ALPHA)));
    const sBeta = _serializeOwnerSummary(map.get(ownerKeyOf(BETA)));
    // ALPHA owes €100 (the new liability) and is NOT credited BETA's money.
    expect(sAlpha.totalOutstanding).toBeCloseTo(100, 2);
    // BETA's €100 survives as her credit (paid), not erased.
    expect(sBeta.totalPaid).toBeCloseTo(100, 2);
    // Total recorded money is conserved across the building.
    expect(cashFor(building, 'w')).toBe(100);
  });

  // #2/#3(r6): the dashboard PAID must match the ledger/PDF for an OVERPAID
  // owner-fixed row (ownerAmount reduced after a full-share payment) — no
  // Math.min(...,amount) clamp that under-reports recorded money.
  it('#2/#3(r6): dashboard paid matches ledger for an overpaid owner-fixed row', async () => {
    TENANTS = [];
    const T = term(6, 2026);
    const A = ownerOf('A', 100);
    const building = {
      _id: 'b_op2', realmId: 'r1', name: 'OP2',
      units: [mkUnit('p1', { owners: [A], occupancyType: 'vacant' })],
      expenses: [
        {
          _id: 'w', name: 'Νερό', type: 'water_common',
          amount: 0, allocationMethod: 'equal',
          ownerAmount: 60, // reduced from a prior €100 that was paid in full
          trackOwnerExpense: true, isRecurring: true, startTerm: 2026010100
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: omeArray([
        // prior per-unit row €100 paid in full (no building-wide lump to pool).
        {
          expenseId: 'w', term: T, amount: 100, propertyId: 'p1',
          source: 'owner-fixed', description: 'Νερό',
          payments: [{ amount: 100, date: '10/06/2026', type: 'transfer', ownerKey: ownerKeyOf(A) }]
        }
      ])
    };
    await _recomputeVacantOwnerCharges(building, 'r1', T);
    const plain = JSON.parse(JSON.stringify(building));
    const map = _aggregateOwners([plain], new Set());
    const ledgerPaid = _serializeOwnerSummary(map.get(ownerKeyOf(A))).totalPaid;
    const { paidByTerm } = await computeOwnerEksodaByMonth('r1', building, 2026);
    // Both surfaces report the FULL €100 recorded (not €60 clamped). Cross-
    // surface paid agreement is the invariant (overpay floors outstanding at 0).
    expect(ledgerPaid).toBeCloseTo(100, 2);
    expect(paidByTerm.get(T) || 0).toBeCloseTo(ledgerPaid, 2);
  });
});
