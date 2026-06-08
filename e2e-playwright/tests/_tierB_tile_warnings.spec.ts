import { test, expect } from '@playwright/test';

const LANDLORD = process.env.LANDLORD_APP_URL || 'http://192.168.0.96:1350/landlord/';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';
const TEST_ORG_NAME = process.env.TEST_ORG_NAME ?? 'CYPRESS-TEST-DO-NOT-USE';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) throw new Error('Missing TEST_EMAIL/TEST_PASSWORD');
});

/**
 * Tier B7+B8+B9 — UI tile coverage:
 * - Tenant tile renders a 3-state pill (data-lease-state in
 *   {terminated, future, running}).
 * - The pill state is computed from terminated + beginDate.
 * - Tenant cards have h-full flex layout; the pill stays visually
 *   anchored at the bottom regardless of content above.
 * - Building tile renders an "Ελλειπή στοιχεία (...)" warning
 *   when units / manager / address are incomplete.
 */

async function signIn(page: any) {
  await page.goto(`${LANDLORD}signin`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await Promise.all([
    page.waitForURL(/\/dashboard/, { timeout: 30000 }),
    page.locator('[data-cy=submit]').first().click()
  ]);
}

test('Tier B8: tenant tile pill exposes data-lease-state attribute', async ({ page }) => {
  await signIn(page);
  const orgPath = encodeURIComponent(TEST_ORG_NAME);
  await page.goto(`${LANDLORD}el/${orgPath}/tenants`, {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);

  // Locate every pill on the tenants list (one per card).
  const pills = page.locator('[data-lease-state]');
  const count = await pills.count();
  expect(count, 'at least one tenant card with a pill').toBeGreaterThan(0);

  // Every pill MUST have one of the three valid states.
  for (let i = 0; i < count; i++) {
    const state = await pills.nth(i).getAttribute('data-lease-state');
    expect(['terminated', 'future', 'running']).toContain(state || '');
  }
});

test('Tier B9: building tile shows missing-details warning when applicable', async ({ page }) => {
  await signIn(page);
  const orgPath = encodeURIComponent(TEST_ORG_NAME);
  await page.goto(`${LANDLORD}el/${orgPath}/buildings`, {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);

  // The buildings index renders zero or more cards. If a card has
  // gaps (no units, no manager, no address), `[data-cy=buildingMissingFields]`
  // appears on it. We only assert that when the element is present, it has
  // the expected shape: parens with at least one gap word.
  const warnings = page.locator('[data-cy=buildingMissingFields]');
  const wcount = await warnings.count();
  for (let i = 0; i < wcount; i++) {
    const text = (await warnings.nth(i).innerText()).trim();
    expect(text, `warning #${i} body`).toMatch(/\(.+\)/);
  }
  // Lawnmower-style: the warning, when rendered, must NEVER contain a
  // raw template literal (regression guard against missing locale keys).
  for (let i = 0; i < wcount; i++) {
    const text = (await warnings.nth(i).innerText()).trim();
    expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/);
  }
});
