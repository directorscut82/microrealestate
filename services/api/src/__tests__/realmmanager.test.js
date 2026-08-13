// This package is `type: module`, so test files run as ESM. The legacy
// hoisted `jest.mock(factory)` API does NOT work under ESM (swc only hoists
// when `jest` is an ambient global, and `jest` must be imported here) — the
// factory would run AFTER the mocked module already loaded. Use the supported
// ESM API instead: jest.unstable_mockModule + a dynamic import() of the unit
// under test, both inside beforeAll so the mock is registered first.
import { jest } from '@jest/globals';

const m = {
  tenantCount: jest.fn(),
  propertyCount: jest.fn(),
  leaseCount: jest.fn(),
  buildingCount: jest.fn(),
  templateDelete: jest.fn(),
  documentDelete: jest.fn(),
  emailDelete: jest.fn(),
  billDelete: jest.fn(),
  realmDelete: jest.fn(),
  realmFindOne: jest.fn(),
  accountFind: jest.fn()
};

let realmManager;

beforeAll(async () => {
  class ServiceError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: {
      Tenant: { countDocuments: (...args) => m.tenantCount(...args) },
      Property: { countDocuments: (...args) => m.propertyCount(...args) },
      Lease: { countDocuments: (...args) => m.leaseCount(...args) },
      Building: { countDocuments: (...args) => m.buildingCount(...args) },
      Template: { deleteMany: (...args) => m.templateDelete(...args) },
      Document: { deleteMany: (...args) => m.documentDelete(...args) },
      Email: { deleteMany: (...args) => m.emailDelete(...args) },
      Bill: { deleteMany: (...args) => m.billDelete(...args) },
      Realm: {
        deleteOne: (...args) => m.realmDelete(...args),
        findOne: (...args) => m.realmFindOne(...args)
      },
      Account: { find: (...args) => m.accountFind(...args) }
    },
    ServiceError,
    Crypto: { encrypt: (v) => `enc_${v}`, decrypt: (v) => v },
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
    logger: {
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn()
    },
    Middlewares: {}
  }));
  // validators.js is pure (no winston/DB) — let the real module load rather
  // than maintain an exhaustive mock surface (it exports CURRENCIES, LOCALES,
  // validateStringField, … that realmmanager imports).
  realmManager = await import('../managers/realmmanager.js');
});

function makeReq(overrides = {}) {
  return {
    params: { id: 'realm123' },
    realms: [{ _id: { toString: () => 'realm123' }, name: 'Test Org' }],
    user: { email: 'admin@test.com', role: 'administrator' },
    ...overrides
  };
}

function makeRes() {
  const res = { sendStatus: jest.fn(), status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('realmmanager.remove', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    m.tenantCount.mockResolvedValue(0);
    m.propertyCount.mockResolvedValue(0);
    m.leaseCount.mockResolvedValue(0);
    m.buildingCount.mockResolvedValue(0);
    m.templateDelete.mockResolvedValue({});
    m.documentDelete.mockResolvedValue({});
    m.emailDelete.mockResolvedValue({});
    m.billDelete.mockResolvedValue({});
    m.realmDelete.mockResolvedValue({});
  });

  it('should throw 422 if realm id is missing', async () => {
    const req = makeReq({ params: {} });
    await expect(realmManager.remove(req, makeRes())).rejects.toThrow(
      'missing realm id'
    );
  });

  it('should throw 404 if realm not found', async () => {
    const req = makeReq({ params: { id: 'nonexistent' } });
    await expect(realmManager.remove(req, makeRes())).rejects.toThrow(
      'organization not found'
    );
  });

  it('should throw 422 if tenants exist', async () => {
    m.tenantCount.mockResolvedValue(3);
    await expect(realmManager.remove(makeReq(), makeRes())).rejects.toThrow(
      '3 tenant(s)'
    );
  });

  it('should throw 422 if properties exist', async () => {
    m.propertyCount.mockResolvedValue(5);
    await expect(realmManager.remove(makeReq(), makeRes())).rejects.toThrow(
      '5 property/ies'
    );
  });

  it('should throw 422 if leases exist', async () => {
    m.leaseCount.mockResolvedValue(2);
    await expect(realmManager.remove(makeReq(), makeRes())).rejects.toThrow(
      '2 lease(s)'
    );
  });

  it('should throw 422 if buildings exist', async () => {
    m.buildingCount.mockResolvedValue(1);
    await expect(realmManager.remove(makeReq(), makeRes())).rejects.toThrow(
      '1 building(s)'
    );
  });

  it('should include ALL blockers in error message', async () => {
    m.tenantCount.mockResolvedValue(2);
    m.propertyCount.mockResolvedValue(3);
    m.leaseCount.mockResolvedValue(1);
    m.buildingCount.mockResolvedValue(4);
    await expect(realmManager.remove(makeReq(), makeRes())).rejects.toThrow(
      '2 tenant(s), 3 property/ies, 1 lease(s), 4 building(s)'
    );
  });

  it('should delete templates, documents, emails, then realm when empty', async () => {
    const res = makeRes();
    await realmManager.remove(makeReq(), res);

    expect(m.templateDelete).toHaveBeenCalledWith({ realmId: 'realm123' });
    expect(m.documentDelete).toHaveBeenCalledWith({ realmId: 'realm123' });
    expect(m.emailDelete).toHaveBeenCalledWith({ realmId: 'realm123' });
    expect(m.realmDelete).toHaveBeenCalledWith({ _id: 'realm123' });
    expect(res.sendStatus).toHaveBeenCalledWith(204);
  });

  it('should verify guard checks run BEFORE any deletions', async () => {
    const callOrder = [];
    m.tenantCount.mockImplementation(() => {
      callOrder.push('count');
      return Promise.resolve(0);
    });
    m.templateDelete.mockImplementation(() => {
      callOrder.push('deleteTemplates');
      return Promise.resolve({});
    });
    m.realmDelete.mockImplementation(() => {
      callOrder.push('deleteRealm');
      return Promise.resolve({});
    });

    await realmManager.remove(makeReq(), makeRes());

    expect(callOrder.indexOf('count')).toBeLessThan(
      callOrder.indexOf('deleteTemplates')
    );
    expect(callOrder.indexOf('deleteTemplates')).toBeLessThan(
      callOrder.indexOf('deleteRealm')
    );
  });

  it('should NOT delete anything if blockers found', async () => {
    m.tenantCount.mockResolvedValue(1);
    try {
      await realmManager.remove(makeReq(), makeRes());
    } catch {
      // expected
    }
    expect(m.templateDelete).not.toHaveBeenCalled();
    expect(m.documentDelete).not.toHaveBeenCalled();
    expect(m.emailDelete).not.toHaveBeenCalled();
    expect(m.realmDelete).not.toHaveBeenCalled();
  });
});

// ── Round-2 audit H6: currency whitelist must accept every ISO code the
//    org-settings dropdown offers, else editing any setting 422-locks the
//    realm forever. The whitelist is now Intl.supportedValuesOf('currency').
describe('realmmanager currency whitelist (round-2 H6)', () => {
  beforeEach(() => jest.clearAllMocks());

  // The currency check at update() line ~228 fires BEFORE any DB read, so a
  // rejected currency throws synchronously regardless of realm state.
  function updateReq(currency) {
    return {
      realm: { _id: 'realm123', name: 'Test Org' },
      realms: [{ _id: { toString: () => 'realm123' }, name: 'Test Org' }],
      user: { email: 'admin@test.com', role: 'administrator' },
      body: {
        _id: 'realm123',
        name: 'Test Org',
        locale: 'en-US',
        currency
      }
    };
  }

  it('ACCEPTS a dropdown-offered ISO currency (AED) that the old 14-entry list rejected', async () => {
    // FAILING-FIRST against the old narrow list: AED → "Invalid currency" 422.
    // The NumberFormat-probe validator passes the currency gate and proceeds
    // (then fails later on the mocked DB — NOT on currency).
    let err = null;
    try {
      await realmManager.update(updateReq('AED'), makeRes());
    } catch (e) {
      err = e;
    }
    if (err) expect(err.message).not.toMatch(/Invalid currency/);
  });

  it('ACCEPTS a fund/unit code (CHE) the dropdown offers but Intl.supportedValuesOf omits (Step-7 H6 sibling)', async () => {
    // CHE/CHW/CLF/COU/MXV/BOV/UYI/UYW/XUA are offered by the currency-codes
    // dropdown and accepted by Intl.NumberFormat, but absent from
    // supportedValuesOf — a static list would 422-lock them. The NumberFormat
    // probe accepts them (they never crash the accounting pipeline).
    let err = null;
    try {
      await realmManager.update(updateReq('CHE'), makeRes());
    } catch (e) {
      err = e;
    }
    if (err) expect(err.message).not.toMatch(/Invalid currency/);
  });

  it('still REJECTS a non-ISO garbage code', async () => {
    await expect(
      realmManager.update(updateReq('NOTACURRENCY'), makeRes())
    ).rejects.toThrow(/Invalid currency/);
  });

  it('add() now validates currency too (was unguarded — L1)', async () => {
    const addReq = {
      user: { email: 'admin@test.com', role: 'administrator' },
      realms: [],
      body: { name: 'New Org', locale: 'en-US', currency: 'NOTACURRENCY' }
    };
    await expect(realmManager.add(addReq, makeRes())).rejects.toThrow(
      /Invalid currency/
    );
  });
});

// ── audit-2026-08 (org batch): the member dedupe collapse and the total
//    absence of an applications[].name check. Both let a PATCH look like a
//    success while it either changed a role nobody asked to change or wrote a
//    row the collaborator list cannot render distinguishably.
describe('realmmanager members case-collision + applications[].name (audit-2026-08)', () => {
  // A stored realm whose only member is the caller. previousRealm must expose
  // toObject()/set()/save() the way a Mongoose doc does.
  function mockStoredRealm(overrides = {}) {
    const stored = {
      _id: 'realm123',
      name: 'Test Org',
      locale: 'en',
      currency: 'EUR',
      members: [{ email: 'admin@x.com', role: 'administrator' }],
      applications: [],
      thirdParties: {},
      ...overrides
    };
    const doc = {
      ...stored,
      toObject: () => JSON.parse(JSON.stringify(stored)),
      set: jest.fn(),
      save: jest.fn().mockResolvedValue(stored)
    };
    return doc;
  }

  function updateReq(bodyPart, realmPart = {}) {
    return {
      realm: {
        _id: 'realm123',
        name: 'Test Org',
        applications: [],
        ...realmPart
      },
      realms: [{ _id: { toString: () => 'realm123' }, name: 'Test Org' }],
      user: { email: 'admin@x.com', role: 'administrator' },
      body: {
        _id: 'realm123',
        name: 'Test Org',
        locale: 'en',
        currency: 'EUR',
        members: [{ email: 'admin@x.com', role: 'administrator' }],
        applications: [],
        ...bodyPart
      }
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    m.realmFindOne.mockResolvedValue(mockStoredRealm());
    m.accountFind.mockReturnValue({ lean: () => Promise.resolve([]) });
  });

  it('REJECTS the same email in different case with DIFFERENT roles (was a silent role escalation)', async () => {
    // The UI sends the whole realm plus the new row. "ADMIN@x.com" as
    // administrator next to the stored "admin@x.com" as renter used to collapse
    // by ROLE_RANK, promoting the renter with no error and no new list row.
    const req = updateReq({
      members: [
        { email: 'admin@x.com', role: 'renter' },
        { email: 'ADMIN@x.com', role: 'administrator' }
      ]
    });
    await expect(realmManager.update(req, makeRes())).rejects.toThrow(
      /same email more than once with different roles/
    );
  });

  it('REJECTS the reverse order too (the submitted row used to be silently discarded)', async () => {
    const req = updateReq({
      members: [
        { email: 'Admin@X.com', role: 'renter' },
        { email: 'admin@x.com', role: 'administrator' }
      ]
    });
    await expect(realmManager.update(req, makeRes())).rejects.toThrow(/422|same email/);
  });

  it('ALLOWS a case collision when both rows carry the SAME role (idempotent resend, not a role change)', async () => {
    const req = updateReq({
      members: [
        { email: 'admin@x.com', role: 'administrator' },
        { email: 'ADMIN@X.com', role: 'administrator' }
      ]
    });
    const res = makeRes();
    await realmManager.update(req, res);
    expect(res.json).toHaveBeenCalled();
    expect(req.body.members).toHaveLength(1);
  });

  it('does NOT 422-lock a realm that ALREADY stores both case variants', async () => {
    // Legacy data written before the dedupe existed. Blocking here would make
    // every unrelated settings save fail forever; the collapse cleans it up.
    m.realmFindOne.mockResolvedValue(
      mockStoredRealm({
        members: [
          { email: 'admin@x.com', role: 'administrator' },
          { email: 'ADMIN@x.com', role: 'renter' }
        ]
      })
    );
    const req = updateReq({
      members: [
        { email: 'admin@x.com', role: 'administrator' },
        { email: 'ADMIN@x.com', role: 'renter' }
      ]
    });
    const res = makeRes();
    await realmManager.update(req, res);
    expect(res.json).toHaveBeenCalled();
  });

  it('leaves a plain single-administrator payload untouched (no false positive)', async () => {
    const req = updateReq({});
    const res = makeRes();
    await realmManager.update(req, res);
    expect(res.json).toHaveBeenCalled();
    // update() also stamps name/registered from the accounts lookup, so assert
    // on the identity fields the guard could have changed.
    expect(req.body.members).toHaveLength(1);
    expect(req.body.members[0]).toMatchObject({
      email: 'admin@x.com',
      role: 'administrator'
    });
  });

  it('REJECTS a whitespace-only applications[].name (used to persist a nameless row)', async () => {
    const req = updateReq({
      applications: [{ name: '   ', role: 'renter', clientId: 'c-new' }]
    });
    await expect(realmManager.update(req, makeRes())).rejects.toThrow(
      /applications\[0\]\.name is required/
    );
  });

  it('TRIMS a valid applications[].name', async () => {
    const req = updateReq({
      applications: [{ name: '  Backup  ', role: 'renter', clientId: 'c-new' }]
    });
    const res = makeRes();
    await realmManager.update(req, res);
    expect(req.body.applications[0].name).toBe('Backup');
  });

  it('REJECTS a new application whose trimmed/cased name duplicates an EXISTING credential', async () => {
    const req = updateReq(
      {
        applications: [
          { name: 'Backup', role: 'renter', clientId: 'c-old' },
          { name: 'backup ', role: 'renter', clientId: 'c-new' }
        ]
      },
      { applications: [{ name: 'Backup', clientId: 'c-old' }] }
    );
    await expect(realmManager.update(req, makeRes())).rejects.toThrow(
      /applications\[1\]\.name is already used/
    );
  });

  it('REJECTS two NEW applications submitted with the same name in one payload', async () => {
    const req = updateReq({
      applications: [
        { name: 'Backup', role: 'renter', clientId: 'c-a' },
        { name: ' BACKUP', role: 'renter', clientId: 'c-b' }
      ]
    });
    await expect(realmManager.update(req, makeRes())).rejects.toThrow(
      /applications\[1\]\.name is already used/
    );
  });

  it('does NOT 422-lock a realm carrying a legacy blank application name', async () => {
    // The stored row is skipped by clientId, so an unrelated save still goes
    // through — otherwise the admin could never fix anything again.
    const req = updateReq(
      { applications: [{ name: '  ', role: 'renter', clientId: 'c-legacy' }] },
      { applications: [{ name: '  ', clientId: 'c-legacy' }] }
    );
    const res = makeRes();
    await realmManager.update(req, res);
    expect(res.json).toHaveBeenCalled();
  });

  it('add() validates applications[].name too (create/update symmetry)', async () => {
    const addReq = {
      user: { email: 'admin@x.com', role: 'administrator' },
      realms: [],
      body: {
        name: 'New Org',
        locale: 'en',
        currency: 'EUR',
        applications: [{ name: '  ', role: 'renter', clientId: 'c-new' }]
      }
    };
    await expect(realmManager.add(addReq, makeRes())).rejects.toThrow(
      /applications\[0\]\.name is required/
    );
  });
});
