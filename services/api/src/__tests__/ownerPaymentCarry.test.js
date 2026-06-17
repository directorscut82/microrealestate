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
});

beforeEach(() => {
  TENANTS = [];
});

function omeArray(initial = []) {
  const arr = [...initial];
  arr.pull = function (id) {
    const i = this.findIndex((e) => String(e._id) === String(id));
    if (i >= 0) this.splice(i, 1);
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
});
