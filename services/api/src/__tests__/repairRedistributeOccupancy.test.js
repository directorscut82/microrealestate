/* eslint-env node, jest */
// REPAIR-OCCUPANCY-STALENESS regression (ΟΔΟΣ ΗΤΑ 24 lift-repair bug).
//
// _distributeRepairCharge (the repair→rent writer) runs ONLY on repair
// add/edit. So when a tenant later occupies a unit that was vacant when a
// repair was distributed, the unit's repair share stays stuck in the
// vacant/owner bucket and is NEVER moved onto the new tenant's rent — the
// occupied tenant is silently under-billed. The fix wires a new
// `redistributeRepairsForProperties` into the tenant lifecycle (occupantmanager
// link/move/delete/extend) that re-fires the already-correct writer for every
// active repair on the affected building.
//
// This test drives the REAL redistributeRepairsForProperties through the
// occupancy transition and asserts the share moves between ledgers correctly,
// with no euro lost or double-counted.
//
// `type: module` package → use jest.unstable_mockModule + dynamic import.
import { jest } from '@jest/globals';
import moment from 'moment';

let redistributeRepairsForProperties;
let occupied; // mutable Set of occupied propertyIds the occupancy mock reads
let buildingStore; // the single in-memory building Collections.Building.find returns
let tenantRents; // optional { propertyId: rents[] } so a test can mark a term frozen-paid

const REPAIR_ID = 'rep_lift';
// The default repair charge term MUST be the CURRENT month, not a hardcoded
// past date. `_distributeRepairCharge`'s freeze guard treats any PAST term as
// frozen and bails before writing charges — so a literal past term (e.g.
// 2026060100) makes these "active repair distributes onto rent" tests rot into
// failures the moment wall-clock advances past that month. The sibling
// frozen-guard tests use `moment.utc().startOf('month')` for the current term;
// mirror that here so the base fixture is always an unfrozen, active month.
const TERM = Number(moment.utc().startOf('month').format('YYYYMMDDHH'));

beforeAll(async () => {
  // Mirror the REAL ServiceError shape: the HTTP code lives in `.statusCode`
  // (not `.status`). The 409-retry in redistributeRepairsForProperties reads
  // statusCode, so the mock must match or a retry test would silently pass on
  // the wrong field (Step-7 r3 medium: false confidence from a mismatched mock).
  class ServiceError extends Error {
    constructor(message, statusCode) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  // Tenants the occupancy reader sees. A unit is "occupied" for the term when a
  // tenant row covers it; we synthesize rows from the mutable `occupied` set so
  // the test can flip occupancy between distribution runs. Both call shapes are
  // served: `await find(...)` (array) and `find(...).lean()`.
  // Honour the query's `properties.propertyId.$in` filter so a scoped lookup
  // (e.g. _isRepairTermFrozenForBuilding querying only the AFFECTED units) does
  // NOT see an unrelated paid sibling. Without this the mock returned ALL
  // occupied tenants and a paid sibling wrongly froze a scoped check.
  const tenantsForOccupied = (query) => {
    const want = query?.['properties.propertyId']?.$in
      ? new Set(query['properties.propertyId'].$in.map(String))
      : null;
    const rows = Array.from(occupied)
      .filter((pid) => !want || want.has(String(pid)))
      .map((pid) => ({
        beginDate: new Date('2025-01-01'),
        endDate: new Date('2027-12-31'),
        terminationDate: null,
        // `tenantRents` (mutable, keyed by propertyId) lets a test give a tenant
        // a fully-paid rent for a term so _isRepairTermFrozenForBuilding sees it
        // as frozen. Default: no rents (never frozen on the current-term branch).
        rents: (tenantRents && tenantRents[pid]) || [],
        properties: [
          {
            propertyId: pid,
            entryDate: new Date('2025-01-01'),
            exitDate: new Date('2027-12-31')
          }
        ]
      }));
    return Object.assign(rows, { lean: async () => rows });
  };
  const OwnerStatement = await import(
    '../../../common/src/utils/ownerstatement.ts'
  );
  // 1_base (transitively imported) now imports ShareBasis from common — provide the REAL util.
  const ShareBasis = await import(
    '../../../common/src/utils/sharebasis.ts'
  );
  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: {
      Tenant: { find: (query) => tenantsForOccupied(query) },
      Property: { find: () => ({ lean: async () => [] }) },
      Building: {
        // Two call shapes in the manager: `await find(...)` (array) AND
        // `find(...).lean()` (in _recomputeTenantsForProperty). Return an
        // array that ALSO carries .lean() so both resolve to [buildingStore].
        find: () => Object.assign([buildingStore], { lean: async () => [buildingStore] }),
        // redistributeRepairsForProperties re-fetches the building fresh per
        // repair (per-repair atomicity). In this in-memory test the single
        // buildingStore IS the canonical doc, so findById returns it.
        findById: async () => buildingStore
      }
    },
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
      // mirror the occupancy: tenant groups carry the same date rows so the
      // breakdown-side occupancy (if read) agrees with _occupiedPropertyIds.
      buildings.forEach((b) => {
        b._tenantGroups = Array.from(occupied).map((pid) => ({
          beginDate: new Date('2025-01-01'),
          endDate: new Date('2027-12-31'),
          properties: [
            {
              propertyId: pid,
              entryDate: new Date('2025-01-01'),
              exitDate: new Date('2027-12-31')
            }
          ]
        }));
      });
    }
  }));

  ({ redistributeRepairsForProperties } = await import(
    '../managers/buildingmanager.js'
  ));
});

let _idSeq = 0;
function docArray(initial = []) {
  const arr = initial.map((x) => ({ _id: x._id || `gen_${++_idSeq}`, ...x }));
  arr.pull = function (id) {
    const i = this.findIndex((e) => String(e._id) === String(id));
    if (i >= 0) this.splice(i, 1);
  };
  arr.push = function (row) {
    const withId = { _id: row._id || `gen_${++_idSeq}`, ...row };
    Array.prototype.push.call(this, withId);
    return withId;
  };
  arr.id = function (id) {
    return this.find((e) => String(e._id) === String(id)) || null;
  };
  return arr;
}

// 2-unit building, equal allocation. Repair: split 50% tenant, equal,
// chargeOwnerWhenVacant ON, cost 100 → tenant pool 50 → 25 per unit.
function mkBuilding() {
  const mkUnit = (pid) => ({
    _id: `u_${pid}`,
    propertyId: pid,
    isManaged: true,
    surface: 50,
    generalThousandths: 500,
    heatingThousandths: 500,
    elevatorThousandths: 500,
    owners: [{ name: 'ΚΑΠΠΑ', taxId: '111', percentage: 100 }],
    monthlyCharges: docArray([])
  });
  return {
    _id: 'b1',
    name: 'ΟΔΟΣ ΗΤΑ test',
    realmId: 'r1',
    atakPrefix: '011000',
    units: [mkUnit('p1'), mkUnit('p2')],
    expenses: [],
    repairs: docArray([
      {
        _id: REPAIR_ID,
        title: 'ασανσέρ',
        category: 'general',
        chargeableTo: 'split',
        tenantSharePercentage: 50,
        allocationMethod: 'equal',
        chargeOwnerWhenVacant: true,
        estimatedCost: 100,
        actualCost: 100,
        chargeTerm: TERM,
        status: 'planned'
      }
    ]),
    contractors: [],
    ownerMonthlyExpenses: docArray([]),
    updatedDate: new Date('2026-01-01'),
    save: async function () {
      /* in-memory */
    }
  };
}

const unit = (b, pid) => b.units.find((u) => u.propertyId === pid);
const repairCharge = (u) =>
  (u.monthlyCharges || []).find(
    (c) => String(c.repairId) === REPAIR_ID && c.term === TERM
  );
const ownerRepairRows = (b) =>
  b.ownerMonthlyExpenses.filter((e) => String(e.expenseId) === REPAIR_ID);

describe('redistributeRepairsForProperties — occupancy staleness', () => {
  beforeEach(() => {
    tenantRents = undefined; // default: no frozen-paid rents
  });

  it('moves a repair share onto a tenant rent when a previously-vacant unit becomes occupied', async () => {
    buildingStore = mkBuilding();
    // p1 occupied from the start, p2 vacant.
    occupied = new Set(['p1']);

    // Initial distribution (as if the repair were just added): p1 → tenant
    // monthlyCharge 25; p2 vacant → owner repair-vacant row 25.
    const bm = await import('../managers/buildingmanager.js');
    await bm._distributeRepairCharge(buildingStore, buildingStore.repairs[0], 'r1');

    // split 50% → owner carries TWO rows: the building-wide owner-portion
    // ('repair', 50 €) AND p2's vacant tenant-share ('repair-vacant', 25 €).
    // p1 (occupied) gets its 25 € tenant share on rent; p2 (vacant) does not.
    expect(repairCharge(unit(buildingStore, 'p1'))?.amount).toBe(25);
    expect(repairCharge(unit(buildingStore, 'p2'))).toBeUndefined();
    let vacant = ownerRepairRows(buildingStore).filter(
      (r) => r.source === 'repair-vacant'
    );
    expect(vacant).toHaveLength(1);
    expect(vacant[0].propertyId).toBe('p2');
    expect(vacant[0].amount).toBe(25);

    // NOW a tenant moves into p2 (the lifecycle event that previously did NOT
    // re-distribute repairs). Flip occupancy and run the new re-distribution.
    occupied = new Set(['p1', 'p2']);
    await redistributeRepairsForProperties('r1', ['p2']);

    // p2's share must now be on the TENANT's rent, and the owner repair-vacant
    // row for p2 must be gone (no double-count: euro is on rent OR owner, never
    // both).
    expect(repairCharge(unit(buildingStore, 'p2'))?.amount).toBe(25);
    const vacantRows = ownerRepairRows(buildingStore).filter(
      (r) => r.source === 'repair-vacant'
    );
    expect(vacantRows).toHaveLength(0);

    // p1 untouched (still 25 on its rent).
    expect(repairCharge(unit(buildingStore, 'p1'))?.amount).toBe(25);

    // Conservation of the TENANT POOL (50 €): each unit's tenant share is now
    // billed to its rent (occupied) or to the owner as repair-vacant (vacant).
    // After p2 occupies, both shares are on rents → 0 repair-vacant left. The
    // building-wide owner-portion ('repair', 50 €) is the OWNER's separate 50%,
    // not part of the tenant pool, so exclude it from this check.
    const tenantBilled =
      (repairCharge(unit(buildingStore, 'p1'))?.amount || 0) +
      (repairCharge(unit(buildingStore, 'p2'))?.amount || 0);
    const repairVacantBilled = ownerRepairRows(buildingStore)
      .filter((r) => r.source === 'repair-vacant')
      .reduce((s, r) => s + (Number(r.amount) || 0), 0);
    expect(tenantBilled + repairVacantBilled).toBe(50);
  });

  it('SKIPS a past-term (frozen) repair — does not strip the owner row or drop a recorded payment (Step-7 critical guard)', async () => {
    // A past chargeTerm: the tenant rent for that month is FROZEN, so re-routing
    // the share would strip the owner repair-vacant row + drop the owner's
    // recorded payment while the frozen rent never absorbs it → euro vanishes.
    // The guard must leave the past-term repair untouched.
    buildingStore = mkBuilding();
    // chargeTerm far in the past relative to any plausible run date.
    buildingStore.repairs[0].chargeTerm = 2020010100;
    // Seed a vacant-unit owner repair-vacant row WITH a recorded owner payment,
    // as if it had been distributed (and paid) while p2 was vacant.
    buildingStore.ownerMonthlyExpenses.push({
      expenseId: REPAIR_ID,
      propertyId: 'p2',
      source: 'repair-vacant',
      amount: 25,
      term: 2020010100,
      payments: [{ amount: 25, date: '05/01/2020', type: 'transfer' }],
      paid: true,
      paidDate: new Date('2020-01-05')
    });

    // p2 now "occupied" — but the past-term guard must skip this repair.
    occupied = new Set(['p1', 'p2']);
    await redistributeRepairsForProperties('r1', ['p2']);

    // The owner repair-vacant row + its recorded payment MUST survive intact.
    const vacant = ownerRepairRows(buildingStore).filter(
      (r) => r.source === 'repair-vacant'
    );
    expect(vacant).toHaveLength(1);
    expect(vacant[0].amount).toBe(25);
    expect((vacant[0].payments || []).reduce((s, p) => s + p.amount, 0)).toBe(25);
    // And NO tenant repair charge was written for the frozen term.
    const p2charge = (unit(buildingStore, 'p2').monthlyCharges || []).find(
      (c) => String(c.repairId) === REPAIR_ID
    );
    expect(p2charge).toBeUndefined();
  });

  it('SKIPS a CURRENT-term repair when a covering tenant has that month FULLY PAID (frozen-paid guard, Step-7 r2 critical)', async () => {
    // Current-term rents are frozen ONLY if fully paid. A fully-paid current
    // month is just as frozen as a past month — re-routing the AFFECTED unit's
    // share would strand the euro / drop the owner payment. Here the AFFECTED
    // unit p2 itself is fully paid → must be skipped.
    const CURRENT = Number(
      moment.utc().startOf('month').format('YYYYMMDDHH')
    );
    buildingStore = mkBuilding();
    buildingStore.repairs[0].chargeTerm = CURRENT;
    // p2 (the affected unit) is FULLY PAID this month → frozen for p2's tenant.
    tenantRents = {
      p2: [
        {
          term: CURRENT,
          total: { grandTotal: 100 },
          payments: [{ amount: 100 }]
        }
      ]
    };
    // Seed a paid owner repair-vacant row on p2 (vacant when distributed).
    buildingStore.ownerMonthlyExpenses.push({
      expenseId: REPAIR_ID,
      propertyId: 'p2',
      source: 'repair-vacant',
      amount: 25,
      term: CURRENT,
      payments: [{ amount: 25, date: '05/06/2026', type: 'transfer' }],
      paid: true
    });
    occupied = new Set(['p1', 'p2']);
    await redistributeRepairsForProperties('r1', ['p2']);
    // Frozen-paid affected unit → repair skipped → owner row + payment intact, no tenant charge.
    const vacant = ownerRepairRows(buildingStore).filter(
      (r) => r.source === 'repair-vacant'
    );
    expect(vacant).toHaveLength(1);
    expect((vacant[0].payments || []).reduce((s, p) => s + p.amount, 0)).toBe(25);
    expect(
      (unit(buildingStore, 'p2').monthlyCharges || []).find(
        (c) => String(c.repairId) === REPAIR_ID
      )
    ).toBeUndefined();
  });

  it('a PAID SIBLING on an unrelated unit does NOT block re-routing a thawed affected unit — NON-equal allocation (per-tenant freeze scope, Step-7 r3 high)', async () => {
    // Freeze is PER TENANT. For a NON-equal method (here general_thousandths,
    // whose per-unit denominator is a fixed unit attribute occupancy never
    // changes), a fully-paid sibling on p1 must NOT freeze the WHOLE building —
    // the affected, unpaid unit p2 must still receive its repair share (the
    // ΟΔΟΣ ΗΤΑ-24 under-billing the building-wide ANY-frozen guard re-introduced).
    // (For EQUAL allocation a frozen sibling DOES block — see the divisor test —
    // because equal couples all units; thousandths shares are independent.)
    const CURRENT = Number(
      moment.utc().startOf('month').format('YYYYMMDDHH')
    );
    buildingStore = mkBuilding();
    buildingStore.repairs[0].chargeTerm = CURRENT;
    // Non-equal method so the scoped (per-affected-unit) freeze check applies.
    buildingStore.repairs[0].allocationMethod = 'general_thousandths';
    // p1 (a SIBLING, not affected) is fully paid → frozen for p1 only.
    tenantRents = {
      p1: [
        {
          term: CURRENT,
          total: { grandTotal: 100 },
          payments: [{ amount: 100 }]
        }
      ]
    };
    occupied = new Set(['p1']); // p2 vacant at distribution
    const bm = await import('../managers/buildingmanager.js');
    await bm._distributeRepairCharge(buildingStore, buildingStore.repairs[0], 'r1');
    // p2's share parked on the owner ledger (repair-vacant) since it was vacant.
    expect(
      ownerRepairRows(buildingStore).some(
        (r) => r.source === 'repair-vacant' && r.propertyId === 'p2'
      )
    ).toBe(true);

    // Tenant moves into p2; only p2 is affected. The paid p1 sibling must NOT block.
    occupied = new Set(['p1', 'p2']);
    await redistributeRepairsForProperties('r1', ['p2']);

    // p2 gets its repair share on rent; the repair-vacant row is released.
    const p2charge = (unit(buildingStore, 'p2').monthlyCharges || []).find(
      (c) => String(c.repairId) === REPAIR_ID && c.term === CURRENT
    );
    expect(p2charge?.amount).toBe(25);
    expect(
      ownerRepairRows(buildingStore).filter(
        (r) => r.source === 'repair-vacant' && r.propertyId === 'p2'
      )
    ).toHaveLength(0);
  });

  it('PRESERVES a recorded owner payment as a credit (never drops) when a vacant unit with a paid repair-vacant row becomes occupied (Step-7 r2 high)', async () => {
    // Thawed current/future term so redistribution actually runs. The owner
    // pre-paid p2's vacant repair share; a tenant then occupies p2. The share
    // moves to the tenant's (unpaid) rent — the owner's recorded €25 must NOT
    // vanish; it survives as a source:'credit' remnant (refundable surplus).
    buildingStore = mkBuilding();
    // Near-future term: strictly after the current month (→ thawed, never
    // frozen) but still inside the mock lease window (begin 2025 / end 2027) so
    // the occupancy reader treats an occupied unit as occupied. (A far-future
    // 2099 term would fall outside the lease → unit reads vacant → no charge.)
    const FUTURE = Number(
      moment.utc().add(2, 'months').startOf('month').format('YYYYMMDDHH')
    );
    buildingStore.repairs[0].chargeTerm = FUTURE;
    occupied = new Set(['p1']); // p2 vacant initially
    const bm = await import('../managers/buildingmanager.js');
    await bm._distributeRepairCharge(buildingStore, buildingStore.repairs[0], 'r1');
    // Owner pays p2's repair-vacant €25.
    const v = ownerRepairRows(buildingStore).find(
      (r) => r.source === 'repair-vacant' && r.propertyId === 'p2'
    );
    expect(v).toBeTruthy();
    v.payments = [{ amount: 25, date: '05/01/2026', type: 'transfer' }];
    v.paid = true;

    // Tenant moves into p2 → tenancy-triggered re-distribution (preserve mode).
    occupied = new Set(['p1', 'p2']);
    await redistributeRepairsForProperties('r1', ['p2']);

    // p2's share now on the tenant's rent (unpaid) at the repair's term, and
    // the repair-vacant row is gone.
    const p2charge = (unit(buildingStore, 'p2').monthlyCharges || []).find(
      (c) => String(c.repairId) === REPAIR_ID && c.term === FUTURE
    );
    expect(p2charge?.amount).toBe(25);
    expect(
      ownerRepairRows(buildingStore).filter((r) => r.source === 'repair-vacant')
    ).toHaveLength(0);
    // The owner's recorded €25 MUST SURVIVE — never dropped. The pool re-applies
    // it to a surviving same-owner liability row (the building-wide owner-portion
    // 'repair' row) when one exists, else preserves it as a source:'credit'
    // remnant. Either way the recorded total across all this repair's owner rows
    // is still €25 (the assertion that the round-2 'high' was about: zero loss).
    const ownerPaidTotal = ownerRepairRows(buildingStore).reduce(
      (s, r) => s + (r.payments || []).reduce((a, p) => a + (p.amount || 0), 0),
      0
    );
    expect(ownerPaidTotal).toBe(25);
  });

  it('is idempotent — re-running on an unchanged building does not duplicate or drop the share', async () => {
    buildingStore = mkBuilding();
    occupied = new Set(['p1', 'p2']); // both occupied
    const bm = await import('../managers/buildingmanager.js');
    await bm._distributeRepairCharge(buildingStore, buildingStore.repairs[0], 'r1');

    const before =
      (repairCharge(unit(buildingStore, 'p1'))?.amount || 0) +
      (repairCharge(unit(buildingStore, 'p2'))?.amount || 0);
    expect(before).toBe(50); // both occupied → full pool on tenant rents

    // Re-run twice — must be a no-op (one charge per unit, still 25 each).
    await redistributeRepairsForProperties('r1', ['p1', 'p2']);
    await redistributeRepairsForProperties('r1', ['p1', 'p2']);

    expect(repairCharge(unit(buildingStore, 'p1'))?.amount).toBe(25);
    expect(repairCharge(unit(buildingStore, 'p2'))?.amount).toBe(25);
    // exactly one repair charge per unit (no duplicates from re-runs)
    const p1charges = unit(buildingStore, 'p1').monthlyCharges.filter(
      (c) => String(c.repairId) === REPAIR_ID
    );
    expect(p1charges).toHaveLength(1);
  });

  it('does NOT overwrite a FROZEN sibling’s equal-allocation share when the divisor shifts (Step-7 r4 medium)', async () => {
    // 3 units, equal allocation, CURRENT term. p3’s tenant has fully paid →
    // p3 is frozen. A tenancy change on p1 (affected) re-runs the writer, which
    // re-divides the equal share across all units. p3’s persisted charge MUST
    // stay at its pinned value (what the frozen rent was billed), not be
    // overwritten to the new divisor’s value.
    const CURRENT = Number(
      moment.utc().startOf('month').format('YYYYMMDDHH')
    );
    const mkUnit = (pid) => ({
      _id: `u_${pid}`,
      propertyId: pid,
      isManaged: true,
      surface: 50,
      generalThousandths: 333,
      heatingThousandths: 333,
      elevatorThousandths: 333,
      owners: [{ name: 'ΚΑΠΠΑ', taxId: '111', percentage: 100 }],
      monthlyCharges: docArray([])
    });
    buildingStore = {
      _id: 'b1',
      name: '3-unit',
      realmId: 'r1',
      atakPrefix: '011000',
      units: [mkUnit('p1'), mkUnit('p2'), mkUnit('p3')],
      expenses: [],
      repairs: docArray([
        {
          _id: REPAIR_ID,
          title: 'ασανσέρ',
          category: 'general',
          chargeableTo: 'tenants',
          tenantSharePercentage: 100,
          allocationMethod: 'equal',
          chargeOwnerWhenVacant: true,
          estimatedCost: 90,
          actualCost: 90,
          chargeTerm: CURRENT,
          status: 'planned'
        }
      ]),
      contractors: [],
      ownerMonthlyExpenses: docArray([]),
      updatedDate: new Date('2026-01-01'),
      save: async function () {}
    };
    // p3 fully paid this month → frozen for p3.
    tenantRents = {
      p3: [{ term: CURRENT, total: { grandTotal: 100 }, payments: [{ amount: 100 }] }]
    };
    // Seed p3 with its pinned repair charge (30 = 90/3 when all 3 occupied).
    unit(buildingStore, 'p3').monthlyCharges.push({
      term: CURRENT,
      amount: 30,
      description: 'Repair: ασανσέρ',
      repairId: REPAIR_ID
    });
    // Seed p1's pinned share too (30 each, all 3 occupied = 90/3) so we can
    // assert the WHOLE distribution is left consistent (Σ = cost), not partially
    // re-divided.
    unit(buildingStore, 'p1').monthlyCharges.push({
      term: CURRENT,
      amount: 30,
      description: 'Repair: ασανσέρ',
      repairId: REPAIR_ID
    });
    // p1 + p3 occupied; p2 vacant → a tenancy change brings p2 in, which would
    // shift the equal divisor. Affected = p2. Because p3 is FROZEN and the
    // method is equal, the WHOLE repair must be left as-is (no partial
    // re-division → no Σ(shares) ≠ cost drift, Step-7 r5).
    occupied = new Set(['p1', 'p3']);
    await redistributeRepairsForProperties('r1', ['p2']);
    occupied = new Set(['p1', 'p2', 'p3']);
    await redistributeRepairsForProperties('r1', ['p2']);

    const chargeFor = (pid) =>
      (unit(buildingStore, pid).monthlyCharges || []).find(
        (c) => String(c.repairId) === REPAIR_ID && c.term === CURRENT
      )?.amount || 0;
    // Frozen-sibling + equal → wholesale skip: p1 + p3 keep their pinned 30 each,
    // p2 was NOT pulled into a re-division (no new charge written for it).
    expect(chargeFor('p3')).toBe(30);
    expect(chargeFor('p1')).toBe(30);
    expect(chargeFor('p2')).toBe(0);
    // No owner repair-vacant row was synthesised for p2 either (whole repair untouched).
    expect(
      ownerRepairRows(buildingStore).filter((r) => r.source === 'repair-vacant')
    ).toHaveLength(0);
  });

  it('EQUAL + frozen: an edit must NOT destroy a recorded owner καταβολή (Step-7 r6 critical — bail BEFORE the owner-row strip)', async () => {
    // An equal split repair with a recorded owner-portion payment. A sibling
    // tenant is frozen-paid. Re-running the writer (an innocuous edit) must bail
    // BEFORE stripping owner rows — else the captured payment pool is discarded
    // and the owner's recorded καταβολή is destroyed.
    const CURRENT = Number(
      moment.utc().startOf('month').format('YYYYMMDDHH')
    );
    const mkUnit = (pid) => ({
      _id: `u_${pid}`,
      propertyId: pid,
      isManaged: true,
      surface: 50,
      generalThousandths: 500,
      heatingThousandths: 500,
      elevatorThousandths: 500,
      owners: [{ name: 'ΚΑΠΠΑ', taxId: '111', percentage: 100 }],
      monthlyCharges: docArray([])
    });
    buildingStore = {
      _id: 'b1',
      name: 'eq-frozen',
      realmId: 'r1',
      atakPrefix: '011000',
      units: [mkUnit('p1'), mkUnit('p2')],
      expenses: [],
      repairs: docArray([
        {
          _id: REPAIR_ID,
          title: 'ασανσέρ',
          category: 'general',
          chargeableTo: 'split',
          tenantSharePercentage: 60, // ownerPortion > 0 → an owner 'repair' row exists
          allocationMethod: 'equal',
          chargeOwnerWhenVacant: true,
          estimatedCost: 100,
          actualCost: 100,
          chargeTerm: CURRENT,
          status: 'planned'
        }
      ]),
      contractors: [],
      ownerMonthlyExpenses: docArray([
        {
          expenseId: REPAIR_ID,
          term: CURRENT,
          source: 'repair',
          amount: 40, // owner portion = 100 × (1 − 60%) = 40
          propertyId: null,
          payments: [{ amount: 40, date: '05/06/2026', type: 'transfer' }],
          paid: true
        }
      ]),
      updatedDate: new Date('2026-01-01'),
      save: async function () {}
    };
    // p1 fully paid this month → frozen → equal repair must bail wholesale.
    tenantRents = {
      p1: [{ term: CURRENT, total: { grandTotal: 100 }, payments: [{ amount: 100 }] }]
    };
    occupied = new Set(['p1', 'p2']);
    const bm = await import('../managers/buildingmanager.js');
    // An innocuous edit re-runs the writer.
    await bm._distributeRepairCharge(buildingStore, buildingStore.repairs[0], 'r1');

    // The recorded owner €40 MUST still be on the ledger (not destroyed by an
    // early strip that returned before the pool was re-applied).
    const ownerPaid = ownerRepairRows(buildingStore).reduce(
      (s, r) => s + (r.payments || []).reduce((a, p) => a + (p.amount || 0), 0),
      0
    );
    expect(ownerPaid).toBe(40);
  });

  it('cost→0 edit preserves a FROZEN+occupied unit’s pinned tenant charge (Step-7 r6 medium)', async () => {
    // A thousandths repair billed to tenants. p1’s tenant fully paid (frozen).
    // Editing the repair cost to 0 must NOT pull p1’s pinned monthlyCharge (the
    // frozen rent still bills it), else the panel desyncs from the rent.
    const CURRENT = Number(
      moment.utc().startOf('month').format('YYYYMMDDHH')
    );
    buildingStore = mkBuilding();
    buildingStore.repairs[0].allocationMethod = 'general_thousandths';
    buildingStore.repairs[0].chargeableTo = 'tenants';
    buildingStore.repairs[0].tenantSharePercentage = 100;
    buildingStore.repairs[0].chargeTerm = CURRENT;
    tenantRents = {
      p1: [{ term: CURRENT, total: { grandTotal: 100 }, payments: [{ amount: 100 }] }]
    };
    // p1 frozen+occupied, holds a pinned repair charge.
    unit(buildingStore, 'p1').monthlyCharges.push({
      term: CURRENT,
      amount: 50,
      description: 'Repair: ασανσέρ',
      repairId: REPAIR_ID
    });
    occupied = new Set(['p1', 'p2']);
    const bm = await import('../managers/buildingmanager.js');
    // Edit cost → 0.
    buildingStore.repairs[0].actualCost = 0;
    buildingStore.repairs[0].estimatedCost = 0;
    await bm._distributeRepairCharge(buildingStore, buildingStore.repairs[0], 'r1');

    // p1 frozen → its pinned €50 survives; p2 (thawed) is stripped to €0.
    const p1charge = (unit(buildingStore, 'p1').monthlyCharges || []).find(
      (c) => String(c.repairId) === REPAIR_ID && c.term === CURRENT
    );
    expect(p1charge?.amount).toBe(50);
  });
});
