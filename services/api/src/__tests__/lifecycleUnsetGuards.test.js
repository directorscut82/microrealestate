/* eslint-env node, jest */
/**
 * LIFECYCLE $unset + double-occupancy guards — round-1 audit H7 / H8 / H9.
 *
 * Three write paths in occupantmanager that the audit flagged as STILL-BROKEN
 * against HEAD 87399bce (verified by re-reading the code; the 3bd3ee52 money
 * batch did not touch occupantmanager):
 *
 *  H7 — update() un-terminate: clearing terminationDate sends `undefined`, and
 *       Mongoose/Mongo `$set` SILENTLY DROPS undefined keys, so the stale
 *       terminationDate survives → tenant reads terminated-but-active and the
 *       vacant-owner recompute double-bills. The sibling extendLease ALREADY
 *       does `$unset: { terminationDate: '' }` (the outlier is update()).
 *
 *  H8 — unarchive() only `$set: { archived:false }`; a force-archived tenant
 *       (remove ?force=true invents a terminationDate) returns permanently
 *       terminated with no UI path to clear it.
 *
 *  H9 — extendLease() never runs _assertNoDoubleOccupancy, so extending a lease
 *       past a successor tenant's window creates overlapping occupancy
 *       (corrupts equal-allocation party counts). add() + update() both guard.
 *
 * type: module → jest.unstable_mockModule + dynamic import (mirrors
 * realmmanager.test.js). The Collections layer is fully mocked; we assert on
 * the update document captured at the findOneAndUpdate call site.
 */
import { jest } from '@jest/globals';

const TID = '507f1f77bcf86cd799439011';
const REALM = { _id: 'realm123' };

let occupantManager;
const m = {
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  find: jest.fn(),
  exists: jest.fn(),
  propertyFind: jest.fn()
};

beforeAll(async () => {
  class ServiceError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
  // frontdata.ts (transitively imported) needs the REAL OwnerStatement utils.
  const OwnerStatement = await import(
    '../../../common/src/utils/ownerstatement.ts'
  );
  // 1_base (transitively imported) now imports ShareBasis from common — provide the REAL util.
  const ShareBasis = await import(
    '../../../common/src/utils/sharebasis.ts'
  );
  // lean()-able query result helper
  const leanable = (val) => ({ lean: async () => val });
  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: {
      Tenant: {
        findOne: (...a) => leanable(m.findOne(...a)),
        // update() awaits findOneAndUpdate(...)  (no .lean); extendLease awaits
        // findOneAndUpdate(...).lean(). Support both by returning a thenable
        // that ALSO has .lean().
        findOneAndUpdate: (...a) => {
          const doc = m.findOneAndUpdate(...a);
          const p = Promise.resolve(doc);
          p.lean = async () => doc;
          return p;
        },
        find: (...a) => leanable(m.find(...a)),
        exists: (...a) => m.exists(...a),
        // _fetchTenants (called post-write to build the response) — return the
        // re-read doc; irrelevant to the assertions, just must not throw.
        aggregate: async () => [{ _id: TID, name: 'Test Tenant', properties: [], rents: [] }],
        populate: async () => undefined
      },
      Property: { find: (...a) => leanable(m.propertyFind(...a)) },
      Lease: { exists: async () => true },
      ObjectId: class ObjectId {
        constructor(v) {
          this.v = v;
        }
        toString() {
          return String(this.v);
        }
      }
    },
    logger: { info() {}, error() {}, warn() {}, debug() {} },
    ServiceError,
    OwnerStatement,
    ShareBasis,
    Pagination: {},
    Service: { getInstance: () => ({ envConfig: { getValues: () => ({}) } }) }
  }));
  occupantManager = await import('../managers/occupantmanager.js');
});

function makeRes() {
  const res = { json: jest.fn(), status: jest.fn(), sendStatus: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  m.find.mockReturnValue([]); // no double-occupancy collisions by default
  m.propertyFind.mockReturnValue([]);
  m.findOneAndUpdate.mockReturnValue({ _id: TID, __v: 2 });
});

// ── H7: update() un-terminate must $unset terminationDate ──────────────────
describe('H7 — update() clears terminationDate via $unset', () => {
  it('emits $unset:{terminationDate:""} when the edit clears the termination', async () => {
    // Original tenant is terminated; the edit round-trips the document with an
    // empty terminationDate (the un-terminate action) and NO properties (so we
    // stay on the simple no-rent path).
    m.findOne.mockReturnValue({
      _id: TID,
      realmId: REALM._id,
      name: 'Test Tenant',
      __v: 1,
      terminationDate: new Date('2026-01-01T00:00:00Z'),
      beginDate: new Date('2025-01-01T00:00:00Z'),
      endDate: new Date('2027-01-01T00:00:00Z'),
      properties: [],
      rents: []
    });
    const req = {
      realm: REALM,
      params: { id: TID },
      body: {
        _id: TID,
        __v: 1,
        name: 'Test Tenant',
        terminationDate: '', // ← clearing it
        beginDate: '01/01/2025',
        endDate: '01/01/2027',
        properties: []
      }
    };
    await occupantManager.update(req, makeRes());

    expect(m.findOneAndUpdate).toHaveBeenCalled();
    const [, updateDoc] = m.findOneAndUpdate.mock.calls[0];
    // FAILING-FIRST: today the call is { $set, $inc } with no $unset → this
    // assertion fails. After the fix it carries $unset:{terminationDate:''}.
    expect(updateDoc.$unset).toEqual({ terminationDate: '' });
    // And $set must NOT carry an (undefined) terminationDate key.
    expect('terminationDate' in (updateDoc.$set || {})).toBe(false);
  });

  it('does NOT $unset when the edit keeps a real terminationDate', async () => {
    m.findOne.mockReturnValue({
      _id: TID,
      realmId: REALM._id,
      name: 'Test Tenant',
      __v: 1,
      terminationDate: new Date('2026-01-01T00:00:00Z'),
      beginDate: new Date('2025-01-01T00:00:00Z'),
      endDate: new Date('2027-01-01T00:00:00Z'),
      properties: [],
      rents: []
    });
    const req = {
      realm: REALM,
      params: { id: TID },
      body: {
        _id: TID,
        __v: 1,
        name: 'Test Tenant',
        terminationDate: '01/06/2026', // ← keeping a real value
        beginDate: '01/01/2025',
        endDate: '01/01/2027',
        properties: []
      }
    };
    await occupantManager.update(req, makeRes());
    const [, updateDoc] = m.findOneAndUpdate.mock.calls[0];
    expect(updateDoc.$unset).toBeUndefined();
    // the real value lands via $set
    expect(updateDoc.$set.terminationDate).toBeInstanceOf(Date);
  });
});

// ── H8 (WITHDRAWN after Step-7): unarchive() must PRESERVE a real termination.
// The original fix $unset-ed terminationDate, but that destroys a genuine
// move-out date when a normally-terminated tenant is archived then unarchived
// (the plain Archive button preserves the real date; unarchive can't tell an
// invented date from a real one). So unarchive only flips `archived`.
describe('H8 — unarchive() preserves a real terminationDate', () => {
  it('sets ONLY archived:false, never $unset terminationDate', async () => {
    m.findOneAndUpdate.mockReturnValue({ _id: TID, archived: false });
    const req = { realm: REALM, params: { id: TID } };
    await occupantManager.unarchive(req, makeRes());

    expect(m.findOneAndUpdate).toHaveBeenCalled();
    const [filter, updateDoc] = m.findOneAndUpdate.mock.calls[0];
    expect(filter._id).toBe(TID);
    expect(updateDoc.$set).toEqual({ archived: false });
    // A real termination date must survive unarchive (Step-7 money regression).
    expect(updateDoc.$unset).toBeUndefined();
  });
});

// ── H9: extendLease() must run the double-occupancy guard ───────────────────
describe('H9 — extendLease() guards against overlapping a successor tenant', () => {
  const existing = {
    _id: TID,
    realmId: REALM._id,
    name: 'Tenant A',
    __v: 1,
    taxId: '',
    leaseId: null,
    beginDate: new Date('2026-01-01T00:00:00Z'),
    endDate: new Date('2026-06-30T00:00:00Z'),
    frequency: 'months',
    // No rent data → skips the Contract.update branch, isolating the guard.
    properties: [{ propertyId: 'P1' }]
  };

  it('throws 422 when the extended window overlaps a successor on a shared property', async () => {
    m.findOne.mockReturnValue(existing);
    // A successor tenant B occupies P1 from Jul-Dec 2026; extending A to Sep
    // overlaps Jul-Sep.
    m.find.mockReturnValue([
      {
        _id: 'other-b',
        name: 'Tenant B',
        beginDate: new Date('2026-07-01T00:00:00Z'),
        endDate: new Date('2026-12-31T00:00:00Z'),
        properties: [{ propertyId: 'P1' }]
      }
    ]);
    const req = {
      realm: REALM,
      params: { id: TID },
      body: {
        __v: 1,
        validityStart: '01/01/2026',
        validityEnd: '30/09/2026' // ← extends into B's window
      }
    };
    // FAILING-FIRST: today extendLease never calls the guard → it resolves
    // (writes) instead of throwing. After the fix it throws 422.
    await expect(occupantManager.extendLease(req, makeRes())).rejects.toThrow(
      /already assigned to another tenant/
    );
    expect(m.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('allows the extend when no successor occupies the property', async () => {
    m.findOne.mockReturnValue(existing);
    m.find.mockReturnValue([]); // no other tenants
    const req = {
      realm: REALM,
      params: { id: TID },
      body: {
        __v: 1,
        validityStart: '01/01/2026',
        validityEnd: '30/09/2026'
      }
    };
    await occupantManager.extendLease(req, makeRes());
    expect(m.findOneAndUpdate).toHaveBeenCalled();
  });
});
