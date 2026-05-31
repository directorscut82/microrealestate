/**
 * Regression test for the stale-Payment-cell bug.
 *
 * Bug: PATCH /api/v2/rents/payment/<tenant>/<term> returns 200, drawer
 * closes, but the Payment cell on the tenant row keeps showing the OLD
 * value for ~500-1500ms while the background GET refetch is in flight.
 * Users assume the click failed, click Record again, create duplicate
 * payments in mongo.
 *
 * Fix (commit 7f108e0): PaymentTabs._handleSubmit now `await
 * queryClient.refetchQueries({queryKey: [QueryKeys.RENTS]})` BEFORE
 * onSubmit() closes the drawer. The cache holds fresh data the moment
 * the drawer is gone.
 *
 * This test asserts: at the instant the drawer's closing animation has
 * finished, the cell already shows the new value. Polling budget is
 * intentionally short (500ms total) — enough for one React render
 * cycle but nowhere near the full network round-trip the broken code
 * needed.
 */
import { expect, request, test } from '@playwright/test';
import { ensureSeedLeasedTenantWithPayment } from './lib/api';

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD');
  }
});

async function readCell(
  row: import('@playwright/test').Locator
): Promise<string> {
  const cell = row
    .locator('div')
    .filter({ hasText: /^(Payment|Καταβολή)$/ })
    .first()
    .locator('xpath=..');
  return (await cell.textContent()) || '';
}

test('Payment cell reflects new value the instant the drawer closes', async ({
  page
}) => {
  const apiCtx = await request.newContext();
  // Reset to 0€ so we can record exactly 100€ and assert the visible
  // diff. Using the seeded test tenant — never PRIFTI's real account.
  const seed = await ensureSeedLeasedTenantWithPayment(apiCtx, 0);
  await apiCtx.dispose();

  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
    .toMatch(/\/(firstaccess|dashboard)/);

  const now = new Date();
  const ym = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}`;
  await page.goto(`${encodeURIComponent(seed.realmName)}/rents/${ym}`);

  const nameSpan = page
    .locator('span.text-lg.font-medium', { hasText: seed.tenantName })
    .first();
  await expect(nameSpan).toBeVisible({ timeout: 20_000 });
  const tenantRow = nameSpan.locator(
    'xpath=ancestor::div[contains(@class, "flex") and .//*[contains(@class, "text-right")]][1]'
  );

  const before = await readCell(tenantRow);
  // Sanity: cell does NOT contain '100' before we record.
  expect(before).not.toMatch(/100[,.]/);

  const cashBtn = tenantRow
    .locator('button')
    .filter({ has: page.locator('svg.size-6') })
    .first();
  await cashBtn.click();
  await expect(page.locator('[role=dialog]')).toBeVisible({ timeout: 10_000 });

  await page.locator('[data-cy="addNewPayment"]').click();
  await page.locator('input[name="payments.0.amount"]').fill('100');

  await page
    .locator('[role=dialog] button')
    .filter({ hasText: /Record|Εκτέλεση/i })
    .first()
    .click();

  // Wait for the drawer to fully close.
  await expect(
    page.locator('[role=dialog][vaul-drawer]')
  ).not.toBeVisible({ timeout: 15_000 });

  // CRITICAL ASSERTION: at the instant the drawer is gone, the cell
  // already shows 100. The fix awaits the refetch before closing, so
  // this should resolve within one React render cycle. Anything > 500ms
  // means the bug is back.
  await expect
    .poll(() => readCell(tenantRow), { timeout: 500, intervals: [50, 100] })
    .toMatch(/100[,.]/);
});
