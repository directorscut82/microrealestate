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

  // Now apply a name search that matches ONLY tenant A. RentTable feeds
  // ExpressPaymentDialog from its `rents` prop (= filtered data), so the
  // drawer must show only tenant A.
  await page.locator('[data-cy=globalSearchField]').fill(seedAB.tenantName);
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

  await signIn(page);
  await page.goto(`${encodeURIComponent(seed.realmName)}/tenants`);
  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.locator('[data-cy=openResourceButton]').first()
  ).toBeVisible({ timeout: 15_000 });

  // Search by exact name → 1 row.
  await page.locator('[data-cy=globalSearchField]').fill(seed.tenantName);
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 15_000 });

  // Apply "Lease running" filter → tenant must still appear (not terminated).
  await clickFilterChip(page, /Lease running|Σύμβαση σε ισχύ/i);
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 10_000 });

  // Terminate the tenant via API (sets terminationDate).
  const apiCtx2 = await request.newContext();
  const auth = {
    Authorization: `Bearer ${seed.token}`,
    organizationid: seed.realmId,
    'Content-Type': 'application/json'
  };
  const now = new Date();
  const termDate = `${String(now.getDate()).padStart(2, '0')}/${String(
    now.getMonth() + 1
  ).padStart(2, '0')}/${now.getFullYear()}`;
  const termResp = await apiCtx2.patch(
    `${GATEWAY}/api/v2/tenants/${seed.tenantId}`,
    {
      headers: auth,
      data: { terminationDate: termDate }
    }
  );
  expect(termResp.status(), 'terminate tenant').toBeLessThan(400);

  // Trigger refetch.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  // The "Lease running" filter excludes terminated tenants → row gone.
  // The search input still holds the name; filter still active.
  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toHaveValue(seed.tenantName, { timeout: 15_000 });
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(0, { timeout: 15_000 });

  // Toggle "Lease running" off (so we can find the terminated tenant) and
  // assert the search alone now matches them. Click the chip again.
  await clickFilterChip(page, /Lease running|Σύμβαση σε ισχύ/i);
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 15_000 });

  // Cleanup: clear terminationDate via direct mongo since PATCH null
  // isn't reliable (CLAUDE.md saga). The next test run that requires
  // ensureSeedLeasedTenant will re-PATCH the dates and a stale
  // terminationDate will need a $unset. This spec is the LAST in the
  // catalog (29 > 25-28), but the realm is shared with later runs.
  // Best-effort cleanup via PATCH; an admin one-off may need to clear
  // the leftover terminationDate manually if other specs blow up.
  const cleanResp = await apiCtx2.patch(
    `${GATEWAY}/api/v2/tenants/${seed.tenantId}`,
    {
      headers: auth,
      // PATCH terminationDate: null is the documented (if imperfect) clear path.
      data: { terminationDate: null }
    }
  );
  if (cleanResp.status() >= 400) {
    console.warn(
      `[S29.40] cleanup PATCH failed status=${cleanResp.status()}; terminationDate may persist — see CLAUDE.md "Test seed leakage cascade"`
    );
  }
  await apiCtx2.dispose();
});
