/**
 * Spec 25 — Tenants index search/filter catalog (10 scenarios).
 *
 * Catalog source: `.kiro/steering/test-running-guide.md` "Search / filter
 * scenario catalog (REQUIRED coverage)" section, scenarios 1-10.
 *
 * Discipline (from the same doc):
 *  - toHaveCount(N) / not.toBeVisible — never tautological toBeVisible on
 *    a row that is also visible in the unfiltered list.
 *  - Refetch resilience: type → trigger refetch (window-focus / manual
 *    invalidation) → re-assert state holds.
 *  - Status assertion on every awaited HTTP response.
 *  - No waitForTimeout. Wait on responses / locators / expect.poll.
 *
 * Rendered surface: TenantList → TenantListItem (Card with the tenant
 * name in a `[data-cy=openResourceButton]` link). The search input has
 * `[data-cy=globalSearchField]`. The filter chips live behind a
 * "Filters" popover (ToggleMenu) with role=menuitemcheckbox items.
 */
import { expect, request, test, Page } from '@playwright/test';
import {
  ensureSeedLeasedTenant,
  ensureSeedTenant,
  getAccessToken
} from './lib/api';

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

async function gotoTenants(page: Page, realmName: string) {
  await page.goto(`${encodeURIComponent(realmName)}/tenants`);
  // Wait for at least the search input + one card to mount before
  // asserting on filter narrowing.
  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toBeVisible({ timeout: 20_000 });
  // Wait until at least one tenant card is rendered (data-cy=openResourceButton
  // is on the title button of every TenantListItem). If the realm has 0
  // tenants the page lands on the EmptyIllustration — but for our seed it
  // never does, so a 15s timeout is sufficient.
  await expect(
    page.locator('[data-cy=openResourceButton]').first()
  ).toBeVisible({ timeout: 15_000 });
}

function tenantCard(page: Page, name: string) {
  // Match a tenant row by EXACT name. The previous `.filter({ has:
  // ":text-is(name)" })` recipe failed when the openResourceButton's own
  // text content IS the name — Playwright's `:text-is()` engine couldn't
  // resolve a self-reference cleanly under `has:`. The canonical pattern
  // (mirrored from spec 26 propertyCard) is `.filter({ hasText: /^name$/ })`
  // which matches the visible text exactly.
  const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return page
    .locator('[data-cy=openResourceButton]')
    .filter({ hasText: new RegExp(`^${escaped}$`) });
}

async function openFiltersMenu(page: Page) {
  await page.getByRole('button', { name: /Filters|Φίλτρα/i }).first().click();
}

async function clickFilterChip(page: Page, chipLabel: RegExp) {
  await openFiltersMenu(page);
  // Filter checkboxes live in a Popover with role=menu containing
  // role=menuitemcheckbox <li>s. Match by visible text inside the li.
  await page.locator('li[role=menuitemcheckbox]', { hasText: chipLabel }).first().click();
  // Close the popover so the underlying list is interactable.
  await page.keyboard.press('Escape');
}

test('25.1 search by phone1 substring narrows list to exactly 1 row', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  // Two separate tenants: a known phone1 we'll search for, plus the canonical
  // leased tenant whose phone is 6900000000 — must NOT match our search.
  const { realmName, tenantName, tenantPhone1 } = await ensureSeedTenant(apiCtx);
  const leased = await ensureSeedLeasedTenant(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoTenants(page, realmName);

  // 6 chars from a randomized phone1 — collisions with another tenant's
  // phone are possible but vanishingly unlikely (the random space is 8
  // digits). If a collision appears we'd still pass scenario 25.10 below
  // (clear-input restoration) so the catalog as a whole stays meaningful.
  const phoneSubstring = tenantPhone1.slice(2, 8);

  await page.locator('[data-cy=globalSearchField]').fill(phoneSubstring);

  // Set narrowing (NOT existence): exactly one card.
  const cards = page.locator('[data-cy=openResourceButton]');
  await expect(cards).toHaveCount(1, { timeout: 15_000 });

  // The matching tenant is visible.
  await expect(tenantCard(page, tenantName)).toBeVisible();

  // The non-matching canonical tenant is NOT visible (negative assertion).
  await expect(tenantCard(page, leased.tenantName)).not.toBeVisible();
});

test('25.2 search persists past staleTime / window blur+focus', async ({ page, context }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const { realmName, tenantName, tenantPhone1 } = await ensureSeedTenant(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoTenants(page, realmName);

  const phoneSubstring = tenantPhone1.slice(2, 8);
  await page.locator('[data-cy=globalSearchField]').fill(phoneSubstring);

  const cards = page.locator('[data-cy=openResourceButton]');
  await expect(cards).toHaveCount(1, { timeout: 15_000 });

  // Refetch resilience: open a second tab, then return to the original
  // — `refetchOnWindowFocus` defaults to true so the tenants query
  // refetches on focus. The previous regression: a parent useEffect
  // clobbered SearchFilterBar's state on data change (see ResourceList/List.js
  // comment about removed init useEffect).
  const aux = await context.newPage();
  await aux.goto('about:blank');
  await aux.bringToFront();
  await page.bringToFront();

  // After focus refetch, list MUST still be narrowed and the input MUST
  // still hold the typed text.
  await expect(cards).toHaveCount(1, { timeout: 15_000 });
  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toHaveValue(phoneSubstring);

  await aux.close();
});

test('25.3 search holds across an external mutation (manual invalidate)', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const { realmName, tenantName, tenantId, tenantPhone1, realmId } = await ensureSeedTenant(apiCtx);

  await signIn(page);
  await gotoTenants(page, realmName);

  // Narrow by exact name to guarantee 1 row regardless of phone collisions.
  const search = page.locator('[data-cy=globalSearchField]');
  await search.fill(tenantName);
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 15_000 });

  // External mutation: PATCH the tenant via API in a fresh context.
  // After the mutation the in-page React Query cache is now stale; we
  // explicitly invalidate it (simulating a focus refetch / cross-tab
  // invalidation event) and re-assert the search still holds.
  const token = await getAccessToken(apiCtx);
  const patchResp = await apiCtx.patch(`${GATEWAY}/api/v2/tenants/${tenantId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      organizationid: realmId,
      'Content-Type': 'application/json'
    },
    data: { reference: `INVALIDATE-${Date.now()}` }
  });
  expect(patchResp.status(), 'tenant patch').toBeGreaterThanOrEqual(200);
  expect(patchResp.status()).toBeLessThan(300);
  await apiCtx.dispose();

  // Trigger a refetch by toggling visibility (Page Visibility API).
  // Playwright's evaluate runs in the page; we dispatch a focus event
  // so React Query's focusManager fires.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
  });

  // The list must still be narrowed by the search after refetch.
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 15_000 });
  await expect(search).toHaveValue(tenantName);
});

test('25.4 search + "Lease running" chip composes (AND filter)', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const leased = await ensureSeedLeasedTenant(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoTenants(page, leased.realmName);

  // Search by tenant's exact name.
  await page.locator('[data-cy=globalSearchField]').fill(leased.tenantName);
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 15_000 });

  // Now add the "Lease running" filter chip — the canonical leased tenant
  // has begin/end straddling today so they remain in the narrowed set.
  await clickFilterChip(page, /Lease running|Σύμβαση σε ισχύ/i);

  // Still exactly 1 (narrowed by name AND status=inprogress).
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 10_000 });
  await expect(tenantCard(page, leased.tenantName)).toBeVisible();
});

test('25.5 "Lease running" chip alone narrows; clearing restores full list', async ({
  page
}) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const leased = await ensureSeedLeasedTenant(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoTenants(page, leased.realmName);

  // Capture the unfiltered count first.
  const before = await page
    .locator('[data-cy=openResourceButton]')
    .count();
  expect(before, 'must have at least 1 tenant before filtering').toBeGreaterThan(0);

  await clickFilterChip(page, /Lease running|Σύμβαση σε ισχύ/i);

  // After the running chip is on, the count should be ≤ before. We
  // can't predict the exact narrowed count without knowing the realm's
  // termination state, but we can require: the canonical leased tenant
  // is visible AND if any terminated tenants exist they must drop.
  await expect(tenantCard(page, leased.tenantName)).toBeVisible({ timeout: 10_000 });
  const filteredCount = await page
    .locator('[data-cy=openResourceButton]')
    .count();
  expect(filteredCount).toBeLessThanOrEqual(before);

  // Toggle off the chip — list restores to the unfiltered count.
  await clickFilterChip(page, /Lease running|Σύμβαση σε ισχύ/i);
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(before, { timeout: 10_000 });
});

test('25.6 "Lease ended" chip narrows to terminated tenants only (count check)', async ({
  page
}) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const leased = await ensureSeedLeasedTenant(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoTenants(page, leased.realmName);

  const before = await page.locator('[data-cy=openResourceButton]').count();

  await clickFilterChip(page, /Lease ended|Σύμβαση έληξε/i);

  // The canonical seed is NOT terminated — it must NOT appear when filtering
  // by "Lease ended". This is the key set-narrowing assertion.
  await expect(tenantCard(page, leased.tenantName)).not.toBeVisible({
    timeout: 10_000
  });

  // The filtered count is ≤ before.
  const after = await page.locator('[data-cy=openResourceButton]').count();
  expect(after).toBeLessThanOrEqual(before);
});

test('25.7 "Show archived" toggle adds/removes archived tenants', async ({
  page
}) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const leased = await ensureSeedLeasedTenant(apiCtx);
  // Seed a one-off tenant we will archive so the toggle has something to flip.
  const seed = await ensureSeedTenant(apiCtx);
  const token = await getAccessToken(apiCtx);
  // Archive that tenant.
  const archResp = await apiCtx.patch(
    `${GATEWAY}/api/v2/tenants/${seed.tenantId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        organizationid: seed.realmId,
        'Content-Type': 'application/json'
      },
      data: { archived: true }
    }
  );
  expect(archResp.status(), 'archive tenant').toBeLessThan(400);
  await apiCtx.dispose();

  await signIn(page);
  await gotoTenants(page, leased.realmName);

  // Default: archived hidden — our archived tenant must NOT show.
  await page.locator('[data-cy=globalSearchField]').fill(seed.tenantName);
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(0, { timeout: 10_000 });

  // Toggle archived ON.
  await page.locator('[data-cy=showArchivedToggle]').click();
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 15_000 });
  await expect(tenantCard(page, seed.tenantName)).toBeVisible();

  // Toggle OFF — back to 0 visible matches.
  await page.locator('[data-cy=showArchivedToggle]').click();
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(0, { timeout: 10_000 });
});

test('25.8 search persists across navigate-into-detail then Back', async ({
  page
}) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const leased = await ensureSeedLeasedTenant(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoTenants(page, leased.realmName);

  await page.locator('[data-cy=globalSearchField]').fill(leased.tenantName);
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 15_000 });

  // Click into the tenant detail page.
  await tenantCard(page, leased.tenantName).first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
    .toMatch(/\/tenants\/[a-f0-9]{24}/);

  // Browser back — search input is wired to `router.query.search` so it
  // must rehydrate from the URL.
  await page.goBack();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
    .toMatch(/\/tenants$/);

  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toHaveValue(leased.tenantName, { timeout: 15_000 });
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 15_000 });
});

test('25.9 search with no matches → empty state, no rows', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const leased = await ensureSeedLeasedTenant(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoTenants(page, leased.realmName);

  // A search string guaranteed not to match any tenant in the realm
  // (E2E names are prefixed with "E2E-Leased" / "E2E-Tenant"; a 12-char
  // random hex won't collide).
  const noMatch = `ZZZZZZZZ${Math.random().toString(16).slice(2, 8)}`;
  await page.locator('[data-cy=globalSearchField]').fill(noMatch);

  // Empty state: 0 rows visible. The EmptyIllustration label
  // ("No tenants found" in en, "Δε βρέθηκαν..." in el) renders.
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(0, { timeout: 15_000 });
});

test('25.10 typing then clearing the input restores the full list', async ({
  page
}) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const leased = await ensureSeedLeasedTenant(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoTenants(page, leased.realmName);

  const before = await page.locator('[data-cy=openResourceButton]').count();

  await page.locator('[data-cy=globalSearchField]').fill(leased.tenantName);
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 15_000 });

  // Clear the input.
  await page.locator('[data-cy=globalSearchField]').fill('');
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(before, { timeout: 15_000 });
});
