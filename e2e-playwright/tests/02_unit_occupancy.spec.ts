import { test, expect, request } from '@playwright/test';
import { ensureSeedWithUnit } from './lib/api';

/**
 * Wave-24 bug 9: editing a unit's occupancyType (vacant → owner_occupied →
 * etc.) must persist across reload. Pre-fix the Select wasn't wired into
 * react-hook-form so the value was lost on submit.
 *
 * Discipline: status assertion on PATCH + round-trip read-back of the Select
 * value after re-opening the dialog.
 */

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD.');
  }
});

test('changing unit occupancy to owner_occupied PATCHes 200 and persists', async ({ page }) => {
  const apiCtx = await request.newContext();
  const { realmName, buildingId, unitId } = await ensureSeedWithUnit(apiCtx);
  await apiCtx.dispose();

  // Sign in.
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/(firstaccess|dashboard)/);

  await page.goto(`${encodeURIComponent(realmName)}/buildings/${buildingId}`);
  await page.locator('[data-cy=unitsTab]').click();

  const unitRow = page.locator('tr', { has: page.locator('td', { hasText: 'E2E-Unit' }) });
  await expect(unitRow).toBeVisible({ timeout: 15_000 });
  await unitRow.locator('button').first().click(); // pencil

  await expect(page.locator('[role=dialog]')).toBeVisible();

  // Open the occupancy Select. shadcn/Radix combobox → click trigger then
  // the matching option.
  await page.locator('[id=occupancyType]').click();
  await page.getByRole('option', { name: /owner.occupied/i }).click();

  const patchPromise = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/v2/buildings/${buildingId}/units/${unitId}`) &&
      r.request().method() === 'PATCH'
  );
  // Form is taller than viewport in this dialog — scroll the button into
  // view before clicking. We do not weaken the click with force:true because
  // a force-clicked button can fire on an inert element and pass the test
  // even when the button is broken.
  const updateBtn = page
    .locator('[role=dialog]')
    .getByRole('button', { name: /update|αποθή|save/i });
  await updateBtn.scrollIntoViewIfNeeded();
  await updateBtn.click();
  const patchResp = await patchPromise;
  expect(patchResp.status(), 'unit PATCH must return 200').toBe(200);

  // Round-trip: dialog closes, re-open, occupancy Select must show the new
  // value. The trigger renders the SelectValue text content.
  await expect(page.locator('[role=dialog]')).toBeHidden({ timeout: 10_000 });
  await unitRow.locator('button').first().click();
  await expect(page.locator('[role=dialog]')).toBeVisible();
  await expect(page.locator('[id=occupancyType]')).toContainText(/owner.occupied/i);
});
