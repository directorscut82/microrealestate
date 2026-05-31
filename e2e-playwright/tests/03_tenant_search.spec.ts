import { test, expect, request } from '@playwright/test';
import { ensureSeedTenant } from './lib/api';

/**
 * Wave-24: tenant search must scan contacts[].phone1 (not just legacy
 * `phone`). The form writes phone1/phone2 and there are tenants in the wild
 * with only the new fields set; pre-fix, those tenants were unreachable via
 * search.
 *
 * Discipline: seed a tenant with a randomized phone1, navigate to tenants
 * index, type a substring of the phone into the search box, assert the
 * tenant row is visible (round-trip read of UI state). No assertion that
 * other tenants are filtered out — that's not the regression under test.
 */

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD.');
  }
});

test('tenant search by partial phone1 matches the tenant', async ({ page }) => {
  const apiCtx = await request.newContext();
  const { realmName, tenantName, tenantPhone1 } = await ensureSeedTenant(apiCtx);
  await apiCtx.dispose();

  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/(firstaccess|dashboard)/);

  await page.goto(`${encodeURIComponent(realmName)}/tenants`);

  // Tenants list paginates and the seed tenant may be on page 2 with
  // many test runs accumulated. The point of the test is the SEARCH
  // path (search by phone1 substring should find the tenant), so go
  // straight there instead of relying on the full list rendering the
  // tenant on first paint.
  const phoneSubstring = tenantPhone1.slice(2, 8);
  const searchInput = page
    .locator('input[placeholder*="Search" i], input[type=search]')
    .first();
  await expect(searchInput).toBeVisible({ timeout: 15_000 });
  await searchInput.fill(phoneSubstring);

  // Pre-wave-24, search by phone1 substring would not find the tenant.
  // Now it must.
  const tenantCard = page.getByText(tenantName, { exact: true });
  await expect(
    tenantCard,
    `tenant ${tenantName} (phone1=${tenantPhone1}) must appear when searching for "${phoneSubstring}"`
  ).toBeVisible({ timeout: 10_000 });
});
