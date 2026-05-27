import { test, expect, request } from '@playwright/test';
import { ensureSeed } from './lib/api';

/**
 * Reproduces wave-24 bug 1: editing an existing recurring expense via the UI
 * should send a PATCH that the API accepts. Pre-fix, react-hook-form did not
 * carry startTerm as a registered field, so the PATCH body lacked it and the
 * wave-21 server guard rejected with 422 "startTerm is required for recurring
 * expenses". The fix preserves expense.startTerm/endTerm into the payload.
 *
 * This spec demonstrates that the discipline rules — status-code assertion
 * plus round-trip read-back — would have caught the bug before deploy.
 */

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error(
      'Missing TEST_EMAIL/TEST_PASSWORD. Expected .secrets/cypress-test-account.'
    );
  }
});

test('editing a recurring expense PATCHes with 200 and persists the new amount', async ({
  page
}) => {
  // ----- arrange: API seed (idempotent across runs) -----
  const apiCtx = await request.newContext();
  const { realmName, buildingId } = await ensureSeed(apiCtx);
  await apiCtx.dispose();

  // ----- arrange: sign in via UI -----
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/(firstaccess|dashboard)/);

  // Land on the building's expenses tab directly. The [organization] URL
  // segment is the realm NAME (not the _id) — see e.g. BuildingListItem.js.
  await page.goto(`${encodeURIComponent(realmName)}/buildings/${buildingId}`);
  await page.locator('[data-cy=expensesTab]').click();
  await expect(page.locator('td', { hasText: 'E2E-Expense' })).toBeVisible({ timeout: 15_000 });

  // ----- act: edit expense → change amount → submit -----
  const newAmount = String(Math.floor(100 + Math.random() * 800)); // randomized so we always observe a change

  const expenseRow = page.locator('tr', { has: page.locator('td', { hasText: 'E2E-Expense' }) });
  // pencil icon == first button in the row (matches existing UI conventions)
  await expenseRow.locator('button').first().click();
  await expect(page.locator('[role=dialog]')).toBeVisible();

  await page.locator('input[name=amount]').fill(newAmount);

  const patchPromise = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/v2/buildings/${buildingId}/expenses/`) &&
      r.request().method() === 'PATCH'
  );
  await page.locator('[role=dialog]').getByRole('button', { name: /update|αποθή|save/i }).click();
  const patchResp = await patchPromise;

  // ----- assert: status code is 200 (NOT 422) -----
  expect(
    patchResp.status(),
    `PATCH to /buildings/.../expenses/... must return 200. ` +
      `If you see 422, the wave-24 fix in ExpenseList.js onSubmit (preserving expense.startTerm) ` +
      `is missing or regressed.`
  ).toBe(200);

  // ----- assert: round-trip read-back — re-open dialog, confirm new amount persists -----
  await expect(page.locator('[role=dialog]')).toBeHidden({ timeout: 10_000 });
  await expenseRow.locator('button').first().click();
  await expect(page.locator('[role=dialog]')).toBeVisible();
  await expect(page.locator('input[name=amount]')).toHaveValue(newAmount);
});
