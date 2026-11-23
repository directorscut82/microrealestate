/* eslint-env node, jest */
// The doors a request could reach a carried share through — the unit endpoints, the
// statement save, the manual-row edit — driven through the REAL Building schema
// (@microrealestate/common as built: what the api loads), with the real handlers and no
// database. DEFERRED_DECISIONS D-10.
//
// Why the real schema: what gets past these doors is decided by what Mongoose CASTS. A
// single row object becomes a list of one; `{ _id: X }` becomes X; an id in upper case
// finds the same expense. A stand-in that compares plain text (ownerOccupiedGuard.test.js
// has one) cannot show any of it — a reviewer's probe against the real schema did.
import { jest } from '@jest/globals';

const OCT = 2026100100;
const NOV = 2026110100;
const BUILDING = 'aaaaaaaaaaaaaaaaaaaa4002';
const PROPERTY = 'aaaaaaaaaaaaaaaaaaaa4001';

let buildingManager;
let Building;
const state = { saves: 0 };

beforeAll(async () => {
  ({ default: Building } = await import(
    '../../../common/dist/collections/building.js'
  ));
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
  const OwnerStatement = await import('../../../common/src/utils/ownerstatement.ts');
  const ShareBasis = await import('../../../common/src/utils/sharebasis.ts');

  // Every export the manager imports, one by one (a factory that spreads the real
  // module carries the real singletons: see test-running-guide.md).
  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: {
      // `new Collections.Building(…)` (building create) makes a real document whose
      // save is counted, not sent
      Building: Object.assign(
        function (doc) {
          const created = new Building(doc);
          created.save = async () => {
            state.saves += 1;
            return created;
          };
          state.created = created;
          return created;
        },
        {
          findOne: () => query(state.building),
          find: () => query([state.building])
        }
      ),
      Property: {
        findOne: () => query({ _id: PROPERTY, realmId: 'r1', buildingId: BUILDING }),
        find: () => query([{ _id: PROPERTY, realmId: 'r1', buildingId: BUILDING }]),
        findOneAndUpdate: () => query(null),
        updateOne: () => query(null)
      },
      Tenant: { find: () => query(state.tenants || []) },
      ObjectId: class {
        constructor(v) {
          this.v = v;
        }
      }
    },
    BillTerm: {
      billTermFitsExpense: () => ({ fits: true }),
      billTermIsOutsideExpense: () => false,
      computeChargeTerm: () => undefined
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

// A building as the database holds it: one unit linked to a property, one variable
// expense, and the unit's rows.
function store(rows = []) {
  const doc = new Building({
    _id: BUILDING,
    realmId: 'r1',
    name: 'Building 1',
    address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' },
    units: [
      {
        atakNumber: '99970000001',
        propertyId: PROPERTY,
        isManaged: true,
        occupancyType: 'vacant',
        generalThousandths: 500,
        heatingThousandths: 0,
        elevatorThousandths: 0,
        owners: [{ name: 'ΒΗΤΑ', percentage: 100 }],
        monthlyCharges: rows
      }
    ],
    expenses: [
      {
        name: 'Common power',
        type: 'electricity_common',
        amount: 0,
        allocationMethod: 'general_thousandths',
        isRecurring: true,
        startTerm: 2026010100
      }
    ]
  });
  state.saves = 0;
  doc.save = async () => {
    state.saves += 1;
    return doc;
  };
  state.building = doc;
  return doc;
}
const unit = () => state.building.units[0];
const expenseId = () => String(state.building.expenses[0]._id);
const rows = () =>
  unit().monthlyCharges.map((c) => [c.term, c.amount, c.carry === true]);
const makeRes = () => {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
};
const unitBody = (extra = {}) => ({
  atakNumber: '99970000001',
  propertyId: PROPERTY,
  occupancyType: 'vacant',
  generalThousandths: 500,
  heatingThousandths: 0,
  elevatorThousandths: 0,
  surface: 50,
  floor: 1,
  ...extra
});
const updateUnit = (extra) =>
  buildingManager.updateUnit(
    {
      realm: { _id: 'r1', locale: 'el' },
      params: { id: BUILDING, unitId: String(unit()._id) },
      body: unitBody(extra)
    },
    makeRes()
  );
// October: a marked share (30) and one from before the mark (20)
const twoRows = () => {
  store([
    { term: OCT, amount: 30, description: 'Common power', expenseId: 'e-new', carry: true },
    { term: OCT, amount: 20, description: 'Water', expenseId: 'e-old' }
  ]);
  return unit().monthlyCharges.map((c) => c.toObject());
};

describe('what the schema would do with a row a client sends (the reason for the refusals)', () => {
  it('a single row object becomes a list of one, and «true» as text becomes the mark', () => {
    const doc = store();
    unit().set({
      monthlyCharges: { term: OCT, amount: 5, expenseId: 'e', carry: 'true' }
    });
    expect(rows()).toEqual([[OCT, 5, true]]);
    expect(doc.units).toHaveLength(1);
  });

  it('a path reaches the mark of a stored row', () => {
    twoRows();
    unit().set({ 'monthlyCharges.1.carry': true });
    expect(rows()[1]).toEqual([OCT, 20, true]);
  });

  it('`{ _id: X }` is cast back to X: the row keeps its identity', () => {
    const [marked] = twoRows();
    unit().set({
      monthlyCharges: [{ ...marked, _id: { _id: String(marked._id) } }]
    });
    expect(String(unit().monthlyCharges[0]._id)).toBe(String(marked._id));
  });

  it('two rows can share an `_id`, and taking one out by its id takes out both', () => {
    const [marked] = twoRows();
    unit().set({
      monthlyCharges: [marked, { ...marked, term: NOV, amount: 7, carry: undefined }]
    });
    expect(unit().monthlyCharges).toHaveLength(2);
    unit().monthlyCharges.pull(marked._id);
    expect(unit().monthlyCharges).toHaveLength(0);
  });
});

describe('updateUnit: the rows a request sends', () => {
  it('every mark comes back as the stored row has it, whatever the request says', async () => {
    const [marked, old] = twoRows();
    await updateUnit({
      monthlyCharges: [
        { ...marked, carry: false },
        { ...old, carry: 'true' }
      ]
    });
    expect(rows()).toEqual([
      [OCT, 30, true],
      [OCT, 20, false]
    ]);
    expect(state.saves).toBe(1);
  });

  it('…also when the id comes in upper case', async () => {
    const [marked] = twoRows();
    await updateUnit({
      monthlyCharges: [{ ...marked, _id: String(marked._id).toUpperCase(), carry: false }]
    });
    expect(rows()).toEqual([[OCT, 30, true]]);
  });

  it.each([
    ['one row object', (m) => ({ monthlyCharges: { ...m, carry: 'true' } })],
    ['a path to a row’s mark', () => ({ 'monthlyCharges.1.carry': true })],
    ['a path to a whole row', () => ({ 'monthlyCharges.1': { carry: true } })],
    ['a path with an operator', () => ({ 'monthlyCharges.$[].carry': true })],
    ['a row that is not an object', (m) => ({ monthlyCharges: [m, 'row'] })],
    ['a row whose _id is an object', (m) => ({ monthlyCharges: [{ ...m, _id: { _id: String(m._id) } }] })],
    ['a row whose expenseId is an object', (m) => ({ monthlyCharges: [{ ...m, expenseId: { _id: 'e-new' } }] })],
    ['a row whose term is an object', (m) => ({ monthlyCharges: [{ ...m, term: { $gt: 0 } }] })],
    ['a row whose _id is a list', (m) => ({ monthlyCharges: [{ ...m, _id: [String(m._id)] }] })],
    ['a row that is a list of rows', (m) => ({ monthlyCharges: [[m]] })],
    ['a row whose _id is twelve characters (the schema reads that as an id too)', (m) => ({ monthlyCharges: [{ ...m, _id: 'abcdefghijkl' }] })],
    ['a marked row moved to another month', (m) => ({ monthlyCharges: [{ ...m, term: NOV }] })],
    ['a marked row given another expense', (m) => ({ monthlyCharges: [{ ...m, expenseId: 'e-other' }] })],
    ['a marked row made a repair’s', (m) => ({ monthlyCharges: [{ ...m, repairId: 'r-1' }] })],
    ['a marked row with another description', (m) => ({ monthlyCharges: [{ ...m, description: 'Renamed by hand' }] })],
    ['a marked row sent back without its description (the rows sent replace the stored ones)', (m) => ({ monthlyCharges: [{ _id: m._id, term: m.term, amount: m.amount, expenseId: m.expenseId }] })],
    ['a marked row sent back without its expense', (m) => ({ monthlyCharges: [{ _id: m._id, term: m.term, amount: m.amount, description: m.description }] })],
    ['two rows with one _id', (m) => ({ monthlyCharges: [m, { ...m, term: NOV, amount: 7 }] })],
    ['two rows with one _id, in another case', (m) => ({ monthlyCharges: [m, { ...m, _id: String(m._id).toUpperCase(), term: NOV }] })]
  ])('%s: refused, and nothing is saved', async (_what, body) => {
    const [marked] = twoRows();
    const before = JSON.stringify(rows());
    await expect(updateUnit(body(marked))).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/monthlyCharges|share of a monthly statement/)
    });
    expect(JSON.stringify(rows())).toBe(before);
    expect(state.saves).toBe(0);
  });

  it('a request that sends no rows leaves them alone', async () => {
    twoRows();
    await updateUnit({});
    expect(rows()).toEqual([
      [OCT, 30, true],
      [OCT, 20, false]
    ]);
  });

  it('a marked row can change its amount; a row with no mark can change anything', async () => {
    const [marked, old] = twoRows();
    await updateUnit({
      monthlyCharges: [
        { ...marked, amount: 31 },
        { ...old, term: NOV, description: 'Something else', amount: 21 }
      ]
    });
    expect(rows()).toEqual([
      [OCT, 31, true],
      [NOV, 21, false]
    ]);
  });

  // Round-4 review tried these on the real handlers: each is accepted and reaches
  // nothing (the schema is strict, and `set()` follows only the paths it knows).
  // Pinned so that a change to the refusals above cannot open one of them unnoticed.
  it.each([
    ['a `__proto__` key in a row', (m, old) => ({ monthlyCharges: [m, JSON.parse(`{"__proto__":{"carry":true},"_id":"${old._id}","term":${old.term},"amount":${old.amount},"description":"Water","expenseId":"e-old"}`)] })],
    ['a `constructor` key in a row', (m, old) => ({ monthlyCharges: [m, { ...old, constructor: { carry: true } }] })],
    ['the mark under another spelling', (m, old) => ({ monthlyCharges: [m, { ...old, Carry: true, CARRY: true }] })],
    ['an operator inside a row', (m, old) => ({ monthlyCharges: [m, { ...old, $set: { carry: true } }] })],
    ['a path in brackets', () => ({ 'monthlyCharges[1].carry': true })],
    ['a path in upper case', () => ({ 'MonthlyCharges.1.carry': true })],
    ['a path after a space', () => ({ ' monthlyCharges.1.carry': true })],
    ['the `id` of another row on a row', (m, old) => ({ monthlyCharges: [m, { ...old, id: String(m._id) }] })]
  ])('%s: accepted, and every mark is as it was', async (_what, body) => {
    const [marked, old] = twoRows();
    await updateUnit(body(marked, old));
    expect(
      unit().monthlyCharges.map((c) => [String(c._id), c.term, c.amount, c.carry === true])
    ).toEqual([
      [String(marked._id), OCT, 30, true],
      [String(old._id), OCT, 20, false]
    ]);
  });

  it('a marked row that is left out of the request is removed; sent back without its id it is a new row, with no mark', async () => {
    const [marked, old] = twoRows();
    const { _id: _gone, ...withoutId } = marked;
    await updateUnit({ monthlyCharges: [withoutId, old] });
    expect(rows()).toEqual([
      [OCT, 30, false],
      [OCT, 20, false]
    ]);
    twoRows();
    await updateUnit({ monthlyCharges: [] });
    expect(rows()).toEqual([]);
  });
});

describe('addUnit and building create: the same refusals, and no mark on a new unit', () => {
  const newUnit = (monthlyCharges) => ({
    atakNumber: '99970000002',
    isManaged: false,
    occupancyType: 'vacant',
    generalThousandths: 0,
    heatingThousandths: 0,
    elevatorThousandths: 0,
    monthlyCharges
  });

  it('addUnit: rows as one object, or two rows with one id, are refused', async () => {
    store();
    const add = (monthlyCharges) =>
      buildingManager.addUnit(
        {
          realm: { _id: 'r1', locale: 'el' },
          params: { id: BUILDING },
          body: newUnit(monthlyCharges)
        },
        makeRes()
      );
    await expect(
      add({ term: OCT, amount: 5, carry: true })
    ).rejects.toMatchObject({
      status: 422,
      message: 'monthlyCharges must be a list of rows'
    });
    await expect(
      add([
        { _id: 'aaaaaaaaaaaaaaaaaaaa4aaa', term: OCT, amount: 5 },
        { _id: 'aaaaaaaaaaaaaaaaaaaa4aaa', term: NOV, amount: 5 }
      ])
    ).rejects.toMatchObject({
      status: 422,
      message: 'two monthlyCharges rows have the same _id'
    });
    expect(state.building.units).toHaveLength(1);
    expect(state.saves).toBe(0);
  });

  it('building create: a unit whose rows are one object, or two rows with one id, is refused and nothing is created', async () => {
    const create = (monthlyCharges) =>
      buildingManager.add(
        {
          realm: { _id: 'r1', locale: 'el' },
          body: {
            name: 'Building 2',
            atakPrefix: '999708',
            address: { street1: 'ΟΔΟΣ ΒΗΤΑ 2', city: 'ΔΟΚΙΜΑΙ', zipCode: '00000' },
            units: [newUnit(monthlyCharges)]
          }
        },
        makeRes()
      );
    // (no building with that ATAK prefix exists yet)
    state.building = null;
    state.saves = 0;
    state.created = undefined;
    await expect(
      create({ term: OCT, amount: 5, carry: true })
    ).rejects.toMatchObject({
      status: 422,
      message: 'monthlyCharges must be a list of rows'
    });
    await expect(
      create([
        { _id: 'aaaaaaaaaaaaaaaaaaaa4aaa', term: OCT, amount: 5 },
        { _id: 'aaaaaaaaaaaaaaaaaaaa4aaa', term: NOV, amount: 5 }
      ])
    ).rejects.toMatchObject({
      status: 422,
      message: 'two monthlyCharges rows have the same _id'
    });
    expect([state.created, state.saves]).toEqual([undefined, 0]);
  });

  it('building create: the rows of its units are never marked', async () => {
    state.building = null;
    state.saves = 0;
    await buildingManager.add(
      {
        realm: { _id: 'r1', locale: 'el' },
        body: {
          name: 'Building 2',
          atakPrefix: '999708',
          address: { street1: 'ΟΔΟΣ ΒΗΤΑ 2', city: 'ΔΟΚΙΜΑΙ', zipCode: '00000' },
          units: [newUnit([{ term: OCT, amount: 5, description: 'x', carry: true }])]
        }
      },
      makeRes()
    );
    expect(state.saves).toBe(1);
    expect(
      state.created.units[0].monthlyCharges.map((c) => [c.amount, c.carry === true])
    ).toEqual([[5, false]]);
  });

  it('addUnit: a new unit’s rows are never marked', async () => {
    store();
    await buildingManager.addUnit(
      {
        realm: { _id: 'r1', locale: 'el' },
        params: { id: BUILDING },
        body: newUnit([{ term: OCT, amount: 5, description: 'x', carry: true }])
      },
      makeRes()
    );
    expect(
      state.building.units[1].monthlyCharges.map((c) => [c.amount, c.carry === true])
    ).toEqual([[5, false]]);
  });
});

describe('the statement save: one entry for an expense, named as the building holds it', () => {
  const save = (expenses, term = String(OCT)) =>
    buildingManager.saveMonthlyStatement(
      {
        realm: { _id: 'r1', locale: 'el' },
        params: { id: BUILDING },
        body: { term, expenses }
      },
      makeRes()
    );

  it('an entry writes one marked row, with the expense’s id as the building stores it', async () => {
    store();
    await save([{ expenseId: expenseId().toUpperCase(), amount: 60 }]);
    expect(
      unit().monthlyCharges.map((c) => [c.amount, c.expenseId, c.carry === true])
    ).toEqual([[60, expenseId(), true]]);
  });

  it.each([
    ['the same id twice', (e) => [e, e]],
    ['the id, and the id in upper case', (e) => [e, e.toUpperCase()]]
  ])('%s: refused as an expense listed twice, nothing written', async (_what, ids) => {
    store();
    await expect(
      save(ids(expenseId()).map((id, i) => ({ expenseId: id, amount: 20 + i * 10 })))
    ).rejects.toMatchObject({
      status: 422,
      message: `expenseId ${expenseId()} is listed twice in expenses`
    });
    expect(unit().monthlyCharges).toHaveLength(0);
    expect(state.saves).toBe(0);
  });

  it.each([
    ['an object that holds the id', (e) => ({ _id: e })],
    ['a list that holds the id', (e) => [e]]
  ])('an expense named by %s: refused, nothing written', async (_what, spelled) => {
    store();
    await expect(
      save([
        { expenseId: expenseId(), amount: 20 },
        { expenseId: spelled(expenseId()), amount: 30 }
      ])
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      save([{ expenseId: spelled(expenseId()), amount: 30 }])
    ).rejects.toMatchObject({ status: 422 });
    expect(unit().monthlyCharges).toHaveLength(0);
    expect(state.saves).toBe(0);
  });

  it('a row of NO expense is not a share of one: it is never marked', async () => {
    store();
    await save([{ amount: 40, description: 'Something else' }]);
    expect(unit().monthlyCharges.map((c) => c.carry === true)).not.toContain(true);
  });

  it('saved again, a share keeps its row and its mark; the row from before the mark gains none', async () => {
    const doc = store([
      { term: OCT, amount: 30, inputAmount: 60, description: 'Common power', expenseId: 'x' }
    ]);
    // the stored row is this expense's, from before the mark existed
    unit().monthlyCharges[0].expenseId = String(doc.expenses[0]._id);
    const id = String(unit().monthlyCharges[0]._id);
    await save([{ expenseId: expenseId(), amount: 80 }]);
    expect(
      unit().monthlyCharges.map((c) => [String(c._id), c.amount, c.carry === true])
    ).toEqual([[id, 80, false]]);
    // …and a month that had no row gets a marked one, which keeps its mark and its id
    await save([{ expenseId: expenseId(), amount: 50 }], String(NOV));
    const november = unit().monthlyCharges.find((c) => c.term === NOV);
    expect(november.carry).toBe(true);
    await save([{ expenseId: expenseId(), amount: 70 }], String(NOV));
    expect(
      unit()
        .monthlyCharges.filter((c) => c.term === NOV)
        .map((c) => [String(c._id), c.amount, c.carry === true])
    ).toEqual([[String(november._id), 70, true]]);
  });
});

describe('the manual-row edit: a marked row can only change its amount', () => {
  const edit = (chargeId, body) =>
    buildingManager.updateMonthlyCharge(
      {
        realm: { _id: 'r1', locale: 'el' },
        params: { id: BUILDING, unitId: String(unit()._id), chargeId: String(chargeId) },
        body
      },
      makeRes()
    );

  it('another amount: the same share, the mark stays', async () => {
    const [marked] = twoRows();
    await edit(marked._id, { amount: 31 });
    expect(rows()[0]).toEqual([OCT, 31, true]);
    // …also when the rest of the row is sent back as it is
    await edit(marked._id, {
      amount: 32,
      term: String(OCT),
      description: 'Common power',
      expenseId: 'e-new'
    });
    expect(rows()[0]).toEqual([OCT, 32, true]);
  });

  // Each of these made the row another share. Keeping the mark on it billed a share
  // twice (a description changed by hand no longer read like the old rent line that
  // covered the row); taking the mark off lost it for good when the change was undone
  // (found by review, both). So the edit is refused: nothing moves, nothing is lost.
  it.each([
    ['another month', { term: String(NOV) }],
    ['another expense', { expenseId: 'e-other' }],
    ['no expense', { expenseId: null }],
    ['a repair', { repairId: 'r-1' }],
    ['another description', { description: 'Common power (corrected)' }]
  ])('%s: refused, and the row is as it was', async (_what, body) => {
    const [marked] = twoRows();
    await expect(edit(marked._id, body)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('share of a monthly statement')
    });
    expect(
      unit().monthlyCharges.map((c) => [c.term, c.amount, c.description, c.expenseId, c.carry === true])[0]
    ).toEqual([OCT, 30, 'Common power', 'e-new', true]);
    expect(state.saves).toBe(0);
  });

  it('a row that carries no mark can be changed as before', async () => {
    const [, old] = twoRows();
    await edit(old._id, { term: String(NOV), description: 'Something else', amount: 21 });
    expect(rows()[1]).toEqual([NOV, 21, false]);
  });

  it('the mark cannot be set by the request, on a row that has none', async () => {
    const [, old] = twoRows();
    await edit(old._id, { carry: true, amount: 21 });
    expect(rows()[1]).toEqual([OCT, 21, false]);
  });

  it('the row’s id is not for the request to change', async () => {
    const [marked, old] = twoRows();
    await edit(old._id, { _id: String(marked._id), amount: 22 });
    expect(unit().monthlyCharges.map((c) => String(c._id))).toEqual([
      String(marked._id),
      String(old._id)
    ]);
  });
});

describe('the manual-row add: the new row gets an id of its own', () => {
  const add = (body) =>
    buildingManager.addMonthlyCharge(
      {
        realm: { _id: 'r1', locale: 'el' },
        params: { id: BUILDING, unitId: String(unit()._id) },
        body: { term: String(NOV), amount: 5, description: 'By hand', ...body }
      },
      makeRes()
    );
  const ids = () => unit().monthlyCharges.map((c) => String(c._id));

  // With the id of a stored row the unit held two rows under one id, and the next
  // ordinary statement save — which removes its rows by id — took October's marked
  // share with the new row (found by review).
  it.each([
    ['the id of the marked row', (m) => String(m._id)],
    ['that id in upper case', (m) => String(m._id).toUpperCase()],
    ['twelve characters (the schema reads those as an id too)', () => 'abcdefghijkl']
  ])('%s in the request is ignored', async (_what, id) => {
    const [marked, old] = twoRows();
    await add({ _id: id(marked) });
    expect(rows()).toEqual([
      [OCT, 30, true],
      [OCT, 20, false],
      [NOV, 5, false]
    ]);
    expect(ids().slice(0, 2)).toEqual([String(marked._id), String(old._id)]);
    expect(new Set(ids()).size).toBe(3);
    expect(ids()[2]).toMatch(/^[0-9a-f]{24}$/);
    expect(ids()[2]).not.toBe('6162636465666768696a6b6c');
  });

  it('…and a new manual row is never marked', async () => {
    twoRows();
    await add({ carry: true, expenseId: 'e-new' });
    expect(rows()[2]).toEqual([NOV, 5, false]);
  });
});

// The building page asks the tenants' rents where each share is (`_placeTenantShares`),
// and the statement save answers the same (`_statementOutcome`). Both have to tell the
// read-back which expenses are billed LIVE in that month: without that, a fixed
// expense's old line — which no row takes — at the amount of a share that reached no
// rent made that share read «charged» (found by review; one unit and today's ledgers
// are enough).
describe('the page and the statement answer tell an expense’s own old line from a share’s', () => {
  const months = [2026070100, 2026080100, 2026090100, OCT, NOV, 2026120100];
  // a tenant of the unit since July; July–October are paid, and October's rent holds
  // `octoberLines` as the version before this change wrote them: no ids
  const tenantWith = (octoberLines) => ({
    _id: 'aaaaaaaaaaaaaaaaaaaa4777',
    name: 'TENANT ALFA',
    frequency: 'months',
    realmId: 'r1',
    beginDate: new Date('2026-07-01T00:00:00Z'),
    endDate: new Date('2027-06-30T23:59:59Z'),
    terminationDate: null,
    properties: [
      {
        propertyId: PROPERTY,
        entryDate: new Date('2026-07-01T00:00:00Z'),
        exitDate: new Date('2027-06-30T23:59:59Z')
      }
    ],
    rents: months.map((term) => ({
      term,
      buildingCharges: term === OCT ? octoberLines : [],
      total: { grandTotal: 415, payment: term < NOV ? 415 : 0, balance: 0 }
    }))
  });
  const pageOf = async (term) => {
    const res = makeRes();
    await buildingManager.getExpenseBreakdown(
      {
        realm: { _id: 'r1', locale: 'el' },
        params: { id: BUILDING },
        query: { term: String(term) }
      },
      res
    );
    return res.json.mock.calls[0][0];
  };
  const billingOf = (answer, expense) =>
    (
      answer.rows.find(
        (r) => r.recipient === 'renter' && r.expenseId === String(expense._id)
      ).billing || []
    ).map((b) => [b.status, b.reason]);
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-15T12:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
    state.tenants = [];
  });

  // «Cleaning» is fixed (15 a month for this unit, the building's only one) and billed
  // live. October's power share, 15 as well, was typed in after October closed: it is
  // on no rent.
  const prepare = () => {
    const doc = store([
      { term: OCT, amount: 15, inputAmount: 15, description: 'Common power', expenseId: 'x' }
    ]);
    unit().monthlyCharges[0].expenseId = String(doc.expenses[0]._id);
    unit().occupancyType = 'rented';
    doc.expenses.push({
      name: 'Cleaning',
      type: 'cleaning',
      amount: 15,
      allocationMethod: 'general_thousandths',
      isRecurring: true,
      startTerm: 2026010100
    });
    state.tenants = [
      tenantWith([
        { description: 'Cleaning', amount: 15, buildingName: 'Building 1', type: 'cleaning' }
      ])
    ];
    return doc;
  };

  it('the page of October: the power share reads «not charged», and the tenants’ total is what October’s rent holds', async () => {
    const doc = prepare();
    const answer = await pageOf(OCT);
    expect(billingOf(answer, doc.expenses[0])).toEqual([['notCharged', 'notCarried']]);
    // the cleaning share (15) and nothing of the power share
    expect(answer.tenantTotal).toBe(15);
  });

  it('the statement answer for October: the power share is not «billed» on the strength of the cleaning line', async () => {
    const doc = prepare();
    // typed again: the share is a new row of October now, and marked
    unit().monthlyCharges.pull(unit().monthlyCharges[0]._id);
    const res = makeRes();
    await buildingManager.saveMonthlyStatement(
      {
        realm: { _id: 'r1', locale: 'el' },
        params: { id: BUILDING },
        body: {
          term: String(OCT),
          expenses: [{ expenseId: String(doc.expenses[0]._id), amount: 15 }]
        }
      },
      res
    );
    const answer = res.json.mock.calls[0][0];
    // (the tenants' rents are a stand-in here and are not priced again: a marked
    // share that reached no rent while a month is open reads «missing»)
    expect(
      answer.statementOutcome.map((o) => [o.amount, o.status, o.billedTerm])
    ).toEqual([[15, 'missing', null]]);
  });

  // The other way round (found by the next review). The share WAS billed in October,
  // as «Common power 15». Its expense is called «Stair lights» today and October was
  // saved again, so the row reads the new name — and ANOTHER expense is called «Common
  // power» now. Only if that one is billed live in October can the old line be its own.
  const renamed = (namesake) => {
    const doc = store([
      { term: OCT, amount: 15, inputAmount: 15, description: 'Stair lights', expenseId: 'x' }
    ]);
    unit().monthlyCharges[0].expenseId = String(doc.expenses[0]._id);
    unit().occupancyType = 'rented';
    doc.expenses[0].name = 'Stair lights';
    doc.expenses.push({
      name: 'Common power',
      type: 'electricity_common',
      allocationMethod: 'general_thousandths',
      isRecurring: true,
      startTerm: 2026010100,
      ...namesake
    });
    state.tenants = [
      tenantWith([
        { description: 'Common power', amount: 15, buildingName: 'Building 1', type: 'electricity_common' }
      ])
    ];
    return doc;
  };

  // an expense split by fixed amounts per unit has no amount of its own
  const perUnit = (propertyId, value) => ({
    amount: 0,
    allocationMethod: 'fixed',
    customAllocations: [{ propertyId, value }]
  });

  it.each([
    ['one whose figure is typed in every month', { amount: 0 }],
    ['one that had ended before October', { amount: 15, endTerm: 2026090100 }],
    ['one that begins after October', { amount: 15, startTerm: 2026110100 }],
    ['a one-off of another month', { amount: 15, isRecurring: false, startTerm: 2026080100 }],
    ['one split by fixed amounts that gives no unit of the building anything', perUnit('aaaaaaaaaaaaaaaaaaaa4999', 15)]
  ])('the old name is another expense’s today — %s: the share still reads as charged', async (_what, namesake) => {
    const doc = renamed(namesake);
    const answer = await pageOf(OCT);
    // no line under the row: it is on October's rent, at the amount shown
    expect(billingOf(answer, doc.expenses[0])).toEqual([]);
    expect(answer.tenantTotal).toBe(15);
  });

  it('…and the statement answer says the same when October is saved again: billed, on October', async () => {
    const doc = renamed({ amount: 0 });
    const res = makeRes();
    await buildingManager.saveMonthlyStatement(
      {
        realm: { _id: 'r1', locale: 'el' },
        params: { id: BUILDING },
        body: {
          term: String(OCT),
          expenses: [{ expenseId: String(doc.expenses[0]._id), amount: 15 }]
        }
      },
      res
    );
    // (the row is the one that was there: it keeps its id and gains no mark)
    expect(rows()).toEqual([[OCT, 15, false]]);
    expect(
      res.json.mock.calls[0][0].statementOutcome.map((o) => [
        o.amount,
        o.status,
        o.billedTerm,
        o.billedAmount
      ])
    ).toEqual([[15, 'billed', OCT, 15]]);
  });

  it.each([
    ['with a monthly amount of its own', { amount: 15 }],
    // (found by the review after that: going by the expense's amount, this one's line
    // was taken for the share's)
    ['split by fixed amounts per unit, its own amount 0', perUnit(PROPERTY, 15)]
  ])('…one that IS billed live in October, %s: the line is taken for that expense’s own, and the share reads «not charged» (a limit that is written down)', async (_what, namesake) => {
    const doc = renamed(namesake);
    const answer = await pageOf(OCT);
    expect(billingOf(answer, doc.expenses[0])).toEqual([['notCharged', 'notCarried']]);
  });

  it('…and it is billed live in October also when the unit holds a stored row of it for ANOTHER month', async () => {
    // (only a stored row of the month itself replaces the live share)
    const doc = renamed({ amount: 15 });
    unit().monthlyCharges.push({
      term: 2026090100,
      amount: 7,
      description: 'DEH',
      expenseId: String(doc.expenses[1]._id)
    });
    const answer = await pageOf(OCT);
    expect(billingOf(answer, doc.expenses[0])).toEqual([['notCharged', 'notCarried']]);
  });

  it('…and one that the unit holds a stored row of for October was billed from that row, not live', async () => {
    // The engine's rule: a stored row of the month replaces the live share. Here the
    // namesake's October figure came from a bill, whose import named the row «DEH»:
    // October's rent holds that row's line (7) and the old share's (15). The namesake
    // billed nothing live in October, so the «Common power» line is not its own.
    const doc = renamed({ amount: 15 });
    unit().monthlyCharges.push({
      term: OCT,
      amount: 7,
      description: 'DEH',
      expenseId: String(doc.expenses[1]._id)
    });
    state.tenants[0].rents
      .find((r) => r.term === OCT)
      .buildingCharges.push({
        description: 'DEH',
        amount: 7,
        buildingName: 'Building 1',
        type: 'electricity_common'
      });
    const answer = await pageOf(OCT);
    expect(billingOf(answer, doc.expenses[0])).toEqual([]);
    expect(billingOf(answer, doc.expenses[1])).toEqual([]);
    expect(answer.tenantTotal).toBe(22);
  });
});
