/* eslint-env node, jest */
/**
 * REPAIR on an OWNER-OCCUPIED unit (the resident-owner bug).
 *
 * Before the fix: _distributeRepairCharge built its occupied set from tenant
 * records ONLY, so an owner-occupied unit (no tenant) was treated as VACANT.
 * With chargeOwnerWhenVacant OFF (the default) the repair's tenant-share
 * EVAPORATED — billed to nobody, on no ledger, real money lost. With the flag
 * ON it landed but the money was correct only by luck.
 *
 * After the fix: an owner-occupied unit's repair tenant-share is billed to the
 * owner FLAG-INDEPENDENTLY (the owner lives there — it's their own cost),
 * reusing the well-tested source:'repair-vacant' owner-ledger row so every
 * reader already bills + per-owner-slices it and it survives the expense
 * recompute.
 *
 * type: module → jest.unstable_mockModule + dynamic import.
 */
import { jest } from '@jest/globals';

let TENANTS = [];
let _distributeRepairCharge;

beforeAll(async () => {
  class ServiceError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
  const OwnerStatement = await import('../../../common/src/utils/ownerstatement.ts');
  const ShareBasis = await import('../../../common/src/utils/sharebasis.ts');
  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: { Tenant: { find: () => ({ lean: async () => TENANTS }) } },
      // billmanager + telegramInboxScanner now take the charge month and the
      // bill-term fit from the shared rule, so this factory must provide it.
      // unstable_mockModule replaces the WHOLE module: an export the graph consumes
      // but the factory omits is `undefined` at call time, which surfaces as a
      // TypeError deep inside rather than a resolution error.
      BillTerm: {
        billTermFitsExpense: () => ({ fits: true }),
        billTermIsOutsideExpense: () => false,
        computeChargeTerm: (b) => {
          const d = new Date(b?.issueDate || b?.periodEnd);
          return Number.isFinite(d.getTime())
            ? d.getUTCFullYear() * 1000000 + (d.getUTCMonth() + 1) * 10000 + 100
            : undefined;
        }
      },
    logger: { warn() {}, info() {}, error() {} },
    ServiceError,
    OwnerStatement,
    ShareBasis
  }));
  jest.unstable_mockModule('../managers/occupantmanager.js', () => ({
    _attachTenantGroupsToBuildings: async (_realmId, buildings) => {
      buildings.forEach((b) => (b._tenantGroups = []));
    }
  }));
  ({ _distributeRepairCharge } = await import('../managers/buildingmanager.js'));
});

beforeEach(() => {
  TENANTS = [];
});

let _seq = 0;
function omeArray(initial = []) {
  const arr = initial.map((x) => ({ _id: x._id || `ome_${++_seq}`, ...x }));
  arr.pull = function (id) {
    const i = this.findIndex((e) => String(e._id) === String(id));
    if (i >= 0) this.splice(i, 1);
  };
  arr.push = function (row) {
    const withId = { _id: row._id || `ome_${++_seq}`, ...row };
    Array.prototype.push.call(this, withId);
    return withId;
  };
  return arr;
}
const mkUnit = (propertyId, extra = {}) => ({
  _id: `u_${propertyId}`,
  propertyId,
  isManaged: true,
  surface: 50,
  generalThousandths: 1000,
  heatingThousandths: 0,
  elevatorThousandths: 0,
  occupancyType: 'owner_occupied',
  owners: [{ name: 'ΒΗΤΑ', taxId: '000000000', percentage: 100 }],
  monthlyCharges: omeArray([]),
  ...extra
});
const mkBuilding = (over = {}) => ({
  _id: 'b_rep',
  realmId: 'r1',
  name: 'Rep',
  atakPrefix: '011172',
  units: [mkUnit('p1')],
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
const ownerRows = (b, repairId) =>
  b.ownerMonthlyExpenses.filter((r) => String(r.expenseId) === String(repairId));
const ownerTotal = (b, repairId) =>
  ownerRows(b, repairId).reduce((s, r) => s + (Number(r.amount) || 0), 0);

describe('repair tenant-share on an OWNER-OCCUPIED unit bills the owner', () => {
  it('chargeableTo=tenants 100%, flag OFF → owner row €100 (was: evaporated)', async () => {
    const building = mkBuilding();
    const repair = {
      _id: 'rep1',
      title: 'Ασανσέρ',
      chargeableTo: 'tenants',
      tenantSharePercentage: 100,
      allocationMethod: 'general_thousandths',
      chargeOwnerWhenVacant: false, // DEFAULT — the bug case
      actualCost: 100,
      chargeTerm: 2026060100,
      status: 'completed'
    };
    building.repairs = [repair];
    await _distributeRepairCharge(building, repair, 'r1');
    // The €100 tenant-share must be billed to the owner (not evaporate).
    expect(ownerTotal(building, 'rep1')).toBeCloseTo(100, 2);
    // And NOT written as a tenant monthlyCharge (no tenant to bill).
    expect(building.units[0].monthlyCharges.length).toBe(0);
    // Owner row carries the propertyId (per-unit, per-owner-sliceable).
    const rows = ownerRows(building, 'rep1');
    expect(rows.every((r) => String(r.propertyId) === 'p1')).toBe(true);
  });

  it('chargeableTo=split 60/40, flag OFF → owner gets tenant-share 60 + owner-portion 40 = 100', async () => {
    const building = mkBuilding();
    const repair = {
      _id: 'rep2',
      title: 'Στέγη',
      chargeableTo: 'split',
      tenantSharePercentage: 60,
      allocationMethod: 'general_thousandths',
      chargeOwnerWhenVacant: false,
      actualCost: 100,
      chargeTerm: 2026060100,
      status: 'completed'
    };
    building.repairs = [repair];
    await _distributeRepairCharge(building, repair, 'r1');
    // Owner bears the whole €100 for a unit they occupy: €40 owner-portion
    // (source 'repair') + €60 tenant-share (source 'repair-vacant', resident).
    expect(ownerTotal(building, 'rep2')).toBeCloseTo(100, 2);
    expect(building.units[0].monthlyCharges.length).toBe(0);
  });

  it('a rented unit (active tenant) still bills the TENANT, not the owner', async () => {
    // Guardrail: the fix must NOT hijack a genuinely-rented unit.
    TENANTS = [
      {
        _id: 't1',
        beginDate: new Date('2020-01-01'),
        endDate: new Date('2030-01-01'),
        terminationDate: null,
        properties: [{ propertyId: 'p1' }]
      }
    ];
    const building = mkBuilding({ units: [mkUnit('p1', { occupancyType: 'rented' })] });
    const repair = {
      _id: 'rep3',
      title: 'Ασανσέρ',
      chargeableTo: 'tenants',
      tenantSharePercentage: 100,
      allocationMethod: 'general_thousandths',
      chargeOwnerWhenVacant: false,
      actualCost: 100,
      chargeTerm: 2026060100,
      status: 'completed'
    };
    building.repairs = [repair];
    await _distributeRepairCharge(building, repair, 'r1');
    // The real regression risk: the owner-occupied fix must NOT hijack a
    // genuinely-rented unit into an owner 'repair-vacant' row. A rented unit's
    // tenant-share stays on the TENANT side, so the owner ledger has NO
    // repair-vacant row for it.
    const ownerTenantShareRows = ownerRows(building, 'rep3').filter(
      (r) => r.source === 'repair-vacant'
    );
    expect(ownerTenantShareRows.length).toBe(0);
  });
});
