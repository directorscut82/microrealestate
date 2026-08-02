/**
 * Spec 46 — GET /tenants?expiringWithin + lease-expiry scanner debounce
 *           contract.
 *
 * Surface:
 *  - GET /api/v2/tenants?expiringWithin=N (HTTP filter — services/api/src/
 *    managers/occupantmanager.ts).
 *  - services/api/src/jobs/leaseExpiryScanner.ts per-window debounce
 *    (expiryNoticesSent[{window, sentAt}]).
 *
 * HISTORY (2026-08-02): this spec had 9 tests, 5 of which asserted the
 * dashboard ExpiringLeasesTile. That tile was REMOVED — lease expiry is now
 * a push notification (bell InboxItem kind:'notice' + Telegram) produced by
 * the daily scanner, not a dashboard surface. The 5 tile tests and the
 * tile-UI tails of tests 3/6/7 were deleted with it; the 4 surviving tests
 * are the server-side contracts, which are unchanged by the UI removal.
 *
 * Coverage now:
 *  3. Archived tenant near expiry → excluded server-side.
 *  6. Per-window debounce: an expiryNoticesSent[{window:30}] record does NOT
 *     suppress a later 7-day window — the data-shape contract the scanner
 *     reads.
 *  7. Same-window suppression: the window-30 record is the contract the
 *     scanner reads; the HTTP filter still returns the tenant (debounce is
 *     scanner-side only).
 *  8. Empty-recipient realm structural-skip (J1C-004): the schema accepts
 *     {window, sentAt} round-trips so the cron marks the window and doesn't
 *     loop.
 *
 * Why 6/7/8 are NOT scanner subprocess invocations:
 *  The scanner only runs in-process under the api container (cron tick).
 *  There is no HTTP route that exposes checkExpiringLeases() with mocked
 *  deps — that's the canonical jest unit-test surface (services/api/src/
 *  __tests__/leaseExpiryScanner.test.js). This spec instead asserts the
 *  data-state CONTRACT the scanner depends on. The bell-notice creation the
 *  scanner now also performs is covered by that same jest suite.
 *
 * Discipline (per .kiro/steering/test-running-guide.md):
 *  - Set-narrowing via toHaveCount, NOT tautological toBeVisible.
 *  - Status assertion on every awaited HTTP response.
 *  - No waitForTimeout — wait on responses / locators / expect.poll.
 *  - Fixtures namespaced by discriminator; cleanup by name prefix.
 */
import {
  expect,
  request,
  test,
  Page,
  APIRequestContext
} from '@playwright/test';
import { getAccessToken } from './lib/api';
import { mongoExec } from './lib/mongoExec';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';
const TEST_LOCALE = process.env.TEST_LOCALE || 'el';
const TEST_CURRENCY = process.env.TEST_CURRENCY || 'EUR';

// Six checksum-valid Greek AFMs (modulo-11 routine, see spec 32 for the
// derivation; the validators in services/api/src/utils/validators.ts use
// the canonical 1*256/2*256/3*256 mapping):
//   100000003 → 1*256 mod 11 mod 10 = 3 ✓
//   200000006 → 2*256 mod 11 mod 10 = 6 ✓
//   300000009 → 3*256 mod 11 mod 10 = 9 ✓
//   400000001 → 4*256 mod 11 mod 10 = 1 ✓
//   500000004 → 5*256 mod 11 mod 10 = 4 ✓
//   600000007 → 6*256 mod 11 mod 10 = 7 ✓
const AFM_5D = '100000003';
const AFM_ARCHIVED = '400000001';
const AFM_DEBOUNCE = '500000004';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error(
      'Missing TEST_EMAIL/TEST_PASSWORD. Expected .secrets/cypress-test-account.'
    );
  }
});

interface EphemeralRealm {
  token: string;
  realmId: string;
  realmName: string;
  // Per-test fixture-name namespace. All tenants this test creates are
  // named with this prefix so cleanup can delete exactly its own data
  // from the shared canonical realm.
  fixtureTag?: string;
}

function toDDMMYYYY(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

function dateAtOffsetDays(days: number): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days)
  );
}

function authHeaders(token: string, realmId?: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(realmId ? { organizationid: realmId } : {})
  };
}

/**
 * Create a fresh, namespaced realm for this test. The realm name carries a
 * timestamp + discriminator so concurrent runs / partial-cleanup leftovers
 * cannot ever satisfy assertions on a previous run's data.
 *
 * The test account already exists; we just spin up an additional realm
 * under it. The realm is best-effort cleaned up in finally — failures are
 * non-fatal because the next run picks a different timestamp.
 */
// NOTE (round-3 fix): this used to create a brand-new ephemeral realm per
// test. That pattern is fundamentally broken for UI tests — the signed-in
// session's realm list is cached at signin, so a realm created AFTER
// signin is invisible to the browser, and every /[realm]/dashboard
// navigation 404'd. All 8 UI tests timed out waiting for the tile.
//
// Fixed by using the CANONICAL test realm (CYPRESS-TEST-DO-NOT-USE) that
// the bot account already owns — the same realm spec 32 uses. Per-test
// isolation comes from a unique discriminator baked into every fixture
// tenant's name; cleanup deletes by that name prefix. The discriminator
// makes concurrent runs / partial-cleanup leftovers unable to satisfy a
// stale assertion.
async function createEphemeralRealm(
  api: APIRequestContext,
  discriminator: string
): Promise<EphemeralRealm> {
  const token = await getAccessToken(api);
  // Resolve (idempotently) the canonical test realm.
  const realmsResp = await api.get(`${GATEWAY}/api/v2/realms`, {
    headers: authHeaders(token)
  });
  expect(realmsResp.status(), 'list realms').toBe(200);
  const realms = (await realmsResp.json()) as Array<{
    _id: string;
    name: string;
  }>;
  const orgName = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';
  let realm = realms.find((r) => r.name === orgName);
  if (!realm) {
    const created = await api.post(`${GATEWAY}/api/v2/realms`, {
      headers: authHeaders(token),
      data: {
        name: orgName,
        locale: TEST_LOCALE,
        currency: TEST_CURRENCY,
        isCompany: false,
        addresses: [{}],
        bankInfo: {},
        contacts: []
      }
    });
    expect([200, 201], 'create canonical realm').toContain(created.status());
    realm = (await created.json()) as { _id: string; name: string };
  }
  // The discriminator is the per-test fixture-name namespace, returned so
  // each test tags its tenants and cleans them up afterwards.
  return {
    token,
    realmId: realm._id,
    realmName: realm.name,
    fixtureTag: `E2E-S46-${discriminator}-${Date.now()}`
  };
}

async function deleteEphemeralRealm(
  api: APIRequestContext,
  fx: EphemeralRealm
): Promise<void> {
  // We do NOT delete the canonical realm — only the tenants this test
  // created (matched by the per-test fixtureTag name prefix). This keeps
  // the shared realm clean across runs without nuking other specs' data.
  if (!fx.fixtureTag) return;
  // fixtureTag is "E2E-S46-<disc>-<ts>"; the test's tenants are named
  // "E2E-S46-<disc>-<...>" — share the "E2E-S46-<disc>-" prefix. Strip
  // the trailing timestamp from fixtureTag to get that shared prefix.
  const sharedPrefix = fx.fixtureTag.replace(/-\d+$/, '-');
  try {
    const resp = await api.get(`${GATEWAY}/api/v2/tenants`, {
      headers: authHeaders(fx.token, fx.realmId)
    });
    if (resp.status() !== 200) return;
    const tenants = (await resp.json()) as Array<{ _id: string; name: string }>;
    const mine = tenants.filter(
      (t) => t.name && t.name.startsWith(sharedPrefix)
    );
    for (const t of mine) {
      await api
        .delete(`${GATEWAY}/api/v2/tenants/${t._id}`, {
          headers: authHeaders(fx.token, fx.realmId)
        })
        .catch(() => {});
    }
  } catch {
    // swallow — non-fatal; the unique fixtureTag prevents cross-run bleed
  }
}

interface CreateTenantArgs {
  name: string;
  firstName: string;
  lastName: string;
  taxId: string;
  beginDate: string;
  endDate: string;
}

async function createTenant(
  api: APIRequestContext,
  fx: EphemeralRealm,
  args: CreateTenantArgs
): Promise<{ _id: string; name: string }> {
  // Tier A1 gate: natural-person tenants need firstName + lastName + taxId.
  // beginDate/endDate are required for the server-side _isExpiringSoon
  // predicate to consider the tenant.
  const created = await api.post(`${GATEWAY}/api/v2/tenants`, {
    headers: authHeaders(fx.token, fx.realmId),
    data: {
      name: args.name,
      isCompany: false,
      manager: args.name,
      firstName: args.firstName,
      lastName: args.lastName,
      taxId: args.taxId,
      contacts: [
        {
          contact: args.name,
          email: '',
          phone1: '6900000000',
          phone: '',
          phone2: ''
        }
      ],
      beginDate: args.beginDate,
      endDate: args.endDate,
      stepperMode: true
    }
  });
  expect(
    created.status(),
    `create tenant ${args.name} (body: ${await created.text().catch(() => '')})`
  ).toBe(200);
  return (await created.json()) as { _id: string; name: string };
}

async function archiveTenant(
  api: APIRequestContext,
  fx: EphemeralRealm,
  tenantId: string
): Promise<void> {
  // PUT /api/v2/tenants/:id/archive sets archived=true. Does NOT set
  // terminationDate, so this is a clean archived-only signal.
  const r = await api.put(`${GATEWAY}/api/v2/tenants/${tenantId}/archive`, {
    headers: authHeaders(fx.token, fx.realmId),
    data: {}
  });
  expect(r.status(), `archive tenant ${tenantId}`).toBe(200);
}

async function deleteTenantBestEffort(
  api: APIRequestContext,
  fx: EphemeralRealm,
  tenantId: string
): Promise<void> {
  try {
    await api.delete(`${GATEWAY}/api/v2/tenants/${tenantId}`, {
      headers: authHeaders(fx.token, fx.realmId)
    });
  } catch {
    // swallow
  }
}

test.describe('Spec 46 — ExpiringLeasesTile + GET /tenants?expiringWithin + scanner debounce contract', () => {
  // -----------------------------------------------------------------------
  // Test 3 — archived tenant near expiry is excluded server-side.
  //   - Seed one tenant in-window AND one tenant in-window + archived.
  //   - GET expiringWithin=60 must include the non-archived but exclude
  //     the archived (server filter `archived: { $ne: true }`).
  //   - Tile body must render exactly 1 row, never the archived one.
  // -----------------------------------------------------------------------
  test('Test 3 — archived tenant with endDate near expiry is excluded server-side', async () => {
    test.setTimeout(180_000);
    const apiCtx = await request.newContext();
    const fx = await createEphemeralRealm(apiCtx, 'T3');
    const beginISO = dateAtOffsetDays(-30);
    const endNear = dateAtOffsetDays(15); // squarely inside 60-day window

    let alive: { _id: string; name: string } | null = null;
    let archived: { _id: string; name: string } | null = null;
    try {
      alive = await createTenant(apiCtx, fx, {
        name: `E2E-S46-T3-alive-${Date.now()}`,
        firstName: 'Alive',
        lastName: 'Near',
        taxId: AFM_5D,
        beginDate: toDDMMYYYY(beginISO),
        endDate: toDDMMYYYY(endNear)
      });
      archived = await createTenant(apiCtx, fx, {
        name: `E2E-S46-T3-archived-${Date.now()}`,
        firstName: 'Archived',
        lastName: 'Near',
        taxId: AFM_ARCHIVED,
        beginDate: toDDMMYYYY(beginISO),
        endDate: toDDMMYYYY(endNear)
      });
      await archiveTenant(apiCtx, fx, archived._id);

      // HTTP filter contract.
      const apiResp = await apiCtx.get(
        `${GATEWAY}/api/v2/tenants?expiringWithin=60`,
        { headers: authHeaders(fx.token, fx.realmId) }
      );
      expect(apiResp.status(), 'expiringWithin=60 status').toBe(200);
      const tenantsApi = (await apiResp.json()) as Array<{
        _id: string;
        name: string;
        archived?: boolean;
      }>;
      const names = tenantsApi.map((t) => t.name);
      expect(names, 'alive tenant must be in result').toContain(alive.name);
      expect(
        names,
        'archived tenant MUST be excluded by server filter'
      ).not.toContain(archived.name);
      // Defense in depth: no row in the result has archived=true.
      for (const t of tenantsApi) {
        expect(
          t.archived,
          `tenant ${t.name} returned with archived=true (filter contract violation)`
        ).not.toBe(true);
      }

      // The tile-UI half of this test was removed on 2026-08-02 with the
      // ExpiringLeasesTile itself (the condition is now a bell notice +
      // Telegram push, not a dashboard tile). The server-side filter
      // contract asserted above is the durable part and still holds.
    } finally {
      if (alive) await deleteTenantBestEffort(apiCtx, fx, alive._id);
      if (archived) await deleteTenantBestEffort(apiCtx, fx, archived._id);
      await deleteEphemeralRealm(apiCtx, fx);
      await apiCtx.dispose();
    }
  });

  // -----------------------------------------------------------------------
  // Test 6 — per-window debounce data contract.
  //
  //   Briefing description:
  //     "stub scanner via deps to send 30-day window, advance time 23
  //      days, set tenant to +7d, run scanner → SHOULD send (different
  //      window)"
  //
  //   Why we don't drive checkExpiringLeases() from this Playwright spec:
  //   the scanner module is loaded inside the api container's Service
  //   bootstrap; it is not exposed via HTTP nor reachable via deep-
  //   require from the Playwright runner. The canonical jest unit-test
  //   suite at services/api/src/__tests__/leaseExpiryScanner.test.js
  //   exercises that exact branch with mocked deps.
  //
  //   What we DO assert here (the data-shape contract the scanner reads):
  //     1. Seed a tenant with endDate = +7d.
  //     2. Mongo-write expiryNoticesSent = [{window: 30, sentAt: <23d
  //        ago>}] — simulating "the 30-day notice fired 23 days ago".
  //     3. Read it back via mongo: schema accepts the shape, sentAt
  //        round-trips as a Date.
  //     4. Verify the GET filter STILL returns the tenant (the HTTP path
  //        does not apply per-window debounce — that's scanner-side
  //        only). The tile must render the tenant.
  //   The combination guarantees the on-disk schema is what the scanner
  //   logic in the jest tests assumes; if the schema regressed (e.g.
  //   array nesting changed), the readback would fail.
  // -----------------------------------------------------------------------
  test('Test 6 — per-window debounce: a 30-day in-row marker does NOT block a later 7-day window (data contract)', async () => {
    test.setTimeout(180_000);
    const apiCtx = await request.newContext();
    const fx = await createEphemeralRealm(apiCtx, 'T6');
    const beginISO = dateAtOffsetDays(-30);
    const end7 = dateAtOffsetDays(7);

    let seeded: { _id: string; name: string } | null = null;
    try {
      seeded = await createTenant(apiCtx, fx, {
        name: `E2E-S46-T6-${Date.now()}`,
        firstName: 'Debounce',
        lastName: 'Window',
        taxId: AFM_DEBOUNCE,
        beginDate: toDDMMYYYY(beginISO),
        endDate: toDDMMYYYY(end7)
      });

      // Stamp a 30-day window marker at sentAt = 23 days ago. The
      // _windowDebounceCutoff for window=30 is now-31d, so 23d ago is
      // INSIDE the 30-day same-window cutoff (would suppress 30 again)
      // but does NOT block window=7 (different window key).
      //
      // The tenant's endDate is +7d so the live window is 7. The scanner
      // would fire the 7-day notice and add a {window:7,sentAt:now}
      // entry — without checking the {window:30} marker at all.
      //
      // We cannot run the scanner from here; we instead verify the data
      // contract:
      //   - expiryNoticesSent is array of {window, sentAt} entries
      //   - mongo accepts the write
      //   - the tenant is still returned by the HTTP filter at horizon=60
      //     (HTTP path does not apply per-window debounce)
      //   - the tile would surface this tenant for a 7-day notice.
      const sentAt23dAgo = dateAtOffsetDays(-23);
      const mongoWrite = mongoExec(`
        db.occupants.updateOne(
          { _id: ObjectId("${seeded._id}") },
          { $set: { expiryNoticesSent: [
            { window: 30, sentAt: new Date("${sentAt23dAgo.toISOString()}") }
          ] } }
        );
        var t = db.occupants.findOne({ _id: ObjectId("${seeded._id}") });
        print(JSON.stringify({
          hasField: Array.isArray(t.expiryNoticesSent),
          len: (t.expiryNoticesSent || []).length,
          window: t.expiryNoticesSent && t.expiryNoticesSent[0] && t.expiryNoticesSent[0].window,
          sentAtIso: t.expiryNoticesSent && t.expiryNoticesSent[0] && t.expiryNoticesSent[0].sentAt && t.expiryNoticesSent[0].sentAt.toISOString()
        }));
      `);
      // mongoExec returns null when the portainer token is unavailable —
      // skip the readback assertion in that case but still drive the UI
      // contract below. CI without a portainer token is dry-run.
      if (mongoWrite !== null) {
        const parsed = JSON.parse(mongoWrite);
        expect(
          parsed.hasField,
          'expiryNoticesSent is an array (schema contract)'
        ).toBe(true);
        expect(parsed.len, 'array has 1 entry after write').toBe(1);
        expect(
          Number(parsed.window),
          'first entry has numeric window field = 30'
        ).toBe(30);
        expect(
          typeof parsed.sentAtIso,
          'sentAt is a Date that serializes to ISO string'
        ).toBe('string');
        // sentAtIso should be ~23 days ago (within a few seconds tolerance).
        const written = new Date(parsed.sentAtIso);
        const drift = Math.abs(written.getTime() - sentAt23dAgo.getTime());
        expect(
          drift,
          'sentAt round-trips through mongo as a Date'
        ).toBeLessThan(5_000);
      }

      // HTTP filter contract: tenant STILL returned at horizon=60. The
      // GET path does not apply per-window debounce; the tile shows
      // expiring tenants regardless of notice state. This is the
      // "different-window does not block" property the scanner relies on
      // to fire the 7-day notice 23 days after the 30-day notice.
      const apiResp = await apiCtx.get(
        `${GATEWAY}/api/v2/tenants?expiringWithin=60`,
        { headers: authHeaders(fx.token, fx.realmId) }
      );
      expect(apiResp.status(), 'expiringWithin=60 status').toBe(200);
      const tenantsApi = (await apiResp.json()) as Array<{
        _id: string;
        name: string;
      }>;
      expect(
        tenantsApi.map((t) => t.name),
        'tenant with stale window-30 marker is STILL returned by HTTP filter'
      ).toContain(seeded.name);

      // The tile-UI tail was removed with the ExpiringLeasesTile on
      // 2026-08-02 (condition is now a bell notice + Telegram push). The
      // debounce-agnostic HTTP filter contract above is the durable part.
    } finally {
      if (seeded) await deleteTenantBestEffort(apiCtx, fx, seeded._id);
      await deleteEphemeralRealm(apiCtx, fx);
      await apiCtx.dispose();
    }
  });

  // -----------------------------------------------------------------------
  // Test 7 — same-window suppression contract.
  //
  //   Briefing description:
  //     "window 30 sent at T, advance to T+10d, run again → skip
  //      (same-window cooldown)"
  //
  //   Same caveat as Test 6: scanner is not Playwright-reachable. We
  //   verify the data contract:
  //     - schema round-trips a {window: 30, sentAt: <10d ago>} entry.
  //     - GET expiringWithin=60 still returns the tenant (HTTP path is
  //       debounce-agnostic — the scanner is the only place that
  //       suppresses based on prior-window markers).
  //     - The window-30 marker remains intact across a tile refetch.
  //   The scanner logic itself is covered by jest unit tests that read
  //   this exact schema shape.
  // -----------------------------------------------------------------------
  test('Test 7 — per-window debounce same-window suppression: window-30 marker is the contract the scanner reads', async () => {
    test.setTimeout(180_000);
    const apiCtx = await request.newContext();
    const fx = await createEphemeralRealm(apiCtx, 'T7');
    const beginISO = dateAtOffsetDays(-30);
    const end30 = dateAtOffsetDays(30); // squarely in window-30

    let seeded: { _id: string; name: string } | null = null;
    try {
      seeded = await createTenant(apiCtx, fx, {
        name: `E2E-S46-T7-${Date.now()}`,
        firstName: 'SameWindow',
        lastName: 'Cooldown',
        taxId: AFM_DEBOUNCE,
        beginDate: toDDMMYYYY(beginISO),
        endDate: toDDMMYYYY(end30)
      });

      // Stamp window-30 marker at 10 days ago. The same-window cutoff for
      // window=30 is now-31d, so 10d ago is INSIDE the cutoff →
      // scanner-side this would suppress a re-send.
      const sentAt10dAgo = dateAtOffsetDays(-10);
      const mongoWrite = mongoExec(`
        db.occupants.updateOne(
          { _id: ObjectId("${seeded._id}") },
          { $set: { expiryNoticesSent: [
            { window: 30, sentAt: new Date("${sentAt10dAgo.toISOString()}") }
          ] } }
        );
        var t = db.occupants.findOne({ _id: ObjectId("${seeded._id}") });
        print(JSON.stringify({
          len: (t.expiryNoticesSent || []).length,
          window: t.expiryNoticesSent && t.expiryNoticesSent[0] && t.expiryNoticesSent[0].window,
          sentAtIso: t.expiryNoticesSent && t.expiryNoticesSent[0] && t.expiryNoticesSent[0].sentAt && t.expiryNoticesSent[0].sentAt.toISOString()
        }));
      `);
      if (mongoWrite !== null) {
        const parsed = JSON.parse(mongoWrite);
        expect(parsed.len, 'window-30 marker persisted').toBe(1);
        expect(Number(parsed.window), 'window field is numeric 30').toBe(30);
        const written = new Date(parsed.sentAtIso);
        const drift = Math.abs(written.getTime() - sentAt10dAgo.getTime());
        expect(
          drift,
          'sentAt is exactly 10 days ago (within tolerance)'
        ).toBeLessThan(5_000);
      }

      // HTTP filter still returns the tenant — the scanner-side
      // suppression doesn't propagate to the GET path. Critical: the
      // tile must surface this tenant even though a recent notice was
      // sent, because users still want visibility into the lease.
      const apiResp = await apiCtx.get(
        `${GATEWAY}/api/v2/tenants?expiringWithin=60`,
        { headers: authHeaders(fx.token, fx.realmId) }
      );
      expect(apiResp.status(), 'expiringWithin=60 status').toBe(200);
      const tenantsApi = (await apiResp.json()) as Array<{ name: string }>;
      expect(
        tenantsApi.map((t) => t.name),
        'tenant with same-window marker is STILL returned by HTTP filter'
      ).toContain(seeded.name);

      // The tile-UI assertion was removed with the ExpiringLeasesTile on
      // 2026-08-02. The HTTP-path contract above (scanner-side suppression
      // does NOT hide the tenant from the filter) is what mattered here.

      // Re-readback: the marker survives the round-trip (no UI mutation
      // alters the field).
      if (mongoWrite !== null) {
        const post = mongoExec(`
          var t = db.occupants.findOne({ _id: ObjectId("${seeded._id}") });
          print(JSON.stringify({
            len: (t.expiryNoticesSent || []).length,
            window: t.expiryNoticesSent && t.expiryNoticesSent[0] && t.expiryNoticesSent[0].window
          }));
        `);
        if (post !== null) {
          const parsed = JSON.parse(post);
          expect(
            parsed.len,
            'window-30 marker survives a tile mount/render'
          ).toBe(1);
          expect(Number(parsed.window), 'window field still 30').toBe(30);
        }
      }
    } finally {
      if (seeded) await deleteTenantBestEffort(apiCtx, fx, seeded._id);
      await deleteEphemeralRealm(apiCtx, fx);
      await apiCtx.dispose();
    }
  });

  // -----------------------------------------------------------------------
  // Test 8 — empty-recipient realm contract (J1C-004).
  //
  //   Briefing description:
  //     "scanner stubs postEmail to throw 422 with 'missing recipient
  //      list' → markSent CALLED with windowDays so retry doesn't loop"
  //
  //   The scanner's catch block (leaseExpiryScanner.ts:223-235) detects
  //   a 422 + "missing recipient list" reason and calls
  //   markSent(tenantId, now, windowDays). Without the windowDays
  //   argument, the scanner would re-fire on the next cron tick — an
  //   infinite retry loop on realms with no admins.
  //
  //   What we verify here (data contract):
  //     - The schema accepts a markSent-shaped write: $push on
  //       expiryNoticesSent with {window, sentAt}.
  //     - $push is the canonical mongo idiom the default markSent uses
  //       (see leaseExpiryScanner.ts:140-147).
  //     - The window field is numeric (so the scanner's
  //       Number(e?.window) === daysUntil check works on round-trip).
  //   The scanner logic itself — that markSent is called WITH
  //   windowDays in the structural-skip path — is covered by the jest
  //   unit suite. This Playwright assertion guarantees the on-disk
  //   schema can hold what the scanner writes.
  // -----------------------------------------------------------------------
  test('Test 8 — empty-recipient realm contract: markSent shape with windowDays so retry does not loop (J1C-004)', async () => {
    test.setTimeout(180_000);
    const apiCtx = await request.newContext();
    const fx = await createEphemeralRealm(apiCtx, 'T8');
    const beginISO = dateAtOffsetDays(-30);
    const end30 = dateAtOffsetDays(30);

    let seeded: { _id: string; name: string } | null = null;
    try {
      seeded = await createTenant(apiCtx, fx, {
        name: `E2E-S46-T8-${Date.now()}`,
        firstName: 'NoRecipient',
        lastName: 'Realm',
        taxId: AFM_DEBOUNCE,
        beginDate: toDDMMYYYY(beginISO),
        endDate: toDDMMYYYY(end30)
      });

      // Simulate the scanner's structural-skip path (J1C-004): the
      // catch block calls markSent(id, now, windowDays). The default
      // markSent uses $push to add a new entry to expiryNoticesSent.
      // We exercise that exact mongo idiom and verify the round-trip.
      const now = new Date();
      const mongoWrite = mongoExec(`
        // First push: simulate markSent(id, now, 30) — with windowDays
        db.occupants.updateOne(
          { _id: ObjectId("${seeded._id}") },
          {
            $set: { lastExpiryNoticeSentAt: new Date("${now.toISOString()}") },
            $push: { expiryNoticesSent: { window: 30, sentAt: new Date("${now.toISOString()}") } }
          }
        );
        var t = db.occupants.findOne({ _id: ObjectId("${seeded._id}") });
        var entry = (t.expiryNoticesSent || [])[0] || {};
        print(JSON.stringify({
          len: (t.expiryNoticesSent || []).length,
          windowType: typeof entry.window,
          window: entry.window,
          sentAtType: entry.sentAt instanceof Date ? "date" : typeof entry.sentAt,
          lastSentSet: !!t.lastExpiryNoticeSentAt
        }));
      `);
      if (mongoWrite === null) {
        // Portainer token unavailable — this test's data contract cannot
        // be verified without mongo. Mark as a soft-skip with an info
        // message; the spec is still useful in environments that have
        // the credential.
        test.info().annotations.push({
          type: 'skip-reason',
          description:
            'mongoExec returned null (no portainer-token in .secrets) — markSent schema readback skipped'
        });
        return;
      }
      const parsed = JSON.parse(mongoWrite);
      expect(parsed.len, 'markSent($push) inserted exactly 1 entry').toBe(1);
      expect(
        parsed.windowType,
        'window field is numeric (scanner does Number(e?.window) on read)'
      ).toBe('number');
      expect(Number(parsed.window), 'window value persisted as 30').toBe(30);
      expect(
        parsed.sentAtType,
        'sentAt is a Date (so the scanner can compare with new Date(e.sentAt) >= cutoff)'
      ).toBe('date');
      expect(
        parsed.lastSentSet,
        'lastExpiryNoticeSentAt also set (legacy field for cross-window check)'
      ).toBe(true);

      // The structural-skip path's purpose is to PREVENT a retry loop.
      // Verify: a second call to the same markSent push (simulating the
      // scanner running again on the next cron tick) APPENDS — but the
      // scanner would have read the prior entry's sentAt and cutoff
      // against it. Confirm $push is additive, not destructive (so the
      // history is preserved for audit). Then confirm the FIRST entry's
      // window/sentAt were not lost.
      const secondWrite = mongoExec(`
        db.occupants.updateOne(
          { _id: ObjectId("${seeded._id}") },
          { $push: { expiryNoticesSent: { window: 30, sentAt: new Date() } } }
        );
        var t = db.occupants.findOne({ _id: ObjectId("${seeded._id}") });
        print(JSON.stringify({
          len: (t.expiryNoticesSent || []).length,
          firstWindow: t.expiryNoticesSent[0].window,
          windows: (t.expiryNoticesSent || []).map(function(e){return e.window;})
        }));
      `);
      if (secondWrite !== null) {
        const parsed2 = JSON.parse(secondWrite);
        expect(
          parsed2.len,
          '$push appends a second entry (history preserved)'
        ).toBe(2);
        expect(
          Number(parsed2.firstWindow),
          'first markSent entry window=30 still present after second push'
        ).toBe(30);
        expect(
          parsed2.windows.map(Number).every((w: number) => w === 30),
          'all entries are window=30 (markSent is per-window — same window pushed twice)'
        ).toBe(true);
      }

      // Final contract: the GET filter still returns the tenant
      // regardless of how many markSent entries we've written. The
      // tile-side surface is debounce-agnostic — the J1C-004 fix is
      // about preventing scanner-side retry loops, not about hiding
      // the tenant from the user.
      const apiResp = await apiCtx.get(
        `${GATEWAY}/api/v2/tenants?expiringWithin=60`,
        { headers: authHeaders(fx.token, fx.realmId) }
      );
      expect(apiResp.status(), 'expiringWithin=60 still 200').toBe(200);
      const tenants = (await apiResp.json()) as Array<{ name: string }>;
      expect(
        tenants.map((t) => t.name),
        'tenant still returned by HTTP filter — debounce is scanner-side'
      ).toContain(seeded.name);
    } finally {
      if (seeded) await deleteTenantBestEffort(apiCtx, fx, seeded._id);
      await deleteEphemeralRealm(apiCtx, fx);
      await apiCtx.dispose();
    }
  });
});
