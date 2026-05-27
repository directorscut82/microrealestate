import { test, expect, request } from '@playwright/test';
import { ensureSeedProperty } from './lib/api';

/**
 * Wave-24: PropertyForm gained energyCertIssueDate + energyCertInspectorNumber
 * inputs. They must persist on save and re-display when the user re-opens
 * the property edit page.
 */

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD.');
  }
});

test('energy cert issue date + inspector number persist on property edit', async ({ page }) => {
  const apiCtx = await request.newContext();
  const { realmName, propertyId } = await ensureSeedProperty(apiCtx);
  await apiCtx.dispose();

  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/(firstaccess|dashboard)/);

  await page.goto(`${encodeURIComponent(realmName)}/properties/${propertyId}`);

  // Some past date, randomized so a stale value can't satisfy the assertion.
  const today = new Date();
  today.setDate(today.getDate() - Math.floor(Math.random() * 365));
  const issueDate = today.toISOString().substring(0, 10); // YYYY-MM-DD
  const inspectorNumber = `INSP-${Date.now()}`;

  await page
    .locator('#energyCertIssueDate')
    .fill(issueDate);
  await page.locator('#energyCertInspectorNumber').fill(inspectorNumber);

  const patchPromise = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/v2/properties/${propertyId}`) &&
      r.request().method() === 'PATCH'
  );
  const saveBtn = page.getByRole('button', { name: /save|update|αποθή/i }).first();
  await saveBtn.scrollIntoViewIfNeeded();
  await saveBtn.click();
  const patchResp = await patchPromise;
  expect(patchResp.status(), 'property PATCH must return 200').toBe(200);

  // Round-trip: navigate away and back, then re-read both inputs.
  await page.goto(`${encodeURIComponent(realmName)}/properties`);
  await page.goto(`${encodeURIComponent(realmName)}/properties/${propertyId}`);

  await expect(page.locator('#energyCertIssueDate')).toHaveValue(issueDate);
  await expect(page.locator('#energyCertInspectorNumber')).toHaveValue(inspectorNumber);
});
