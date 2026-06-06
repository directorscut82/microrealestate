/**
 * Spec 29 — Cross-surface search/filter catalog (3 scenarios).
 *
 * Catalog source: `.kiro/steering/test-running-guide.md` "Cross-surface"
 * section, scenarios 38-40 — where the search/filter bug actually
 * compounds (filter active on one page, mutation on another, then back).
 */
import { expect, request, test, Page } from '@playwright/test';
import {
  ensureSeedLeasedTenant,
  ensureSeedSecondTenant,
  getAccessToken
} from './lib/api';
import { mongoExec } from './lib/mongoExec';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD');
  }
});

async function signIn(page: Page) {
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
    .toMatch(/\/(firstaccess|dashboard)/);
}

function currentYearMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function currentTerm(): number {
  const now = new Date();
  return Number(
    `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}0100`
  );
}

async function clickFilterChip(page: Page, chipLabel: RegExp) {
  await page.getByRole('button', { name: /Filters|Φίλτρα/i }).first().click();
  await page.locator('li[role=menuitemcheckbox]', { hasText: chipLabel }).first().click();
  await page.keyboard.press('Escape');
}

async function resetTermToUnpaid(
  apiCtx: import('@playwright/test').APIRequestContext,
  token: string,
  realmId: string,
  tenantId: string
) {
  const auth = {
    Authorization: `Bearer ${token}`,
    organizationid: realmId,
    'Content-Type': 'application/json'
  };
  const now = new Date();
  await apiCtx.patch(
    `${GATEWAY}/api/v2/rents/payment/${tenantId}/${currentTerm()}`,
    {
      headers: auth,
      data: {
        _id: tenantId,
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        payments: [],
        promo: 0,
        extracharge: 0
      }
    }
  );
}

test('29.38 tenants-page filter survives a cross-surface payment mutation', async ({
  page
}) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedLeasedTenant(apiCtx);
  await apiCtx.dispose();

  await signIn(page);

  // Tenants page with "Lease running" chip on.
  await page.goto(`${encodeURIComponent(seed.realmName)}/tenants`);
  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.locator('[data-cy=openResourceButton]').first()
  ).toBeVisible({ timeout: 15_000 });

  await clickFilterChip(page, /Lease running|Σύμβαση σε ισχύ/i);

  // Capture filtered count and ensure the canonical leased tenant is in it.
  const filteredCount = await page
    .locator('[data-cy=openResourceButton]')
    .count();
  expect(filteredCount).toBeGreaterThan(0);
  await expect(
    page
      .locator('[data-cy=openResourceButton]')
      .filter({
        hasText: new RegExp(
          `^${seed.tenantName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}$`
        )
      })
  ).toBeVisible({ timeout: 10_000 });

  // Cross-surface mutation: record a payment via API on the rents path
  // for the leased tenant. (We can't always navigate the UI's per-row
  // cash icon since it may be off-screen; the API path exercises the
  // same invalidation path the dialog triggers via React Query.)
  const apiCtx2 = await request.newContext();
  const token = await getAccessToken(apiCtx2);
  const auth = {
    Authorization: `Bearer ${token}`,
    organizationid: seed.realmId,
    'Content-Type': 'application/json'
  };
  const now = new Date();
  const todayDDMMYYYY = `${String(now.getDate()).padStart(2, '0')}/${String(
    now.getMonth() + 1
  ).padStart(2, '0')}/${now.getFullYear()}`;
  const term = currentTerm();
  await apiCtx2.patch(
    `${GATEWAY}/api/v2/rents/payment/${seed.tenantId}/${term}`,
    {
      headers: auth,
      data: {
        _id: seed.tenantId,
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        payments: [
          {
            amount: 1,
            date: todayDDMMYYYY,
            type: 'cash',
            reference: `S29.38-${Date.now()}`
          }
        ],
        promo: 0,
        extracharge: 0
      }
    }
  );
  await apiCtx2.dispose();

  // Trigger a focus refetch to mimic returning to the tab.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  // Tenants filter STILL active: count holds, canonical tenant still visible.
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(filteredCount, { timeout: 15_000 });
  await expect(
    page
      .locator('[data-cy=openResourceButton]')
      .filter({
        hasText: new RegExp(
          `^${seed.tenantName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}$`
        )
      })
  ).toBeVisible();

  // Cleanup.
  const apiCtx3 = await request.newContext();
  await resetTermToUnpaid(apiCtx3, seed.token, seed.realmId, seed.tenantId);
  await apiCtx3.dispose();
});

test('29.39 Express drawer respects rents-page search filter', async ({ page }) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const seedAB = await ensureSeedSecondTenant(apiCtx);
  // Both tenants need open balances so the drawer has lines to settle.
  await resetTermToUnpaid(apiCtx, seedAB.token, seedAB.realmId, seedAB.tenantId);
  await resetTermToUnpaid(apiCtx, seedAB.token, seedAB.realmId, seedAB.tenantBId);
  await apiCtx.dispose();

  await signIn(page);
  await page.goto(
    `${encodeURIComponent(seedAB.realmName)}/rents/${currentYearMonth()}`
  );
  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.locator('[data-cy^="status-"]').first()
  ).toBeVisible({ timeout: 20_000 });

  // Pre-condition: both tenants appear in the unfiltered drawer.
  await page.locator('[data-cy=expressPaymentBtn]').click();
  let drawer = page.locator('[role=dialog][vaul-drawer]');
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  await expect(
    drawer.locator('div.border.rounded-md').filter({
      has: page.locator(`text="${seedAB.tenantName}"`)
    })
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    drawer.locator('div.border.rounded-md').filter({
      has: page.locator(`text="${seedAB.tenantBName}"`)
    })
  ).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible({ timeout: 5_000 });

  // Now apply a search that matches ONLY tenant A. RentTable feeds
  // ExpressPaymentDialog from its `rents` prop (= filtered data), so the
  // drawer must show only tenant A.
  //
  // Use tenant A's UNIQUE phone1 substring "00000000" (8 zeros) — appears
  // in A's "6900000000" but NOT in B's "6900000001". Searching by
  // `seedAB.tenantName` ("E2E-LeasedTenant") would substring-match
  // "E2E-LeasedTenant-B" because the rents page _filterData uses
  // indexOf, leaving 2+ rows visible and the count==1 expectation
  // failing with received 2 (or 4 if other leakage exists). Mirrors
  // spec 28.29 line 123 anchor.
  await page.locator('[data-cy=globalSearchField]').fill('00000000');
  // Wait for the rents page to narrow to 1 row.
  await expect(
    page.locator('[data-cy^="status-"]')
  ).toHaveCount(1, { timeout: 15_000 });

  await page.locator('[data-cy=expressPaymentBtn]').click();
  drawer = page.locator('[role=dialog][vaul-drawer]');
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  // Tenant A visible.
  await expect(
    drawer.locator('div.border.rounded-md').filter({
      has: page.locator(`text="${seedAB.tenantName}"`)
    })
  ).toBeVisible({ timeout: 10_000 });
  // Tenant B NOT visible (filter respected).
  await expect(
    drawer.locator('div.border.rounded-md').filter({
      has: page.locator(`text="${seedAB.tenantBName}"`)
    })
  ).not.toBeVisible({ timeout: 10_000 });
});

test('29.40 search active on tenants → terminate via API → filter outcome deterministic', async ({
  page
}) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedLeasedTenant(apiCtx);
  await apiCtx.dispose();

  // Pre-condition: $unset any leftover terminationDate on the canonical
  // tenant. The cleanup at end-of-test only runs when the test completes
  // — if a prior run failed mid-flow (e.g. because of a bug WE just
  // introduced), the canonical tenant stays terminated and every subsequent
  // run of 29.40 (and 25.x specs that rely on the canonical tenant being
  // active) cascades. Belt-and-braces: clear at start. CLAUDE.md "Test
  // seed leakage cascade" — only $unset (not PATCH null) clears reliably.
  try {
    mongoExec(
      `db.occupants.updateOne({_id: ObjectId('${seed.tenantId}')}, {\\$unset: {terminationDate: ''}});`
    );
  } catch (e) {
    // Best-effort. If mongoExec is unavailable (no portainer-token),
    // continue — the test may still succeed if the realm is clean.
  }

  await signIn(page);
  await page.goto(`${encodeURIComponent(seed.realmName)}/tenants`);
  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.locator('[data-cy=openResourceButton]').first()
  ).toBeVisible({ timeout: 15_000 });

  // Search by tenant name. The tenants page _filterData uses indexOf on
  // name, so "E2E-LeasedTenant" substring-matches a leftover
  // "E2E-LeasedTenant-B" from a panicked spec 19 run (CLAUDE.md "Test seed
  // leakage cascade"). Assert via the exact-name `tenantCard` selector
  // (`hasText: /^E2E-LeasedTenant$/`) so the count is deterministic
  // regardless of leakage. Same recipe as 25.4 / 28.36 / 29.39.
  const escaped = seed.tenantName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const exactCard = page
    .locator('[data-cy=openResourceButton]')
    .filter({ hasText: new RegExp(`^${escaped}$`) });
  await page.locator('[data-cy=globalSearchField]').fill(seed.tenantName);
  await expect(exactCard).toHaveCount(1, { timeout: 15_000 });

  // Apply "Lease running" filter → tenant must still appear (not terminated).
  await clickFilterChip(page, /Lease running|Σύμβαση σε ισχύ/i);
  await expect(exactCard).toHaveCount(1, { timeout: 10_000 });

  // Terminate the tenant via API (sets terminationDate). A partial PATCH
  // with only `{ terminationDate }` trips occupantmanager.ts update()'s
  // missing-name 422 (line 1083 → 1106). Mirror 25.3 / 25.7 recipe: GET
  // tenant, drop derived/computed fields, overlay terminationDate, PATCH
  // the full body. KEEP beginDate/endDate this time — the leased tenant's
  // dates are valid (6 months past/future) so round-tripping doesn't trip
  // the "End date must be after begin date" guard the way it does for
  // ensureSeedTenant (which has no lease window).
  const apiCtx2 = await request.newContext();
  const auth = {
    Authorization: `Bearer ${seed.token}`,
    organizationid: seed.realmId,
    'Content-Type': 'application/json'
  };
  const getResp = await apiCtx2.get(
    `${GATEWAY}/api/v2/tenants/${seed.tenantId}`,
    { headers: auth }
  );
  expect(getResp.status(), 'tenant get').toBe(200);
  const fullTenant = (await getResp.json()) as Record<string, unknown>;
  const cleanTenant: Record<string, unknown> = { ...fullTenant };
  for (const k of [
    'terminationDate',
    'lease',
    'office',
    'parking',
    'street1',
    'street2',
    'zipCode',
    'city',
    'country',
    'rental',
    'expenses',
    'total',
    'contactEmails',
    'hasContactEmails',
    'status',
    'terminated'
  ]) {
    delete cleanTenant[k];
  }
  // Termination date must be STRICTLY before today on the SERVER's UTC
  // calendar: toOccupantData uses `endMoment.isBefore(currentDate, 'day')`
  // (frontdata.ts:440) where both moments are moment.utc(). A naive
  // "yesterday" computed from local time (e.g. Athens UTC+3) lands on the
  // same UTC calendar day as the server when the test runs late evening
  // local. Use 48h ago to clear the boundary in both the server-UTC and
  // the local timezone.
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const termDate = `${String(twoDaysAgo.getDate()).padStart(2, '0')}/${String(
    twoDaysAgo.getMonth() + 1
  ).padStart(2, '0')}/${twoDaysAgo.getFullYear()}`;
  const termResp = await apiCtx2.patch(
    `${GATEWAY}/api/v2/tenants/${seed.tenantId}`,
    {
      headers: auth,
      data: { ...cleanTenant, terminationDate: termDate }
    }
  );
  const termBody = await termResp.text().catch(() => '');
  expect(
    termResp.status() >= 200 && termResp.status() < 300,
    `terminate tenant status=${termResp.status()} body=${termBody}`
  ).toBe(true);

  // Trigger refetch. `dispatchEvent(new Event('focus'))` is unreliable
  // headless (CLAUDE.md notes; spec 28.35 switched to reload for the same
  // reason). Reload preserves both router.query.search and
  // router.query.statuses (SearchFilterBar.js), so search input AND
  // "Lease running" chip remain active after remount.
  await page.reload();
  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toBeVisible({ timeout: 20_000 });

  // The "Lease running" filter excludes terminated tenants → exact-name
  // row gone. The search input still holds the name (from URL).
  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toHaveValue(seed.tenantName, { timeout: 15_000 });
  await expect(exactCard).toHaveCount(0, { timeout: 15_000 });

  // Toggle "Lease running" off (so we can find the terminated tenant) and
  // assert the search alone now matches them. Click the chip again.
  await clickFilterChip(page, /Lease running|Σύμβαση σε ισχύ/i);
  await expect(exactCard).toHaveCount(1, { timeout: 15_000 });

  // Cleanup: $unset terminationDate directly via mongo. PATCH `null`/`''`
  // both go through `_stringToDate` which returns `undefined`; Mongoose
  // `$set: { terminationDate: undefined }` is a no-op (the field stays).
  // CLAUDE.md "Test seed leakage cascade" — only `$unset` clears it.
  // mongoExec returns null when the portainer-token is unavailable (e.g.
  // CI dry-run), so this is a no-op outside the NAS environment.
  try {
    mongoExec(
      `db.occupants.updateOne({_id: ObjectId('${seed.tenantId}')}, {\\$unset: {terminationDate: ''}});`
    );
  } catch (e) {
    console.warn(
      `[S29.40] cleanup mongoExec failed: ${(e as Error).message}; terminationDate may persist — re-run with portainer-token to recover`
    );
  }
  await apiCtx2.dispose();
});
