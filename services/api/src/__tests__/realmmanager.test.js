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
  realmDelete: jest.fn()
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
      Realm: { deleteOne: (...args) => m.realmDelete(...args) }
    },
    ServiceError,
    Crypto: { encrypt: (v) => `enc_${v}`, decrypt: (v) => v },
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
