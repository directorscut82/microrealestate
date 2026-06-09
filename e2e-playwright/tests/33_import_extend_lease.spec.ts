/**
 * Spec 33 — ImportTenantDialog "Extend lease" radio + POST
 * /api/v2/tenants/:id/extend-lease.
 *
 * Targeted findings (per H-coverage in occupantmanager.extendLease):
 *  - H6 "tenant __v is required on extend-lease (optimistic lock)" 422 path
 *  - H6 stale-__v 409 path (existing __v - 1)
 *  - H6 happy-path 200 — endDate updated, leaseHistory.length += 1,
 *    terminationDate $unset, mongo readback confirms.
 *  - H7 atomic write: when Contract.update throws (newBegin moved past a
 *    paid term so _checkLostPayments fires) the route MUST 422 AND the
 *    tenant document MUST be untouched (beginDate unchanged, leaseHistory
 *    length unchanged, __v unchanged).
 *  - GET tenant after extend exposes leaseHistory[] — surrogate for the
 *    classifyAgainstExisting kind='extension' contract since we don't have
 *    a stable AADE PDF fixture in CI.
 *  - UI smoke (second test): the radio in ImportTenantDialog defaults to
 *    "Extend lease" when the server-side classification kind=extension and
 *    a matchedTenant is present.
 *
 * Discipline (matches CLAUDE.md "Definition of done"):
 *  - Live NAS only, CYPRESS-TEST-DO-NOT-USE realm.
 *  - Mutates a DISPOSABLE tenant (E2E-ExtendLease-Tenant), not the
 *    canonical E2E-LeasedTenant — so a panic mid-flow can't terminate /
 *    drift the realm-wide fixture (see CLAUDE.md "Test seed leakage cascade").
 *  - afterAll deletes the disposable tenant whether or not the assertions
 *    held.
 *  - Mongo readback is via lib/mongoExec — bypasses FD.toOccupantData
 *    formatting so we see the raw stored shape (Date objects, leaseHistory
 *    array length, __v counter, terminationDate present-or-absent).
 *  - Status-code asserts use exact ===, not the lazy `<400` pattern.
 *
 * What this spec does NOT cover (intentionally):
 *  - Real AADE PDF parse — there is no stable fixture in the harness path
 *    and parse failures are covered by _verifyP1_pdf_import.spec.ts.
 *    The import-pdf response is MOCKED via page.route in the UI test so we
 *    can exercise the radio-default behaviour deterministically without
 *    coupling to local file system PDF state.
 */
import { test, expect, request, APIRequestContext, Page } from '@playwright/test';
import { ensureSeedLease, ensureSeedProperty, LeaseSeed } from './lib/api';
import { mongoExec } from './lib/mongoExec';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.describe.configure({ mode: 'serial', timeout: 4 * 60_000 });

interface ExtendSeed {
  token: string;
  realmId: string;
  realmName: string;
  leaseId: string;
  propertyId: string;
  tenantId: string;
  tenantName: string;
  /** YYYY-MM-DD, the seeded tenant's lease begin (six months ago, 1st of). */
  beginIso: string;
  /** YYYY-MM-DD, the seeded tenant's lease end (six months in the future, last of). */
  endIso: string;
  /** Strict 'DD/MM/YYYY' for re-use in API payloads. */
  beginApi: string;
  endApi: string;
  /** Tenant taxId — matched by classifyAgainstExisting against parsed.tenants[0].taxId. */
  taxId: string;
}

let _seed: ExtendSeed | null = null;

const toDDMMYYYY = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

const auth = (s: ExtendSeed) => ({
  Authorization: `Bearer ${s.token}`,
  'Content-Type': 'application/json',
  organizationid: s.realmId
});

test.beforeAll(async () => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD');
  }
  const apiCtx = await request.newContext();
  try {
    // Standard seed scaffolding (idempotent): realm + lease + property.
    const leaseSeed: LeaseSeed = await ensureSeedLease(apiCtx);
    const propSeed = await ensureSeedProperty(apiCtx);
    const headers = {
      Authorization: `Bearer ${leaseSeed.token}`,
      'Content-Type': 'application/json',
      organizationid: leaseSeed.realmId
    };

    // Disposable tenant — DO NOT touch the canonical E2E-LeasedTenant.
    // Lease window: 6 months ago → 6 months future, anchored to UTC so
    // re-runs near midnight don't shift the floor-of-month boundary.
    const today = new Date();
    const beginUtc = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 6, 1)
    );
    const endUtc = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 7, 0)
    );
    const beginIso = beginUtc.toISOString().substring(0, 10);
    const endIso = endUtc.toISOString().substring(0, 10);
    const beginApi = toDDMMYYYY(beginIso);
    const endApi = toDDMMYYYY(endIso);

    // Stable but unique-per-realm taxId so the classifyAgainstExisting
    // taxId match in pdfimportmanager fires deterministically. Length 9
    // matches Greek AFM length so any downstream validators won't reject.
    const taxId = '900000033';
    const tenantName = 'E2E-ExtendLease-Tenant';

    // Drop a stale fixture if it exists from a prior failed run, so this
    // run's __v / leaseHistory invariants aren't poisoned by leakage.
    const tenantsResp = await apiCtx.get(`${GATEWAY}/api/v2/tenants`, { headers });
    expect(tenantsResp.status(), 'list tenants for fixture cleanup').toBe(200);
    const tenants = (await tenantsResp.json()) as Array<{ _id: string; name: string }>;
    const stale = tenants.find((t) => t.name === tenantName);
    if (stale) {
      await apiCtx
        .delete(`${GATEWAY}/api/v2/tenants/${stale._id}`, { headers })
        .catch(() => {});
    }

    const created = await apiCtx.post(`${GATEWAY}/api/v2/tenants`, {
      headers,
      data: {
        name: tenantName,
        isCompany: false,
        manager: tenantName,
        contacts: [
          {
            contact: tenantName,
            email: '',
            phone1: '6900000033',
            phone: '',
            phone2: ''
          }
        ],
        leaseId: leaseSeed.leaseId,
        beginDate: beginApi,
        endDate: endApi,
        taxId,
        properties: [
          { propertyId: propSeed.propertyId, rent: 500, expenses: [] }
        ]
      }
    });
    expect(
      [200, 201],
      `create disposable tenant (status=${created.status()}, body: ${await created
        .text()
        .catch(() => '')})`
    ).toContain(created.status());
    const tenantBody = (await created.json()) as { _id: string };

    _seed = {
      token: leaseSeed.token,
      realmId: leaseSeed.realmId,
      realmName: leaseSeed.realmName,
      leaseId: leaseSeed.leaseId,
      propertyId: propSeed.propertyId,
      tenantId: tenantBody._id,
      tenantName,
      beginIso,
      endIso,
      beginApi,
      endApi,
      taxId
    };
  } finally {
    await apiCtx.dispose();
  }
});

test.afterAll(async () => {
  if (!_seed) return;
  const apiCtx = await request.newContext();
  try {
    await apiCtx
      .delete(`${GATEWAY}/api/v2/tenants/${_seed.tenantId}`, {
        headers: auth(_seed)
      })
      .catch(() => {});
  } finally {
    await apiCtx.dispose();
  }
});

// ---------------------------------------------------------------------------
// API: H6 — POST extend-lease without __v → 422 "tenant __v is required..."
// ---------------------------------------------------------------------------
test('33A · POST extend-lease without __v returns 422 with the H6 lock message', async () => {
  if (!_seed) throw new Error('seed not ready');
  const api = await request.newContext();
  try {
    // Pull current state so we can prove the doc is unchanged after the 422.
    const before = await api.get(
      `${GATEWAY}/api/v2/tenants/${_seed.tenantId}`,
      { headers: auth(_seed) }
    );
    expect(before.status(), 'fetch tenant pre-422').toBe(200);
    const beforeDoc = (await before.json()) as {
      __v: number;
      endDate: string;
      leaseHistory?: Array<unknown>;
    };
    const historyLenBefore = (beforeDoc.leaseHistory || []).length;

    // Compute a "new end" two months past the current end so the body looks
    // legitimate to every guard except the __v one.
    const newEndIso = (() => {
      const d = new Date(_seed.endIso + 'T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() + 2);
      return d.toISOString().substring(0, 10);
    })();

    const resp = await api.post(
      `${GATEWAY}/api/v2/tenants/${_seed.tenantId}/extend-lease`,
      {
        headers: auth(_seed),
        data: {
          // NB: NO __v key. requestedVersion = Number(undefined) = NaN, which
          // !Number.isFinite catches → 422.
          validityStart: _seed.endApi,
          validityEnd: toDDMMYYYY(newEndIso),
          declarationNumber: 'E2E-NO-VV',
          tenants: [
            { name: _seed.tenantName, taxId: _seed.taxId }
          ]
        }
      }
    );
    expect(
      resp.status(),
      'POST without __v must 422 (H6 optimistic-lock guard)'
    ).toBe(422);
    const body = (await resp.text()) || '';
    expect(
      body,
      'error body must call out the __v requirement so a future agent can grep for it'
    ).toMatch(/__v is required/i);

    // Doc-untouched assertion — H7 also covers this for the Contract.update
    // branch, but the __v guard sits BEFORE any mongo write, so a regression
    // that read it as a soft-warning instead of a 422 would still pass H7.
    const after = await api.get(
      `${GATEWAY}/api/v2/tenants/${_seed.tenantId}`,
      { headers: auth(_seed) }
    );
    expect(after.status(), 'fetch tenant post-422').toBe(200);
    const afterDoc = (await after.json()) as {
      __v: number;
      endDate: string;
      leaseHistory?: Array<unknown>;
    };
    expect(afterDoc.__v, '__v unchanged after 422').toBe(beforeDoc.__v);
    expect(afterDoc.endDate, 'endDate unchanged after 422').toBe(
      beforeDoc.endDate
    );
    expect(
      (afterDoc.leaseHistory || []).length,
      'leaseHistory length unchanged after 422'
    ).toBe(historyLenBefore);
  } finally {
    await api.dispose();
  }
});

// ---------------------------------------------------------------------------
// API: H6 — POST extend-lease with stale __v → 409 conflict
// ---------------------------------------------------------------------------
test('33B · POST extend-lease with stale __v returns 409 (concurrent-modify)', async () => {
  if (!_seed) throw new Error('seed not ready');
  const api = await request.newContext();
  try {
    const before = await api.get(
      `${GATEWAY}/api/v2/tenants/${_seed.tenantId}`,
      { headers: auth(_seed) }
    );
    expect(before.status(), 'fetch tenant pre-409').toBe(200);
    const beforeDoc = (await before.json()) as { __v: number };
    const stale = beforeDoc.__v - 1;

    const newEndIso = (() => {
      const d = new Date(_seed.endIso + 'T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() + 3);
      return d.toISOString().substring(0, 10);
    })();

    const resp = await api.post(
      `${GATEWAY}/api/v2/tenants/${_seed.tenantId}/extend-lease`,
      {
        headers: auth(_seed),
        data: {
          __v: stale,
          validityStart: _seed.endApi,
          validityEnd: toDDMMYYYY(newEndIso),
          declarationNumber: 'E2E-STALE-VV',
          tenants: [{ name: _seed.tenantName, taxId: _seed.taxId }]
        }
      }
    );
    // The atomic findOneAndUpdate's __v filter doesn't match → updated is
    // null → tenant exists check passes → 409 (per occupantmanager 2120-2124).
    expect(
      resp.status(),
      'POST with stale __v must 409 (H6 optimistic-lock catches concurrent edit)'
    ).toBe(409);

    // Sanity: the doc's __v must NOT have advanced (no write happened).
    const after = await api.get(
      `${GATEWAY}/api/v2/tenants/${_seed.tenantId}`,
      { headers: auth(_seed) }
    );
    expect(after.status(), 'fetch tenant post-409').toBe(200);
    const afterDoc = (await after.json()) as { __v: number };
    expect(afterDoc.__v, '__v unchanged after 409').toBe(beforeDoc.__v);
  } finally {
    await api.dispose();
  }
});

// ---------------------------------------------------------------------------
// API: H7 — Contract.update throws on a paid past term moved out of window;
//          route MUST 422 AND the tenant doc MUST be untouched (atomic).
// ---------------------------------------------------------------------------
test('33C · POST extend-lease that would orphan a paid past term 422s and leaves doc untouched (H7)', async () => {
  if (!_seed) throw new Error('seed not ready');
  const api = await request.newContext();
  try {
    // Seed exactly one cash payment on a past term that's well INSIDE the
    // current lease window. Picked = 2 months ago so it's safely past the
    // termination cushion and inside the seeded begin (6m ago).
    const now = new Date();
    const pastTermDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)
    );
    const pastTerm =
      String(pastTermDate.getUTCFullYear()) +
      String(pastTermDate.getUTCMonth() + 1).padStart(2, '0') +
      '0100';
    const pastTermDateApi = `01/${String(
      pastTermDate.getUTCMonth() + 1
    ).padStart(2, '0')}/${pastTermDate.getUTCFullYear()}`;

    const seedPay = await api.patch(
      `${GATEWAY}/api/v2/rents/payment/${_seed.tenantId}/${pastTerm}`,
      {
        headers: auth(_seed),
        data: {
          _id: _seed.tenantId,
          payments: [
            { amount: 500, type: 'cash', date: pastTermDateApi }
          ]
        }
      }
    );
    expect(
      seedPay.status(),
      `seed past-term payment (status=${seedPay.status()}, body=${await seedPay
        .text()
        .catch(() => '')})`
    ).toBe(200);

    // Snapshot the pre-extend state — this is what we'll diff against.
    const before = await api.get(
      `${GATEWAY}/api/v2/tenants/${_seed.tenantId}`,
      { headers: auth(_seed) }
    );
    expect(before.status(), 'fetch tenant pre-H7-422').toBe(200);
    const beforeDoc = (await before.json()) as {
      __v: number;
      beginDate: string;
      endDate: string;
      leaseHistory?: Array<unknown>;
    };
    const historyLenBefore = (beforeDoc.leaseHistory || []).length;
    const beginBefore = beforeDoc.beginDate;
    const endBefore = beforeDoc.endDate;
    const versionBefore = beforeDoc.__v;

    // Move the begin date to 1 month ago — that orphans the paid term we
    // just seeded, which lives 2 months ago. Contract.update calls
    // _checkLostPayments which throws "Some payments will be lost..." and
    // the route translates that to 422 BEFORE the atomic findOneAndUpdate
    // runs, so __v must not advance and leaseHistory must not grow.
    const newBeginDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
    );
    const newBeginApi =
      `01/${String(newBeginDate.getUTCMonth() + 1).padStart(2, '0')}/` +
      String(newBeginDate.getUTCFullYear());
    // End: 6 months in the future, well after the new begin so the
    // begin<end guard is satisfied and we hit Contract.update cleanly.
    const newEndDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 6, 0)
    );
    const newEndApi =
      `${String(newEndDate.getUTCDate()).padStart(2, '0')}/${String(
        newEndDate.getUTCMonth() + 1
      ).padStart(2, '0')}/${newEndDate.getUTCFullYear()}`;

    const resp = await api.post(
      `${GATEWAY}/api/v2/tenants/${_seed.tenantId}/extend-lease`,
      {
        headers: auth(_seed),
        data: {
          __v: versionBefore,
          validityStart: newBeginApi,
          validityEnd: newEndApi,
          declarationNumber: 'E2E-LOSTPAY',
          tenants: [{ name: _seed.tenantName, taxId: _seed.taxId }]
        }
      }
    );
    expect(
      resp.status(),
      'POST that orphans a paid past term must 422 (Contract.update threw)'
    ).toBe(422);

    // ----- doc-untouched assertions (H7 atomic-write contract) -----
    const after = await api.get(
      `${GATEWAY}/api/v2/tenants/${_seed.tenantId}`,
      { headers: auth(_seed) }
    );
    expect(after.status(), 'fetch tenant post-H7-422').toBe(200);
    const afterDoc = (await after.json()) as {
      __v: number;
      beginDate: string;
      endDate: string;
      leaseHistory?: Array<unknown>;
    };
    expect(afterDoc.__v, '__v unchanged on H7 422 (no atomic write happened)').toBe(
      versionBefore
    );
    expect(
      afterDoc.beginDate,
      'beginDate unchanged on H7 422 (Contract.update threw before write)'
    ).toBe(beginBefore);
    expect(
      afterDoc.endDate,
      'endDate unchanged on H7 422 (Contract.update threw before write)'
    ).toBe(endBefore);
    expect(
      (afterDoc.leaseHistory || []).length,
      'leaseHistory length unchanged on H7 422 (no $push happened)'
    ).toBe(historyLenBefore);

    // Mongo readback — bypasses FD.toOccupantData formatting and confirms
    // raw __v, root-level dates, and leaseHistory length.
    const mongoOut = mongoExec(`
      var t = db.occupants.findOne({_id: ObjectId("${_seed.tenantId}")});
      if (!t) { print("null"); quit(); }
      print(JSON.stringify({
        v: t.__v,
        begin: t.beginDate ? t.beginDate.toISOString() : null,
        end: t.endDate ? t.endDate.toISOString() : null,
        historyLen: (t.leaseHistory || []).length,
        terminationDate: t.terminationDate ? t.terminationDate.toISOString() : null
      }));
    `);
    if (mongoOut && mongoOut !== 'null') {
      const m = JSON.parse(mongoOut) as {
        v: number;
        begin: string | null;
        end: string | null;
        historyLen: number;
      };
      expect(m.v, 'mongo __v unchanged on H7 422').toBe(versionBefore);
      expect(
        m.historyLen,
        'mongo leaseHistory length unchanged on H7 422'
      ).toBe(historyLenBefore);
    }
    // If mongoOut is null (no portainer-token) we fall back silently to
    // the API-level assertions above. Same pattern as readRent in lib.
  } finally {
    await api.dispose();
  }
});

// ---------------------------------------------------------------------------
// API: H6 happy path — 200, endDate updated, leaseHistory += 1,
//      terminationDate $unset, mongo readback confirms.
// ---------------------------------------------------------------------------
test('33D · POST extend-lease happy path: 200, endDate moves, leaseHistory grows by 1, terminationDate is unset', async () => {
  if (!_seed) throw new Error('seed not ready');
  const api = await request.newContext();
  try {
    // Pre-state: set a terminationDate so we can prove $unset removes it.
    // Pull __v first; the update endpoint also enforces __v.
    const t1 = await api.get(`${GATEWAY}/api/v2/tenants/${_seed.tenantId}`, {
      headers: auth(_seed)
    });
    expect(t1.status(), 'fetch tenant for termination set').toBe(200);
    const t1Doc = (await t1.json()) as { __v: number };
    const termDateApi = _seed.endApi; // any valid date — we just need it set
    const termPatch = await api.patch(
      `${GATEWAY}/api/v2/tenants/${_seed.tenantId}`,
      {
        headers: auth(_seed),
        data: {
          terminationDate: termDateApi,
          guarantyPayback: 0,
          __v: t1Doc.__v
        }
      }
    );
    expect(
      termPatch.status(),
      `pre-termination PATCH (body=${await termPatch.text().catch(() => '')})`
    ).toBe(200);

    // Snapshot pre-extend.
    const before = await api.get(
      `${GATEWAY}/api/v2/tenants/${_seed.tenantId}`,
      { headers: auth(_seed) }
    );
    expect(before.status(), 'fetch tenant pre-extend').toBe(200);
    const beforeDoc = (await before.json()) as {
      __v: number;
      endDate: string;
      terminationDate?: string;
      leaseHistory?: Array<unknown>;
    };
    const historyLenBefore = (beforeDoc.leaseHistory || []).length;
    expect(
      beforeDoc.terminationDate,
      'terminationDate must be set BEFORE extend so $unset removal is visible'
    ).toBeTruthy();

    // New endDate: extend the existing endDate by 12 months.
    const newEndDate = new Date(_seed.endIso + 'T00:00:00Z');
    newEndDate.setUTCMonth(newEndDate.getUTCMonth() + 12);
    const newEndIso = newEndDate.toISOString().substring(0, 10);
    const newEndApi = toDDMMYYYY(newEndIso);

    const resp = await api.post(
      `${GATEWAY}/api/v2/tenants/${_seed.tenantId}/extend-lease`,
      {
        headers: auth(_seed),
        data: {
          __v: beforeDoc.__v,
          validityStart: _seed.endApi,
          validityEnd: newEndApi,
          declarationNumber: 'E2E-EXTEND-OK',
          tenants: [{ name: _seed.tenantName, taxId: _seed.taxId }]
        }
      }
    );
    expect(
      resp.status(),
      `POST extend-lease happy path must 200 (body=${await resp
        .text()
        .catch(() => '')})`
    ).toBe(200);
    const respBody = (await resp.json()) as {
      endDate: string;
      terminationDate?: string;
      leaseHistory?: Array<unknown>;
    };

    // ----- response shape assertions -----
    // FD.toOccupantData formats endDate as 'DD/MM/YYYY'; we expect the new
    // value, not the previous one.
    expect(
      respBody.endDate,
      'response.endDate must be the parsed.validityEnd (new end)'
    ).toBe(newEndApi);
    expect(
      Array.isArray(respBody.leaseHistory) ? respBody.leaseHistory.length : -1,
      'response.leaseHistory.length must equal previous + 1'
    ).toBe(historyLenBefore + 1);
    expect(
      respBody.terminationDate,
      'response.terminationDate must be unset ($unset cleared it)'
    ).toBeFalsy();

    // ----- GET round-trip — proves the write committed and the dialog's
    //       fetchTenant() will see the new state.
    const after = await api.get(
      `${GATEWAY}/api/v2/tenants/${_seed.tenantId}`,
      { headers: auth(_seed) }
    );
    expect(after.status(), 'fetch tenant post-extend').toBe(200);
    const afterDoc = (await after.json()) as {
      __v: number;
      endDate: string;
      terminationDate?: string;
      leaseHistory?: Array<unknown>;
    };
    expect(afterDoc.endDate, 'GET endDate after extend').toBe(newEndApi);
    expect(
      (afterDoc.leaseHistory || []).length,
      'GET leaseHistory.length after extend'
    ).toBe(historyLenBefore + 1);
    expect(
      afterDoc.terminationDate,
      'GET terminationDate after extend ($unset)'
    ).toBeFalsy();
    expect(afterDoc.__v, '__v advanced by exactly 1').toBe(beforeDoc.__v + 1);

    // ----- mongo readback — bypasses FD formatting; confirms raw doc state.
    const mongoOut = mongoExec(`
      var t = db.occupants.findOne({_id: ObjectId("${_seed.tenantId}")});
      if (!t) { print("null"); quit(); }
      print(JSON.stringify({
        v: t.__v,
        end: t.endDate ? t.endDate.toISOString() : null,
        termPresent: t.terminationDate !== undefined && t.terminationDate !== null,
        historyLen: (t.leaseHistory || []).length,
        lastHistoryDecl: (t.leaseHistory && t.leaseHistory.length)
          ? t.leaseHistory[t.leaseHistory.length - 1].supersededByDeclarationNumber
          : null
      }));
    `);
    if (mongoOut && mongoOut !== 'null') {
      const m = JSON.parse(mongoOut) as {
        v: number;
        end: string | null;
        termPresent: boolean;
        historyLen: number;
        lastHistoryDecl: string | null;
      };
      expect(m.v, 'mongo __v advanced by 1').toBe(beforeDoc.__v + 1);
      // mongo end is ISO; compare YYYY-MM-DD slice.
      expect(
        (m.end || '').substring(0, 10),
        'mongo endDate matches new validityEnd'
      ).toBe(newEndIso);
      expect(
        m.termPresent,
        'mongo terminationDate field is fully unset (not just null)'
      ).toBe(false);
      expect(m.historyLen, 'mongo leaseHistory length grew by 1').toBe(
        historyLenBefore + 1
      );
      expect(
        m.lastHistoryDecl,
        'last history entry carries supersededByDeclarationNumber from the new PDF'
      ).toBe('E2E-EXTEND-OK');
    }
  } finally {
    await api.dispose();
  }
});

// ---------------------------------------------------------------------------
// UI: ImportTenantDialog radio defaults to "Extend lease" when the
//     server-side classification reports kind=extension.
//
// We MOCK the POST /api/v2/tenants/import-pdf response with page.route() so
// this test does NOT depend on a local AADE PDF fixture. The mock body
// contains the minimum shape ImportTenantDialog cares about:
//   - parsed.tenants[0] (taxId matching our seeded disposable tenant)
//   - parsed.properties[0] (so the preview row renders cleanly)
//   - parsed.classification.kind === 'extension' + matchedTenantId
// The dialog's useEffect at ImportTenantDialog.js:231-257 keys off
// classificationKind === 'extension' to default importStrategies[0]='extend'.
// We assert the corresponding native radio (#strategy-extend-0) is checked.
// ---------------------------------------------------------------------------
test('33E · ImportTenantDialog radio defaults to "Extend lease" for kind=extension matched tenant', async ({
  page
}) => {
  if (!_seed) throw new Error('seed not ready');

  // Compute a parsed-PDF response shape that classifyAgainstExisting would
  // have emitted server-side (kind=extension): same primary taxId as the
  // disposable tenant, validityStart within 30d of the existing endDate,
  // validityEnd extends past it.
  const newEndDate = new Date(_seed.endIso + 'T00:00:00Z');
  newEndDate.setUTCMonth(newEndDate.getUTCMonth() + 12);
  const mockedParsedResponse = {
    validityStart: _seed.endApi, // exactly the existing endDate → diff = 0
    validityEnd: toDDMMYYYY(newEndDate.toISOString().substring(0, 10)),
    originalStartDate: _seed.beginApi,
    declarationNumber: 'MOCK-EXT-33E',
    amendsDeclaration: '',
    totalMonthlyRent: 500,
    notes: '',
    tenants: [
      {
        name: _seed.tenantName,
        taxId: _seed.taxId,
        acceptanceDate: _seed.beginApi
      }
    ],
    landlords: [],
    properties: [
      {
        atakNumber: 'MOCK-ATAK-33E',
        type: 'apartment',
        surface: 50,
        monthlyRent: 500,
        address: {
          street1: 'Mock Street 1',
          zipCode: '00000',
          city: 'Athens',
          state: '',
          country: 'Ελλάδα'
        },
        rawAddress: 'Mock Street 1, Όροφος 1'
      }
    ],
    classification: {
      kind: 'extension',
      matchedTenantId: _seed.tenantId
    }
  };

  // Sign in via UI.
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
    .toMatch(/\/(firstaccess|dashboard)/);

  // Mock the parse response BEFORE navigating to /tenants — the dialog
  // POSTs to /api/v2/tenants/import-pdf when the user clicks Continue.
  await page.route(
    (url) => url.pathname.endsWith('/api/v2/tenants/import-pdf'),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockedParsedResponse)
      });
    }
  );

  await page.goto(`${encodeURIComponent(_seed.realmName)}/tenants`);
  await page.waitForLoadState('networkidle');

  // Open the dialog. Button label is locale-dependent (Greek deployment by
  // default on NAS); accept either.
  await page
    .locator('button', {
      hasText: /Import lease PDF|Εισαγωγή μισθωτηρίου/
    })
    .first()
    .click();
  await expect(
    page
      .locator(
        'text=/Drop PDF files here|Drop a PDF file here|Σύρετε αρχεία PDF|Σύρετε αρχείο/i'
      )
      .first()
  ).toBeVisible({ timeout: 10_000 });

  // Upload a placeholder buffer. The server-side parse is mocked so the
  // file content doesn't matter; FileDropZone just needs SOMETHING for
  // FormData.append('pdf', file) to fire.
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.setInputFiles({
    name: 'mock-extension.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%mock\n', 'utf8')
  });

  // Click Continue → triggers handleParse → routes through our mock.
  const parseRespP = page.waitForResponse(
    (r) => r.url().includes('/api/v2/tenants/import-pdf'),
    { timeout: 30_000 }
  );
  await page.locator('button[data-cy=parseLease]').first().click();
  const parseR = await parseRespP;
  expect(
    parseR.status(),
    'mocked parse response must come back 200'
  ).toBe(200);

  // Wait for the preview pane to render — the matched-tenant section only
  // appears once existingTenants resolves AND matchInfos picks up the row.
  // The "Lease extension detected" label is the strongest signal.
  await expect(
    page
      .locator('text=/Lease extension detected|Ανίχνευση παράτασης/i')
      .first()
  ).toBeVisible({ timeout: 15_000 });

  // ----- the actual H6/dialog assertion -----
  // RadioGroupItem at id=`strategy-extend-${idx}` (idx=0 — only one parsed
  // result). Native input[type=radio] under our shadcn shim. The dialog's
  // useEffect at ImportTenantDialog.js:231-257 sets importStrategies[0]
  // to 'extend' when classificationKind === 'extension' and the user
  // hasn't yet picked an explicit choice — so #strategy-extend-0 should
  // start checked.
  const extendRadio = page.locator('#strategy-extend-0');
  await expect(extendRadio, 'extend radio rendered').toBeVisible({
    timeout: 10_000
  });
  await expect(
    extendRadio,
    'extend radio defaults to checked for classificationKind=extension'
  ).toBeChecked();
  // Negative pole: replace + new must NOT be checked.
  await expect(
    page.locator('#strategy-replace-0'),
    'replace radio not checked for classificationKind=extension'
  ).not.toBeChecked();
  await expect(
    page.locator('#strategy-new-0'),
    'new radio not checked for classificationKind=extension'
  ).not.toBeChecked();

  // Close cleanly so we don't fire an actual extend POST and bump __v
  // halfway through the spec — the API path is covered by 33D.
  await page.keyboard.press('Escape');
});
