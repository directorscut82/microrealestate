/* eslint-env node, jest */
/**
 * B-C: updateUnit / addUnit must REFUSE to mark a unit owner_occupied while a
 * tenant ACTIVELY rents its property (mutually-exclusive states), but must
 * ALLOW it once the tenant has moved out (terminated) — date-aware, not the
 * naive "any tenant row ever" check. Mirrors the guard removeUnit already has.
 *
 * B-A: an occupancy change of ANY kind (not only owner_occupied transitions)
 * fires recomputeVacantOwnerForProperties. Proven here by asserting the guard's
 * occupancy helper reads the tenant set (the active-vs-terminated distinction);
 * the recompute widening is covered by the build + the money suite.
 */
import { jest } from '@jest/globals';

let buildingManager;
const state = {};
// the ids of two stored rows, as the database writes them
const C1 = 'aaaaaaaaaaaaaaaaaaaa40c1';
const C2 = 'aaaaaaaaaaaaaaaaaaaa40c2';

beforeAll(async () => {
  class ServiceError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
  const query = (v) => {
    const p = Promise.resolve(v);
    p.lean = async () => v;
    p.select = () => query(v);
    return p;
  };

  const makeSaveable = (obj) => {
    obj.save = async () => obj;
    obj.toObject = () => obj;
    // Mongoose DocumentArray exposes .id(uid); emulate it on the plain array so
    // updateUnit's `building.units.id(unitId)` resolves the subdoc.
    if (Array.isArray(obj.units)) {
      obj.units.id = (uid) =>
        obj.units.find((u) => String(u._id) === String(uid)) || null;
    }
    return obj;
  };

  // Unit u1 → property P1. Two scenarios switch `state.tenants`.
  const building = makeSaveable({
    _id: '6a4551f5efd7970071c44002',
    name: 'Κτίριο',
    realmId: 'r1',
    address: { street1: 'ΟΔΟΣ ΕΨΙΛΟΝ 28' },
    units: [
      {
        _id: '6a4551f5efd7970071c44003',
        atakNumber: 'AT1',
        propertyId: '6a4551f5efd7970071c44001',
        isManaged: true,
        occupancyType: 'vacant',
        generalThousandths: 100,
        heatingThousandths: 0,
        elevatorThousandths: 0,
        owners: [{ name: 'ΒΗΤΑ', percentage: 100 }],
        monthlyCharges: [],
        set(body) {
          Object.assign(this, body);
        }
      }
    ]
  });
  state.building = building;
  state.tenants = [];

  const OwnerStatement = await import('../../../common/src/utils/ownerstatement.ts');
  const ShareBasis = await import('../../../common/src/utils/sharebasis.ts');

  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: {
      Building: {
        findOne: () => {
          // updateUnit/addUnit use findOne (not lean) then mutate + save.
          const p = Promise.resolve(building);
          p.lean = async () => building;
          p.select = () => p;
          return p;
        },
        find: () => query([building])
      },
      Property: {
        findOne: () => query({ _id: '6a4551f5efd7970071c44001', realmId: 'r1', buildingId: '6a4551f5efd7970071c44002' }),
        find: () => query([{ _id: '6a4551f5efd7970071c44001', realmId: 'r1', buildingId: '6a4551f5efd7970071c44002' }]),
        findOneAndUpdate: () => query(null),
        updateOne: () => query(null)
      },
      // The date-aware occupancy helper queries Tenant.find(...).select().lean()
      Tenant: {
        find: () => query(state.tenants)
      },
      ObjectId: class {
        constructor(v) {
          this.v = v;
        }
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
    logger: { info() {}, error() {}, warn() {}, debug() {} },
    ServiceError,
    OwnerStatement,
    ShareBasis,
    Pagination: {},
    Service: { getInstance: () => ({ envConfig: { getValues: () => ({}) } }) },
    Crypto: { encrypt: (v) => v, decrypt: (v) => v }
  }));

  buildingManager = await import('../managers/buildingmanager.js');
});

function makeRes() {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function updateReq(occupancyType) {
  return {
    realm: { _id: 'r1', locale: 'el' },
    params: { id: '6a4551f5efd7970071c44002', unitId: '6a4551f5efd7970071c44003' },
    body: {
      atakNumber: 'AT1',
      propertyId: '6a4551f5efd7970071c44001',
      occupancyType,
      generalThousandths: 100,
      heatingThousandths: 0,
      elevatorThousandths: 0,
      surface: 50,
      floor: 1
    }
  };
}

describe('B-C owner-occupied guard (date-aware)', () => {
  beforeEach(() => {
    state.building.units[0].occupancyType = 'vacant';
  });

  it('REFUSES owner_occupied when an ACTIVE tenant rents the property (422)', async () => {
    state.tenants = [
      {
        _id: 't1',
        beginDate: new Date('2020-01-01'),
        endDate: new Date('2030-01-01'),
        terminationDate: null,
        properties: [{ propertyId: '6a4551f5efd7970071c44001' }]
      }
    ];
    const res = makeRes();
    await expect(
      buildingManager.updateUnit(updateReq('owner_occupied'), res)
    ).rejects.toMatchObject({ status: 422 });
  });

  it('ALLOWS owner_occupied when the only tenant has TERMINATED (moved out)', async () => {
    state.tenants = [
      {
        _id: 't1',
        beginDate: new Date('2020-01-01'),
        endDate: new Date('2030-01-01'),
        // Terminated last month → not active this term.
        terminationDate: new Date('2020-06-01'),
        properties: [{ propertyId: '6a4551f5efd7970071c44001' }]
      }
    ];
    const res = makeRes();
    await buildingManager.updateUnit(updateReq('owner_occupied'), res);
    expect(res.json).toHaveBeenCalled();
    expect(state.building.units[0].occupancyType).toBe('owner_occupied');
  });

  it('ALLOWS owner_occupied when there is NO tenant at all', async () => {
    state.tenants = [];
    const res = makeRes();
    await buildingManager.updateUnit(updateReq('owner_occupied'), res);
    expect(res.json).toHaveBeenCalled();
    expect(state.building.units[0].occupancyType).toBe('owner_occupied');
  });
});

describe('Finding D — owner_occupied requires a linked property', () => {
  beforeEach(() => {
    state.building.units[0].occupancyType = 'vacant';
    state.tenants = [];
  });

  it('updateUnit REFUSES owner_occupied when the unit has no propertyId (422)', async () => {
    // Body clears the propertyId; the unit's oldPropertyId is also cleared for
    // this case so the effective propertyId resolves empty.
    state.building.units[0].propertyId = '';
    const req = updateReq('owner_occupied');
    req.body.propertyId = '';
    const res = makeRes();
    await expect(buildingManager.updateUnit(req, res)).rejects.toMatchObject({
      status: 422
    });
    // restore for other tests
    state.building.units[0].propertyId = '6a4551f5efd7970071c44001';
  });

  it('updateUnit ALLOWS owner_occupied when a propertyId IS present (no false block)', async () => {
    state.building.units[0].propertyId = '6a4551f5efd7970071c44001';
    const res = makeRes();
    await buildingManager.updateUnit(updateReq('owner_occupied'), res);
    expect(res.json).toHaveBeenCalled();
    expect(state.building.units[0].occupancyType).toBe('owner_occupied');
  });
});

// DEFERRED_DECISIONS D-10. `carry` on a unit's monthly-charge row is the statement
// save's own mark: a share so marked is billed on the tenant's next open month when its
// own month is closed. updateUnit takes `monthlyCharges` from the request as it is
// (`unit.set(req.body)`), so the mark must not come from there: set on a row from
// before the mark existed, it would bill an old share out of the blue. (The rule
// itself is pinned in chargeCarry.test.js `chargesWithStoredMarks`; this pins that
// the endpoint applies it.)
describe('updateUnit never takes the mark of a carried share from the request', () => {
  beforeEach(() => {
    state.building.units[0].occupancyType = 'vacant';
    state.building.units[0].propertyId = '6a4551f5efd7970071c44001';
    state.tenants = [];
    state.building.units[0].monthlyCharges = [
      { _id: C1, term: 2026050100, amount: 30, expenseId: 'e1' },
      { _id: C2, term: 2026100100, amount: 20, expenseId: 'e1', carry: true }
    ];
  });
  afterAll(() => {
    state.building.units[0].monthlyCharges = [];
  });

  it('a mark added to an old row is dropped; the mark of a row that has one stays', async () => {
    const req = updateReq('vacant');
    req.body.monthlyCharges = [
      { _id: C1, term: 2026050100, amount: 30, expenseId: 'e1', carry: 'true' },
      { _id: C2, term: 2026100100, amount: 20, expenseId: 'e1', carry: false },
      { term: 2026060100, amount: 9, expenseId: 'e1', carry: true }
    ];
    const res = makeRes();
    await buildingManager.updateUnit(req, res);
    expect(res.json).toHaveBeenCalled();
    expect(state.building.units[0].monthlyCharges).toEqual([
      { _id: C1, term: 2026050100, amount: 30, expenseId: 'e1' },
      { _id: C2, term: 2026100100, amount: 20, expenseId: 'e1', carry: true },
      { term: 2026060100, amount: 9, expenseId: 'e1' }
    ]);
  });

  it('a request that sends no rows leaves the rows alone', async () => {
    const res = makeRes();
    await buildingManager.updateUnit(updateReq('vacant'), res);
    expect(state.building.units[0].monthlyCharges).toEqual([
      { _id: C1, term: 2026050100, amount: 30, expenseId: 'e1' },
      { _id: C2, term: 2026100100, amount: 20, expenseId: 'e1', carry: true }
    ]);
  });

  it.each([
    [
      'a single row object (the schema would turn it into a list of one)',
      { monthlyCharges: { _id: C1, term: 2026050100, amount: 30, expenseId: 'e1', carry: 'true' } }
    ],
    ['a path to the mark of a row', { 'monthlyCharges.0.carry': true }],
    ['a path to a whole row', { 'monthlyCharges.1': { term: 2026050100, amount: 1, carry: true } }]
  ])('rows sent as %s are refused, and nothing is saved', async (_what, extra) => {
    const req = updateReq('vacant');
    Object.assign(req.body, extra);
    const before = JSON.stringify(state.building.units[0].monthlyCharges);
    const res = makeRes();
    await expect(buildingManager.updateUnit(req, res)).rejects.toMatchObject({
      status: 422
    });
    expect(res.json).not.toHaveBeenCalled();
    expect(JSON.stringify(state.building.units[0].monthlyCharges)).toBe(before);
  });

  it('two rows with one id are refused: a row is removed by its id, and that would remove both', async () => {
    // (it used to be accepted, the first row keeping the mark: a later save that took
    // one of the two rows out by its id took the other out with it — found by review)
    const req = updateReq('vacant');
    req.body.monthlyCharges = [
      { _id: C2, term: 2026100100, amount: 20, expenseId: 'e1' },
      { _id: C2, term: 2026100100, amount: 99, expenseId: 'e1', carry: true }
    ];
    const before = JSON.stringify(state.building.units[0].monthlyCharges);
    await expect(
      buildingManager.updateUnit(req, makeRes())
    ).rejects.toMatchObject({
      status: 422,
      message: 'two monthlyCharges rows have the same _id'
    });
    expect(JSON.stringify(state.building.units[0].monthlyCharges)).toBe(before);
  });

  it('addUnit refuses rows that are not a list', async () => {
    const res = makeRes();
    await expect(
      buildingManager.addUnit(
        {
          realm: { _id: 'r1', locale: 'el' },
          params: { id: '6a4551f5efd7970071c44002' },
          body: {
            atakNumber: 'AT3',
            isManaged: false,
            occupancyType: 'vacant',
            generalThousandths: 0,
            heatingThousandths: 0,
            elevatorThousandths: 0,
            monthlyCharges: { term: 2026050100, amount: 5, carry: true }
          }
        },
        res
      )
    ).rejects.toMatchObject({ status: 422 });
    expect(state.building.units).toHaveLength(1);
  });

  it('addUnit: a unit that is created with rows gets none of them marked', async () => {
    const req = {
      realm: { _id: 'r1', locale: 'el' },
      params: { id: '6a4551f5efd7970071c44002' },
      body: {
        atakNumber: 'AT2',
        isManaged: false,
        occupancyType: 'vacant',
        generalThousandths: 0,
        heatingThousandths: 0,
        elevatorThousandths: 0,
        surface: 10,
        floor: 2,
        monthlyCharges: [
          { term: 2026050100, amount: 5, expenseId: 'e1', carry: true }
        ]
      }
    };
    const res = makeRes();
    try {
      await buildingManager.addUnit(req, res);
      expect(res.json).toHaveBeenCalled();
      const created = state.building.units.find((u) => u.atakNumber === 'AT2');
      expect(created.monthlyCharges).toEqual([
        { term: 2026050100, amount: 5, expenseId: 'e1' }
      ]);
    } finally {
      // leave the building as the other tests expect it: one unit
      while (state.building.units.length > 1) state.building.units.pop();
    }
  });
});

// DEFERRED_DECISIONS D-10. Two entries for one expense in one statement made two rows
// of it on every unit; carried to another month, two shares of one unit, expense and
// month have one attribution key, and a payment for one of them named both (found by
// review). The statement save refuses such a body before it touches anything.
describe('saveMonthlyStatement refuses an expense that is listed twice', () => {
  const withExpenses = () => {
    const expenses = [{ _id: 'e1', name: 'ΡΕΥΜΑ', allocationMethod: 'equal' }];
    expenses.id = (id) => expenses.find((e) => String(e._id) === String(id)) || null;
    state.building.expenses = expenses;
  };
  afterEach(() => {
    delete state.building.expenses;
  });
  const statementReq = (expenses) => ({
    realm: { _id: 'r1', locale: 'el' },
    params: { id: '6a4551f5efd7970071c44002' },
    body: { term: '2026100100', expenses }
  });

  it('two entries for one expense: 422, and no unit is touched', async () => {
    withExpenses();
    const before = JSON.stringify(state.building.units);
    const res = makeRes();
    await expect(
      buildingManager.saveMonthlyStatement(
        statementReq([
          { expenseId: 'e1', amount: 20 },
          { expenseId: 'e1', amount: 30 }
        ]),
        res
      )
    ).rejects.toMatchObject({
      status: 422,
      message: 'expenseId e1 is listed twice in expenses'
    });
    expect(res.json).not.toHaveBeenCalled();
    expect(JSON.stringify(state.building.units)).toBe(before);
  });

  it('…also when the second entry only clears the figure', async () => {
    withExpenses();
    await expect(
      buildingManager.saveMonthlyStatement(
        statementReq([
          { expenseId: 'e1', amount: 20 },
          { expenseId: 'e1', amount: 0 }
        ]),
        makeRes()
      )
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('Finding C — removeUnit does not orphan owner charges', () => {
  function removeReq() {
    return {
      realm: { _id: 'r1', locale: 'el' },
      params: {
        id: '6a4551f5efd7970071c44002',
        unitId: '6a4551f5efd7970071c44003'
      }
    };
  }

  beforeEach(() => {
    state.tenants = [];
    state.building.units[0].propertyId = '6a4551f5efd7970071c44001';
    // Give the building a DocumentArray-like ownerMonthlyExpenses with .pull.
    const rows = [];
    rows.pull = function (uid) {
      const i = this.findIndex((r) => String(r._id) === String(uid));
      if (i >= 0) this.splice(i, 1);
    };
    state.building.ownerMonthlyExpenses = rows;
    // units.pull so removeUnit can drop the unit.
    if (!state.building.units.pull) {
      state.building.units.pull = function (uid) {
        const i = this.findIndex((u) => String(u._id) === String(uid));
        if (i >= 0) this.splice(i, 1);
      };
    }
  });

  it('BLOCKS delete (422) when a propertyId-scoped owner row carries recorded καταβολές', async () => {
    state.building.ownerMonthlyExpenses.push({
      _id: 'ome_paid',
      expenseId: 'e1',
      term: 2026060100,
      amount: 100,
      source: 'owner-resident',
      propertyId: '6a4551f5efd7970071c44001',
      payments: [{ amount: 100, type: 'transfer', date: '01/06/2026' }]
    });
    const res = makeRes();
    await expect(
      buildingManager.removeUnit(removeReq(), res)
    ).rejects.toMatchObject({ status: 422 });
    // unit + paid row both preserved (no silent drop of recorded money)
    expect(state.building.units.length).toBe(1);
    expect(state.building.ownerMonthlyExpenses.length).toBe(1);
  });

  it('DROPS an UNPAID propertyId-scoped owner row and removes the unit (no orphan)', async () => {
    state.building.ownerMonthlyExpenses.push({
      _id: 'ome_unpaid',
      expenseId: 'e1',
      term: 2026060100,
      amount: 100,
      source: 'owner-resident',
      propertyId: '6a4551f5efd7970071c44001',
      payments: []
    });
    const res = makeRes();
    await buildingManager.removeUnit(removeReq(), res);
    expect(res.json).toHaveBeenCalled();
    // unpaid orphan cleaned up, unit removed
    expect(
      state.building.ownerMonthlyExpenses.find(
        (r) => String(r.propertyId) === '6a4551f5efd7970071c44001'
      )
    ).toBeUndefined();
    expect(
      state.building.units.find(
        (u) => String(u._id) === '6a4551f5efd7970071c44003'
      )
    ).toBeUndefined();
  });
});
