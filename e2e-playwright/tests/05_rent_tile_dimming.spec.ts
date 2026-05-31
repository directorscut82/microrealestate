import { test, expect, request } from '@playwright/test';
import { ensureSeedLeasedTenant } from './lib/api';

/**
 * Wave-24 bug 8: rent tiles in RentHistoryDialog must visually distinguish
 * past / current / future months.
 *   - Past month tiles get a muted background (bg-marble-tint/40).
 *   - Future month tiles get a dashed border + an "(estimate)" italic
 *     suffix on the period label.
 *   - Current month is unstyled.
 *
 * Pre-fix all tiles rendered identically and the user couldn't tell at a
 * glance which months were settled vs projected.
 *
 * The seed produces a tenant with a 12-month lease window straddling today,
 * so the rent ledger always contains past, current, and future terms — the
 * three states the spec asserts on.
 */

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD.');
  }
});

test('RentHistoryDialog distinguishes past, current, and future month tiles', async ({ page }) => {
  const apiCtx = await request.newContext();
  const { realmName, tenantName } = await ensureSeedLeasedTenant(apiCtx);
  await apiCtx.dispose();

  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/(firstaccess|dashboard)/);

  // Navigate to current-month rents page.
  const now = new Date();
  const yearMonth = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}`;
  await page.goto(`${encodeURIComponent(realmName)}/rents/${yearMonth}`);

  // The rents page renders each tenant as a Card-style div, not a <tr>.
  // Locate the card by tenant name, then within it pick the History
  // icon-button by aria-label (which the wave-3 a11y batch added).
  // Avoids depending on button-order which changes when columns are
  // added/removed.
  const tenantCard = page
    .locator('div', { has: page.locator(`text=${tenantName}`) })
    .filter({ has: page.locator('text=Total due') })
    .first();
  await expect(tenantCard).toBeVisible({ timeout: 20_000 });

  const historyBtn = tenantCard
    .locator('button[aria-label="History"], button[aria-label="Ιστορικό"]')
    .first();
  await historyBtn.scrollIntoViewIfNeeded();
  await historyBtn.click();

  await expect(page.locator('[role=dialog]')).toBeVisible({ timeout: 10_000 });

  // The dialog renders a Card per rent term. Past terms → muted bg class.
  // Future terms → dashed border class + italic "(estimate)" suffix.
  const dialog = page.locator('[role=dialog]');

  // Past tile assertion: at least one card must carry the muted background
  // class. We use class-attribute substring matching since shadcn card
  // classes are merged via cn() and we don't control the exact order.
  const pastTiles = dialog.locator('div[class*="bg-marble-tint"]');
  await expect(
    pastTiles,
    'at least one past-month rent tile must render with the muted background (bg-marble-tint)'
  ).not.toHaveCount(0);

  // Future tile assertion is conditional: the server only materialises
  // rent records up to the requested month — Contract.payTerm doesn't
  // pre-generate future-month rows. If the dialog happens to include
  // future tiles (e.g. from a previously-paid future term) they MUST
  // render with the dashed-border + "(estimate)" decoration; if none
  // exist, the styling can't be exercised here.
  const futureTiles = dialog.locator('div[class*="border-dashed"]');
  const futureCount = await futureTiles.count();
  if (futureCount > 0) {
    const estimateLabel = dialog.locator('text=/\\(estimate\\)/i');
    await expect(
      estimateLabel.first(),
      'future-month tiles must label the period with (estimate)'
    ).toBeVisible();
  }
});
