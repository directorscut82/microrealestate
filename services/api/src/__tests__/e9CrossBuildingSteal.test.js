/* eslint-env node, jest */
/**
 * E9 re-import must not STEAL a property from another building — round-1 H10.
 *
 * importFromE9 finds an existing Property by (realmId, atakNumber) — REALM
 * scoped, not building-scoped. When the address-matched building differs from
 * the building that already owns that property's unit, the import reassigned
 * property.buildingId + pushed a fresh unit onto the new building while the old
 * building kept its orphan unit for the SAME propertyId → rent computation
 * walks both buildings and double-bills the koinochrista.
 *
 * Fix mirrors the addUnit guard: refuse when the property is already linked to
 * a unit in a DIFFERENT building.
 *
 * We mock the dynamic pdfjs import (so extractTextFromPdf returns E9-marker
 * text) and parseE9 (so we control the parsed building/unit), then drive the
 * real importFromE9 against in-memory Collections.
 */
import { jest } from '@jest/globals';

let buildingManager;
const state = {};

beforeAll(async () => {
  class ServiceError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  // Fake pdfjs doc → returns text carrying an E9 marker so the marker sniff
  // passes; the real content is irrelevant because parseE9 is mocked.
  jest.unstable_mockModule('pdfjs-dist/legacy/build/pdf.mjs', () => ({
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({ items: [{ str: 'ΠΕΡΙΟΥΣΙΑΚΗΣ ΚΑΤΑΣΤΑΣΗΣ Ε9' }] })
        })
      })
    })
  }));

  // parseE9 → one building at address "ΟΔΟΣ ΗΤΑ 24" containing ATAK 'ATAK-X'.
  jest.unstable_mockModule('../managers/e9parser.js', () => ({
    parseE9: () => ({
      owner: { taxId: '999000006', firstName: 'ΛΑΜΔΑ', lastName: 'ΔΟΚΙΜΗ' },
      skippedLandPlots: 0,
      buildings: [
        {
          address: { street1: 'ΟΔΟΣ ΗΤΑ 24', zipCode: '11111', city: 'ΑΘΗΝΑ' },
          atakPrefix: '005578',
          units: [
            {
              atakNumber: 'ATAK-X',
              floor: 1,
              surface: 50,
              street: 'ΟΔΟΣ ΗΤΑ',
              streetNumber: '24',
              category: 'apartment',
              ownershipPercentage: 100,
              electricitySupplyNumber: '',
              coOwners: []
            }
          ]
        }
      ]
    })
  }));

  // In-memory Collections. Property P1 (ATAK-X) currently lives in building A;
  // building B (ΟΔΟΣ ΗΤΑ 24) is the address-matched target with no units yet.
  const buildingA = {
    _id: 'A',
    name: 'Building A',
    realmId: 'r1',
    address: { street1: 'ΟΔΟΣ ΘΗΤΑ 167', zipCode: '22222' },
    units: [{ atakNumber: 'ATAK-X', propertyId: 'P1', isManaged: true, owners: [] }]
  };
  const makeSaveable = (obj) => {
    obj.save = async () => obj;
    obj.toObject = () => obj;
    return obj;
  };
  const buildingB = makeSaveable({
    _id: 'B',
    name: 'Building B (ΟΔΟΣ ΗΤΑ)',
    realmId: 'r1',
    address: { street1: 'ΟΔΟΣ ΗΤΑ 24', zipCode: '11111' },
    units: []
  });
  const propertyP1 = makeSaveable({
    _id: 'P1',
    realmId: 'r1',
    atakNumber: 'ATAK-X',
    buildingId: 'A',
    name: 'ΟΔΟΣ ΗΤΑ 24 - 1ος',
    surface: 50
  });
  state.buildingA = buildingA;
  state.buildingB = buildingB;

  const buildings = [buildingA, buildingB];

  // A query result that supports: await q, q.lean(), q.select().lean().
  const query = (v) => {
    const p = Promise.resolve(v);
    p.lean = async () => v;
    p.select = () => query(v);
    return p;
  };
  const lean = query;
  const OwnerStatement = await import(
    '../../../common/src/utils/ownerstatement.ts'
  );
  // 1_base (transitively imported) now imports ShareBasis from common — provide the REAL util.
  const ShareBasis = await import(
    '../../../common/src/utils/sharebasis.ts'
  );
  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: {
      Building: {
        // Used in preview (by address) + the cross-building guard (by units.propertyId).
        findOne: (q) => {
          if (q && q['units.propertyId']) {
            const pid = q['units.propertyId'];
            const hit = buildings.find((b) => b.units.some((u) => String(u.propertyId) === String(pid)));
            return lean(hit || null);
          }
          if (q && q['address.street1']) {
            const hit = buildings.find((b) => b.address.street1 === q['address.street1']);
            return lean(hit || null);
          }
          return lean(null);
        },
        find: () => lean(buildings)
      },
      Property: {
        // The import path awaits findOne(...) directly; the preview path calls
        // findOne(...).lean(). query() supports both.
        findOne: () => query(propertyP1),
        create: async (doc) => makeSaveable({ _id: 'Pnew', ...doc })
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

describe('H10 — E9 re-import refuses to steal a property from another building', () => {
  it('throws 422 when the matched building differs from the property’s current building', async () => {
    const req = {
      realm: { _id: 'r1', locale: 'el' },
      file: { buffer: Buffer.from('fake') },
      query: { confirmed: 'true' },
      body: {}
    };
    // FAILING-FIRST: before the guard, importFromE9 reassigns P1.buildingId to
    // B and pushes a unit onto B (resolving + double-billing). After the fix it
    // throws 422 "already linked to a unit in another building".
    await expect(buildingManager.importFromE9(req, makeRes())).rejects.toThrow(
      /already linked to a unit in another building/
    );
    // Building B must NOT have gained the stolen unit.
    expect(state.buildingB.units.find((u) => u.propertyId === 'P1')).toBeUndefined();
  });
});
