/**
 * Spec 32 — GET /api/v2/tenants?expiringWithin=N (HTTP filter).
 *
 * Surface: services/api/src/managers/occupantmanager.ts — the
 * `?expiringWithin=N` query filter (window bounds + archived exclusion).
 *
 * HISTORY (2026-08-02): this spec also asserted the dashboard
 * ExpiringLeasesTile UI. That tile was REMOVED — lease expiry is now a push
 * notification (bell InboxItem kind:'notice' + Telegram) produced by the
 * daily scanner. The tile-UI assertions and the blur+focus refetch block
 * were deleted with it; the server-side filter contract below is unchanged.
 *
 * Coverage targets:
 *  - J-1C: HTTP filter `?expiringWithin=N` — happy path + bounds (-1, 4000).
 *  - Archived exclusion: the API filter MUST drop archived tenants even when
 *    their endDate is inside the window.
 *
 * Discipline (per .kiro/steering/test-running-guide.md):
 *  - Set-narrowing on the OUR-fixtures axis, not tautological assertions.
 *  - Status assertion on every awaited HTTP response.
 *
 * Seeds (3 fresh tenants, unique AFMs, namespaced names with timestamp so
 * concurrent reruns don't collide and a stale leftover from an earlier run
 * cannot satisfy the count assertion):
 *  - A: endDate today + 5d, NOT archived → inside both the 60-day and the
 *       N=20 API window.
 *  - B: endDate today + 90d, NOT archived → outside both windows.
 *  - C: endDate today + 5d, ARCHIVED → the server-side filter drops archived
 *       even though endDate is inside both windows.
 */
import { expect, request, test, Page, APIRequestContext } from '@playwright/test';
import { getAccessToken } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';
const TEST_ORG_NAME = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';

// Three checksum-valid Greek AFMs (validated by hand against the
// modulo-11 routine in services/api/src/utils/validators.ts → see commit
// 5291f388 for the canonical 123456783 example):
//   100000003: 1*256 = 256, 256 mod 11 = 3, 3 mod 10 = 3 ✓
//   200000006: 2*256 = 512, 512 mod 11 = 6, 6 mod 10 = 6 ✓
//   300000009: 3*256 = 768, 768 mod 11 = 9, 9 mod 10 = 9 ✓
const AFM_A = '100000003';
const AFM_B = '200000006';
const AFM_C = '300000009';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD');
  }
});

interface FixtureSet {
  token: string;
  realmId: string;
  realmName: string;
  tenantAId: string;
  tenantAName: string;
  tenantBId: string;
  tenantBName: string;
  tenantCId: string;
  tenantCName: string;
}

function toDDMMYYYY(d: Date): string {
  // The API _stringToDate parser is strict on DD/MM/YYYY (occupantmanager.ts).
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

function dateAtOffsetDays(days: number): Date {
  // UTC-anchored offset so positive-tz hosts (Athens UTC+2/+3) don't slip
  // a day. The server's _isExpiringSoon uses moment.utc() too.
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
}

async function authHeaders(token: string, realmId?: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(realmId ? { organizationid: realmId } : {})
  };
}

async function ensureRealm(api: APIRequestContext, token: string): Promise<{ realmId: string; realmName: string }> {
  // Idempotent: list, find the canonical test realm by exact name; create it
  // if missing. Mirrors lib/api.ts ensureSeed semantics so this spec doesn't
  // pollute someone else's realm.
  const realmsResp = await api.get(`${GATEWAY}/api/v2/realms`, {
    headers: await authHeaders(token)
  });
  expect(realmsResp.status(), 'list realms').toBe(200);
  const realms = (await realmsResp.json()) as Array<{ _id: string; name: string }>;
  let realm = realms.find((r) => r.name === TEST_ORG_NAME);
  if (!realm) {
    const created = await api.post(`${GATEWAY}/api/v2/realms`, {
      headers: await authHeaders(token),
      data: {
        name: TEST_ORG_NAME,
        locale: process.env.TEST_LOCALE || 'el',
        currency: process.env.TEST_CURRENCY || 'EUR',
        isCompany: false,
        addresses: [{}],
        bankInfo: {},
        contacts: []
      }
    });
    expect([200, 201], 'create realm').toContain(created.status());
    realm = (await created.json()) as { _id: string; name: string };
  }
  return { realmId: realm._id, realmName: realm.name };
}

async function createTenant(
  api: APIRequestContext,
  token: string,
  realmId: string,
  args: { name: string; firstName: string; lastName: string; taxId: string; beginDate: string; endDate: string }
): Promise<{ _id: string; name: string }> {
  // Tier A1 gate: natural-person tenants need firstName + lastName + taxId
  // (taxId checksum-validated by Tier C1). beginDate/endDate are required for
  // the server-side _isExpiringSoon predicate to consider the tenant.
  const created = await api.post(`${GATEWAY}/api/v2/tenants`, {
    headers: await authHeaders(token, realmId),
    data: {
      name: args.name,
      isCompany: false,
      manager: args.name,
      firstName: args.firstName,
      lastName: args.lastName,
      taxId: args.taxId,
      contacts: [{ contact: args.name, email: '', phone1: '6900000000', phone: '', phone2: '' }],
      beginDate: args.beginDate,
      endDate: args.endDate,
      stepperMode: true
    }
  });
  expect(
    created.status(),
    `create tenant ${args.name}: body=${await created.text().catch(() => '')}`
  ).toBe(200);
  return (await created.json()) as { _id: string; name: string };
}

async function archiveTenant(api: APIRequestContext, token: string, realmId: string, tenantId: string) {
  // PUT /api/v2/tenants/:id/archive sets archived=true (does NOT set
  // terminationDate, so this is a clean archived-only signal — exactly
  // what we need to verify the server filter drops archived tenants).
  const r = await api.put(`${GATEWAY}/api/v2/tenants/${tenantId}/archive`, {
    headers: await authHeaders(token, realmId),
    data: {}
  });
  expect(r.status(), `archive tenant ${tenantId}`).toBe(200);
}

async function deleteTenantHard(api: APIRequestContext, token: string, realmId: string, tenantId: string) {
  // DELETE /api/v2/tenants/:ids — best-effort cleanup. Tenants with no rents
  // are hard-deleted. Tenants with payments would be force-archived; we don't
  // seed payments here so delete should succeed. Failures are non-fatal —
  // the spec is idempotent across runs because each tenant name carries the
  // run's timestamp and a 422 from a leftover doesn't fail the next run.
  const r = await api.delete(`${GATEWAY}/api/v2/tenants/${tenantId}`, {
    headers: await authHeaders(token, realmId)
  });
  if (r.status() >= 400 && r.status() !== 404) {
    // Best-effort: log but don't fail. Subsequent runs use a fresh timestamp.
    // eslint-disable-next-line no-console
    console.warn(`cleanup delete tenant ${tenantId} status=${r.status()} body=${await r.text().catch(() => '')}`);
  }
}

async function setupFixtures(api: APIRequestContext): Promise<FixtureSet> {
  const token = await getAccessToken(api);
  const { realmId, realmName } = await ensureRealm(api, token);

  // Suffix every tenant name with a fresh timestamp so concurrent runs and
  // partial-cleanup leftovers from prior runs cannot satisfy the assertion.
  const ts = Date.now();
  const beginISO = dateAtOffsetDays(-30); // 30 days ago for begin
  const endA = dateAtOffsetDays(5);       // +5 days  → in window
  const endB = dateAtOffsetDays(90);      // +90 days → out of 60-day tile window
  const endC = dateAtOffsetDays(5);       // +5 days, then archived

  const a = await createTenant(api, token, realmId, {
    name: `E2E-Expiring-A-${ts}`,
    firstName: 'ExpiringA',
    lastName: `Run${ts}`,
    taxId: AFM_A,
    beginDate: toDDMMYYYY(beginISO),
    endDate: toDDMMYYYY(endA)
  });
  const b = await createTenant(api, token, realmId, {
    name: `E2E-Expiring-B-${ts}`,
    firstName: 'ExpiringB',
    lastName: `Run${ts}`,
    taxId: AFM_B,
    beginDate: toDDMMYYYY(beginISO),
    endDate: toDDMMYYYY(endB)
  });
  const c = await createTenant(api, token, realmId, {
    name: `E2E-Expiring-C-${ts}`,
    firstName: 'ExpiringC',
    lastName: `Run${ts}`,
    taxId: AFM_C,
    beginDate: toDDMMYYYY(beginISO),
    endDate: toDDMMYYYY(endC)
  });

  // Archive C — the archived-exclusion test case.
  await archiveTenant(api, token, realmId, c._id);

  return {
    token,
    realmId,
    realmName,
    tenantAId: a._id,
    tenantAName: a.name,
    tenantBId: b._id,
    tenantBName: b.name,
    tenantCId: c._id,
    tenantCName: c.name
  };
}

async function teardownFixtures(api: APIRequestContext, fx: FixtureSet) {
  // Best-effort cleanup so we don't bloat the realm with E2E-Expiring-*
  // tenants. Each tenant has no rents (no leaseId on payload) so DELETE is
  // accepted; archived tenants delete the same way — the archive flag is
  // independent of the rent ledger guard.
  await deleteTenantHard(api, fx.token, fx.realmId, fx.tenantAId);
  await deleteTenantHard(api, fx.token, fx.realmId, fx.tenantBId);
  await deleteTenantHard(api, fx.token, fx.realmId, fx.tenantCId);
}


test.describe('ExpiringLeasesTile — J-1C HTTP filter, tile UI, archived exclusion', () => {
  test('`expiringWithin` HTTP filter: happy path, archived excluded, bounds 422', async () => {
    test.setTimeout(180_000);

    // ----- arrange: API seeds + token -----
    const apiCtx = await request.newContext();
    const fx = await setupFixtures(apiCtx);

    try {
      // -----------------------------------------------------------------
      // Server-side validation (J-1C HTTP filter coverage)
      // -----------------------------------------------------------------

      // Negative N → 422.
      const negResp = await apiCtx.get(
        `${GATEWAY}/api/v2/tenants?expiringWithin=-1`,
        { headers: await authHeaders(fx.token, fx.realmId) }
      );
      expect(
        negResp.status(),
        'expiringWithin=-1 must be rejected with 422 (occupantmanager guard: parsed < 0)'
      ).toBe(422);

      // Too-large N → 422 (cap is 3650 per the guard).
      const bigResp = await apiCtx.get(
        `${GATEWAY}/api/v2/tenants?expiringWithin=4000`,
        { headers: await authHeaders(fx.token, fx.realmId) }
      );
      expect(
        bigResp.status(),
        'expiringWithin=4000 must be rejected with 422 (cap=3650)'
      ).toBe(422);

      // Happy path: N=20. The window is [today, today+20]. Of the 3 seeded:
      //   - A (+5d, not archived) → in window
      //   - B (+90d, not archived) → out of window
      //   - C (+5d, archived) → excluded (archived flag drops it server-side)
      // Result MUST contain A and MUST NOT contain B or C.
      const okResp = await apiCtx.get(
        `${GATEWAY}/api/v2/tenants?expiringWithin=20`,
        { headers: await authHeaders(fx.token, fx.realmId) }
      );
      expect(okResp.status(), 'expiringWithin=20 must be 200').toBe(200);
      const filtered = (await okResp.json()) as Array<{ _id: string; name: string; archived?: boolean }>;
      const namesInFilter = filtered.map((t) => t.name);

      expect(
        namesInFilter,
        `expiringWithin=20 must include the +5d non-archived tenant (got: ${JSON.stringify(namesInFilter)})`
      ).toContain(fx.tenantAName);
      expect(
        namesInFilter,
        `expiringWithin=20 must NOT include the +90d tenant (out of N=20 window)`
      ).not.toContain(fx.tenantBName);
      expect(
        namesInFilter,
        `expiringWithin=20 must NOT include the archived tenant (archived exclusion is the J-1C contract)`
      ).not.toContain(fx.tenantCName);

      // No filter result should claim an archived flag (defense in depth —
      // the server filter is supposed to drop them before serialization).
      for (const t of filtered) {
        expect(
          t.archived,
          `tenant ${t.name} returned with archived=true while expiringWithin filter active`
        ).not.toBe(true);
      }

      // The dashboard tile uses HORIZON_DAYS=60 — verify the same
      // archived-exclusion holds at that horizon, and that B (at +90d)
      // is still out of range. This is the EXACT query the tile fires.
      const tileApiResp = await apiCtx.get(
        `${GATEWAY}/api/v2/tenants?expiringWithin=60`,
        { headers: await authHeaders(fx.token, fx.realmId) }
      );
      expect(tileApiResp.status(), 'expiringWithin=60 (tile horizon) must be 200').toBe(200);
      const tileFiltered = (await tileApiResp.json()) as Array<{ _id: string; name: string }>;
      const tileApiNames = tileFiltered.map((t) => t.name);

      expect(tileApiNames, 'tile-horizon API must include A').toContain(fx.tenantAName);
      expect(tileApiNames, 'tile-horizon API must NOT include B (+90d > 60d)').not.toContain(
        fx.tenantBName
      );
      expect(tileApiNames, 'tile-horizon API must NOT include archived C').not.toContain(
        fx.tenantCName
      );

      // Count of OUR seeded tenants in the tile-horizon API result. The realm
      // may host other tenants from sibling specs, so we count the subset
      // that belongs to this run's fixtures by matching the timestamped
      // names. This is the count we will compare the tile UI's row count
      // against (set-narrowing on the OUR-fixtures axis).
      const ourSeededNames = new Set([fx.tenantAName, fx.tenantBName, fx.tenantCName]);
      const ourCountInTileApi = tileApiNames.filter((n) => ourSeededNames.has(n)).length;
      expect(
        ourCountInTileApi,
        'exactly 1 of our 3 seeded tenants must be returned by the tile-horizon API ' +
          '(A in window, B out, C archived)'
      ).toBe(1);

      // The tile-UI half of this test (and its blur+focus refetch
      // assertions) was removed on 2026-08-02 together with the
      // ExpiringLeasesTile component: lease expiry is now a PUSH
      // notification (bell InboxItem kind:'notice' + Telegram) emitted by
      // the daily scanner, not a dashboard tile. The HTTP-filter contract
      // asserted above is the durable part and is unaffected.

    } finally {
      // ----- teardown: best-effort tenant cleanup -----
      await teardownFixtures(apiCtx, fx);
      await apiCtx.dispose();
    }
  });
});
