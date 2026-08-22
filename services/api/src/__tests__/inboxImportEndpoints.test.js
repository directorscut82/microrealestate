/* eslint-env node, jest */
/**
 * The inbox endpoints' import-kind behaviour, over an in-memory Collections
 * mock (the e9CrossBuildingSteal pattern):
 *
 *   · confirm on a leaseImport/e9Import row CONSUMES the notification (status
 *     flip) and must NEVER reach the confirmBills pipeline — an empty `parsed`
 *     through that pipeline inserts a garbage Bill, the exact shape the notice
 *     guard already blocks.
 *   · getImportPayload returns the stored parse with a FRESH classification
 *     (lease) / a FRESH buildE9Preview (e9), and 404s for consumed rows.
 *   · list strips the heavy importDoc.parsed but keeps the summary the bell
 *     renders.
 */
import { jest } from '@jest/globals';

class ServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let inboxManager;
let state;
let confirmBillsCalls;
let classifyCalls;
let previewCalls;

beforeAll(async () => {
  state = { items: {} };
  confirmBillsCalls = [];
  classifyCalls = [];
  previewCalls = [];

  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: {
      InboxItem: {
        find: (q) => ({
          sort: () => ({
            lean: async () =>
              Object.values(state.items).filter(
                (i) =>
                  i.realmId === q.realmId && q.status.$in.includes(i.status)
              )
          })
        }),
        findOne: (q) => ({
          lean: async () => {
            const it = state.items[q._id];
            if (!it || it.realmId !== q.realmId) return null;
            if (q.status && it.status !== q.status) return null;
            if (q.kind?.$in && !q.kind.$in.includes(it.kind)) return null;
            return it;
          }
        }),
        exists: async (q) => {
          const it = state.items[q._id];
          return !!(it && it.realmId === q.realmId && it.status === q.status);
        },
        updateOne: async (q, u) => {
          const it = state.items[q._id];
          const statusOk =
            !q.status ||
            (q.status.$in
              ? q.status.$in.includes(it?.status)
              : it?.status === q.status);
          if (!it || it.realmId !== q.realmId || !statusOk) {
            return { matchedCount: 0 };
          }
          Object.assign(it, u.$set);
          return { matchedCount: 1 };
        }
      },
      Realm: { findOne: () => ({ lean: async () => null }) }
    },
    Crypto: { decrypt: (v) => v, encrypt: (v) => v },
    ServiceError,
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  }));
  jest.unstable_mockModule('../managers/billmanager.js', () => ({
    confirmBills: async (...args) => {
      confirmBillsCalls.push(args);
      return { status: 200 };
    }
  }));
  jest.unstable_mockModule('../managers/billidentity.js', () => ({
    findDuplicateBillByIdentity: async () => null
  }));
  jest.unstable_mockModule('../managers/buildingmanager.js', () => ({
    buildE9Preview: async (parsed, realmId) => {
      previewCalls.push({ parsed, realmId });
      return { owner: parsed.owner, buildings: [], skippedLandPlots: 0 };
    }
  }));
  jest.unstable_mockModule('../managers/pdfimportmanager.js', () => ({
    classifyAgainstExisting: async (parsed, realmId) => {
      classifyCalls.push({ parsed, realmId });
      return { kind: 'update', matchedTenantId: 'fresh-tenant' };
    }
  }));

  inboxManager = await import('../managers/inboxmanager.js');
});

function makeRes() {
  const res = { body: undefined, headers: {} };
  res.json = jest.fn((b) => {
    res.body = b;
  });
  res.setHeader = jest.fn();
  res.send = jest.fn();
  return res;
}

beforeEach(() => {
  confirmBillsCalls.length = 0;
  classifyCalls.length = 0;
  state.items = {
    // valid 24-hex ids — the routes validateObjectId first
    aaaaaaaaaaaaaaaaaaaaaaaa: {
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      realmId: 'r1',
      kind: 'leaseImport',
      status: 'pending',
      sourceFileName: 'misthotirio.pdf',
      importDoc: {
        docKind: 'lease',
        parsed: { tenants: [{ name: 'ΜΙΣΘΩΤΗΣ ΑΛΦΑ', taxId: '999000043' }] },
        summary: { title: 'ΜΙΣΘΩΤΗΣ ΑΛΦΑ', classification: 'extension' }
      }
    },
    bbbbbbbbbbbbbbbbbbbbbbbb: {
      _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      realmId: 'r1',
      kind: 'e9Import',
      status: 'pending',
      importDoc: {
        docKind: 'e9',
        parsed: { owner: { taxId: '999000018' }, buildings: [{}], skippedLandPlots: 0 },
        summary: { title: '1 κτίριο · 1 μονάδα' }
      }
    }
  };
});

describe('confirm on import kinds — consume, never a Bill', () => {
  it('flips a leaseImport to confirmed WITHOUT touching confirmBills', async () => {
    const res = makeRes();
    await inboxManager.confirm(
      { realm: { _id: 'r1' }, params: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, body: {} },
      res
    );
    expect(res.body).toEqual({ ok: true });
    expect(state.items['aaaaaaaaaaaaaaaaaaaaaaaa'].status).toBe('confirmed');
    expect(confirmBillsCalls).toHaveLength(0);
  });

  it('same for e9Import', async () => {
    const res = makeRes();
    await inboxManager.confirm(
      { realm: { _id: 'r1' }, params: { id: 'bbbbbbbbbbbbbbbbbbbbbbbb' }, body: {} },
      res
    );
    expect(state.items['bbbbbbbbbbbbbbbbbbbbbbbb'].status).toBe('confirmed');
    expect(confirmBillsCalls).toHaveLength(0);
  });
});

describe('getImportPayload', () => {
  it('lease: stored parse + FRESH classification (not the ingest-time verdict)', async () => {
    const res = makeRes();
    await inboxManager.getImportPayload(
      { realm: { _id: 'r1' }, params: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa' } },
      res
    );
    expect(res.body.kind).toBe('leaseImport');
    expect(res.body.parsed.tenants[0].taxId).toBe('999000043');
    // fresh — from the mocked classifier, NOT the stored 'extension'
    expect(res.body.classification.kind).toBe('update');
    expect(classifyCalls).toHaveLength(1);
  });

  it('e9: stored parse + FRESH buildE9Preview', async () => {
    const res = makeRes();
    await inboxManager.getImportPayload(
      { realm: { _id: 'r1' }, params: { id: 'bbbbbbbbbbbbbbbbbbbbbbbb' } },
      res
    );
    expect(res.body.kind).toBe('e9Import');
    expect(res.body.preview.owner.taxId).toBe('999000018');
    expect(previewCalls).toHaveLength(1);
  });

  it('404s a consumed row — a confirmed import must not reopen a dialog', async () => {
    state.items['aaaaaaaaaaaaaaaaaaaaaaaa'].status = 'confirmed';
    await expect(
      inboxManager.getImportPayload(
        { realm: { _id: 'r1' }, params: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa' } },
        makeRes()
      )
    ).rejects.toThrow('δεν βρέθηκε');
  });

  it('404s across realms', async () => {
    await expect(
      inboxManager.getImportPayload(
        { realm: { _id: 'OTHER' }, params: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa' } },
        makeRes()
      )
    ).rejects.toThrow('δεν βρέθηκε');
  });
});

describe('list — the bell payload', () => {
  it('keeps importDoc.summary but strips the heavy parsed body', async () => {
    const res = makeRes();
    await inboxManager.list({ realm: { _id: 'r1' } }, res);
    const lease = res.body.find((i) => i.kind === 'leaseImport');
    expect(lease.importDoc.summary.title).toBe('ΜΙΣΘΩΤΗΣ ΑΛΦΑ');
    expect(lease.importDoc.parsed).toBeUndefined();
  });
});
