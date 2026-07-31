/* eslint-env node, jest */
// RENAME-BACKFILL (bill-OCR audit 2026-07) — renaming a building expense must
// stamp its LEGACY null-key monthlyCharges with the expense id while the old
// name is still known. Without it, saveMonthlyStatement can no longer recognise
// those rows as its own (it matches description === expense.name), the
// expenseId-scoped strip leaves them, and the rebuild adds a SECOND row for the
// same expense+term → the tenant is charged twice for one month.
//
// Mirrors thousandthsGuard.test.js: mock @microrealestate/common (must export
// EVERY symbol the buildingmanager import chain pulls — OwnerStatement and
// ShareBasis are loaded from the real source, per the documented mock-surface
// trap) then import the exported pure helper.
import { jest } from '@jest/globals';

let _stampLegacyChargesBeforeRename;
let updateExpense;
// Mutable holder so the handler-driven suite below can swap the building the
// mocked Collections.Building.findOne returns, per test.
const state = { building: null };

beforeAll(async () => {
  const OwnerStatement = await import(
    '../../../common/src/utils/ownerstatement.ts'
  );
  const ShareBasis = await import('../../../common/src/utils/sharebasis.ts');
  // Query-like thenable exposing .lean()/.select(), matching what the
  // buildingmanager read paths chain onto Collections.*.find().
  const query = (v) => {
    const p = Promise.resolve(v);
    p.lean = async () => v;
    p.select = () => query(v);
    return p;
  };
  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: {
      Building: {
        // updateExpense does findOne (not lean) then mutates + saves.
        findOne: () => query(state.building),
        find: () => query(state.building ? [state.building] : [])
      },
      Property: {
        findOne: () => query(null),
        find: () => query([]),
        findOneAndUpdate: () => query(null),
        updateOne: () => query(null)
      },
      Tenant: {
        // No tenants: _recomputeTenantsForBuilding and _toBuildingData both
        // early-out, keeping this test scoped to the stamp wiring.
        find: () => query([]),
        findOne: () => query(null)
      },
      ObjectId: class {
        constructor(v) {
          this.v = v;
        }
      }
    },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    ServiceError: class ServiceError extends Error {
      constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
      }
    },
    OwnerStatement,
    ShareBasis,
    Pagination: {},
    Service: { getInstance: () => ({ envConfig: { getValues: () => ({}) } }) },
    Crypto: { encrypt: (v) => v, decrypt: (v) => v }
  }));
  jest.unstable_mockModule('../managers/occupantmanager.js', () => ({
    _attachTenantGroupsToBuildings: async () => {}
  }));
  const bm = await import('../managers/buildingmanager.js');
  _stampLegacyChargesBeforeRename = bm._stampLegacyChargesBeforeRename;
  updateExpense = bm.updateExpense;
});

const OLD = 'ΔΕΗ ΚΟΙΝΟΧΡΗΣΤΑ';
const NEW = 'ΔΕΗ Κοινόχρηστα (ΝΕΟ)';
const EID = 'e1';

// A legacy row: expenseId null + repairId null, identified only by description.
const legacyRow = (over = {}) => ({
  term: 2026050100,
  amount: 40,
  description: OLD,
  expenseId: null,
  repairId: null,
  ...over
});

const mkBuilding = (charges, expenses = [{ _id: EID, name: OLD }]) => ({
  expenses,
  units: [{ propertyId: 'p1', monthlyCharges: charges }]
});

const expenseDoc = (name = OLD, _id = EID) => ({ _id, name });

describe('_stampLegacyChargesBeforeRename — stamps on a real rename', () => {
  it('stamps a legacy null-key row whose description matches the OLD name', () => {
    const rows = [legacyRow()];
    const b = mkBuilding(rows);
    _stampLegacyChargesBeforeRename(b, expenseDoc(), NEW);
    expect(rows[0].expenseId).toBe(EID);
  });

  it('stamps rows across MULTIPLE units and MULTIPLE terms', () => {
    // Not term-scoped on purpose: every term's rows carry the same defect, and
    // writing expenseId changes no amount.
    const a = legacyRow({ term: 2026050100 });
    const c = legacyRow({ term: 2026050200 });
    const d = legacyRow({ term: 2026050100 });
    const b = {
      expenses: [{ _id: EID, name: OLD }],
      units: [
        { propertyId: 'p1', monthlyCharges: [a, c] },
        { propertyId: 'p2', monthlyCharges: [d] }
      ]
    };
    _stampLegacyChargesBeforeRename(b, expenseDoc(), NEW);
    expect([a.expenseId, c.expenseId, d.expenseId]).toEqual([EID, EID, EID]);
  });

  it('ignores surrounding whitespace on both sides of the comparison', () => {
    const rows = [legacyRow({ description: `  ${OLD}  ` })];
    const b = mkBuilding(rows, [{ _id: EID, name: ` ${OLD} ` }]);
    _stampLegacyChargesBeforeRename(b, expenseDoc(` ${OLD} `), NEW);
    expect(rows[0].expenseId).toBe(EID);
  });
});

describe('_stampLegacyChargesBeforeRename — must NOT stamp', () => {
  it('does nothing when the PATCH does not touch the name (undefined)', () => {
    // e.g. PATCH {amount: 200} — by far the most common expense edit.
    const rows = [legacyRow()];
    _stampLegacyChargesBeforeRename(mkBuilding(rows), expenseDoc(), undefined);
    expect(rows[0].expenseId).toBeNull();
  });

  it('does nothing when the name is re-sent UNCHANGED', () => {
    const rows = [legacyRow()];
    _stampLegacyChargesBeforeRename(mkBuilding(rows), expenseDoc(), OLD);
    expect(rows[0].expenseId).toBeNull();
  });

  it('does nothing when the new name differs only by whitespace', () => {
    const rows = [legacyRow()];
    _stampLegacyChargesBeforeRename(mkBuilding(rows), expenseDoc(), ` ${OLD} `);
    expect(rows[0].expenseId).toBeNull();
  });

  it('does NOT claim a row that already has an expenseId', () => {
    // Already-keyed rows are recognised without any description match. Claiming
    // one here could RE-KEY another expense's row to this expense — the strip
    // would then wipe a sibling expense's charge on the next statement save.
    const rows = [legacyRow({ expenseId: 'other-expense' })];
    _stampLegacyChargesBeforeRename(mkBuilding(rows), expenseDoc(), NEW);
    expect(rows[0].expenseId).toBe('other-expense');
  });

  it('does NOT claim a REPAIR row (repairId set)', () => {
    // Repair rows are owned by _distributeRepairCharge; stamping an expenseId on
    // one would make the statement strip delete a tenant's repair charge.
    const rows = [legacyRow({ repairId: 'r1', expenseId: null })];
    _stampLegacyChargesBeforeRename(mkBuilding(rows), expenseDoc(), NEW);
    expect(rows[0].expenseId).toBeNull();
  });

  it("does NOT claim a legacy 'Repair: ' description row", () => {
    const rows = [legacyRow({ description: `Repair: ${OLD}` })];
    _stampLegacyChargesBeforeRename(mkBuilding(rows), expenseDoc(), NEW);
    expect(rows[0].expenseId).toBeNull();
  });

  it('does NOT claim a manual charge with a DIFFERENT description', () => {
    const rows = [legacyRow({ description: 'Καθαριότητα κλιμακοστασίου' })];
    _stampLegacyChargesBeforeRename(mkBuilding(rows), expenseDoc(), NEW);
    expect(rows[0].expenseId).toBeNull();
  });

  it('does NOT claim a row with an empty description', () => {
    const rows = [legacyRow({ description: '' })];
    _stampLegacyChargesBeforeRename(mkBuilding(rows), expenseDoc(), NEW);
    expect(rows[0].expenseId).toBeNull();
  });

  it('refuses to guess when TWO expenses share the old name', () => {
    // Ambiguous: stamping would attribute the row to whichever expense happened
    // to be renamed first. The statement-save path handles the ambiguous case
    // by stripping instead of stamping; here we simply decline.
    const rows = [legacyRow()];
    const b = mkBuilding(rows, [
      { _id: EID, name: OLD },
      { _id: 'e2', name: OLD }
    ]);
    _stampLegacyChargesBeforeRename(b, expenseDoc(), NEW);
    expect(rows[0].expenseId).toBeNull();
  });

  it('does nothing when the new name is blank (rename to empty is rejected upstream)', () => {
    const rows = [legacyRow()];
    _stampLegacyChargesBeforeRename(mkBuilding(rows), expenseDoc(), '   ');
    expect(rows[0].expenseId).toBeNull();
  });

  it('does nothing when the expense has no old name to match on', () => {
    const rows = [legacyRow({ description: 'something' })];
    const b = mkBuilding(rows, [{ _id: EID, name: '' }]);
    _stampLegacyChargesBeforeRename(b, expenseDoc(''), NEW);
    expect(rows[0].expenseId).toBeNull();
  });
});

describe('_stampLegacyChargesBeforeRename — shape tolerance', () => {
  it('tolerates a building with no units / no expenses', () => {
    expect(() =>
      _stampLegacyChargesBeforeRename({}, expenseDoc(), NEW)
    ).not.toThrow();
  });

  it('tolerates a unit with no monthlyCharges array', () => {
    const b = {
      expenses: [{ _id: EID, name: OLD }],
      units: [{ propertyId: 'p1' }]
    };
    expect(() =>
      _stampLegacyChargesBeforeRename(b, expenseDoc(), NEW)
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// WIRING (the coverage gap the mutation test exposed)
// ---------------------------------------------------------------------------
// Every test above calls the helper DIRECTLY. Deleting the helper's call site
// from the real updateExpense handler therefore left all of them green — the
// fix could have been removed from production with the suite still passing.
// These drive the actual HTTP handler so the CALL SITE is covered, not just the
// helper. Mutation-verified: commenting out the
// `_stampLegacyChargesBeforeRename(...)` call in buildingmanager.ts's
// updateExpense makes the first test here FAIL.
const BID = '6a4551f5efd7970071c44002';

function mkHandlerBuilding(charges, expenseName = OLD) {
  const expense = {
    _id: EID,
    name: expenseName,
    amount: 40,
    isRecurring: true,
    startTerm: 2026010100,
    allocationMethod: 'equal',
    customAllocations: [],
    // Mongoose subdoc .set(obj) assigns present keys only.
    set(body) {
      Object.assign(this, body);
    }
  };
  const expenses = [expense];
  // Mongoose DocumentArray exposes .id(uid); emulate it.
  expenses.id = (uid) =>
    expenses.find((e) => String(e._id) === String(uid)) || null;
  const ome = [];
  ome.pull = function (uid) {
    const i = this.findIndex((r) => String(r._id) === String(uid));
    if (i >= 0) this.splice(i, 1);
  };
  const building = {
    _id: BID,
    realmId: 'r1',
    name: 'Κτίριο',
    expenses,
    ownerMonthlyExpenses: ome,
    units: [
      {
        _id: 'u1',
        propertyId: 'p1',
        isManaged: true,
        occupancyType: 'vacant',
        generalThousandths: 1000,
        monthlyCharges: charges
      }
    ],
    save: async () => building,
    toObject: () => building
  };
  return building;
}

function renameReq(newName) {
  return {
    realm: { _id: 'r1', locale: 'el' },
    params: { id: BID, expenseId: EID },
    body: { name: newName }
  };
}

function makeRes() {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('updateExpense WIRING — the rename path actually stamps', () => {
  it('PATCH {name} on the real handler stamps the legacy null-key row', async () => {
    // THE MUTATION-KILLER: fails if the helper call is removed from updateExpense.
    const rows = [legacyRow()];
    state.building = mkHandlerBuilding(rows);
    const res = makeRes();

    await updateExpense(renameReq(NEW), res);

    expect(res.json).toHaveBeenCalled();
    expect(rows[0].expenseId).toBe(EID);
    // …and the rename itself still persisted (the stamp must not shadow it).
    expect(state.building.expenses[0].name).toBe(NEW);
  });

  it('stamps BEFORE expense.set() — i.e. matches on the OLD name, not the new one', async () => {
    // Ordering guard. If the call were moved AFTER `expense.set(patchBody)`,
    // oldName would already be the NEW name and nothing would match, so the
    // row would stay unstamped and the duplicate-charge bug would return.
    const rows = [legacyRow()];
    state.building = mkHandlerBuilding(rows);
    await updateExpense(renameReq(NEW), makeRes());
    expect(rows[0].expenseId).toBe(EID);
  });

  it('a PATCH that does NOT touch the name leaves legacy rows alone', async () => {
    // {amount: 200} is the most common expense edit; it must not opportunistically
    // claim description-matched rows (they may belong to a manual charge).
    const rows = [legacyRow()];
    state.building = mkHandlerBuilding(rows);
    const req = renameReq(undefined);
    req.body = { amount: 200 };
    await updateExpense(req, makeRes());
    expect(rows[0].expenseId).toBeNull();
    expect(state.building.expenses[0].amount).toBe(200);
  });

  it('a PATCH re-sending the SAME name does not stamp', async () => {
    const rows = [legacyRow()];
    state.building = mkHandlerBuilding(rows);
    await updateExpense(renameReq(OLD), makeRes());
    expect(rows[0].expenseId).toBeNull();
  });
});
