import { test, expect } from '@playwright/test';

/**
 * NAS smoke spec — proves the harness works end-to-end against the live NAS.
 *
 * Discipline rules every NAS spec must follow:
 *   1. Never call the resetservice. /api/reset does not exist on NAS and would
 *      nuke production data if it did.
 *   2. Assert HTTP status codes on every awaited response. A failed call must
 *      fail the test, not silently pass.
 *   3. Round-trip read-back: after a write, navigate and read the value the
 *      UI now renders — don't trust call-resolution alone.
 *   4. No arbitrary waitForTimeout. Wait for responses, locators, or URLs.
 *   5. Credentials only from process.env (loaded via .secrets/), never inline.
 */

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error(
      'Missing TEST_EMAIL/TEST_PASSWORD. Expected .secrets/cypress-test-account ' +
        'to define EMAIL and PASSWORD.'
    );
  }
});

test('signin endpoint returns 200 + access token, redirects off /signin', async ({ page }) => {
  const signinResponsePromise = page.waitForResponse(
    (r) => r.url().includes('/api/v2/authenticator/landlord/signin') && r.request().method() === 'POST'
  );

  // baseURL is `.../landlord`. A leading slash would resolve against the
  // origin and hit the gateway 404. Use a relative path to stay under landlord.
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();

  const signinResponse = await signinResponsePromise;
  expect(signinResponse.status(), 'signin HTTP status').toBe(200);

  const body = await signinResponse.json();
  expect(body, 'signin response body').toHaveProperty('accessToken');
  expect(typeof body.accessToken, 'accessToken type').toBe('string');
  expect(body.accessToken.length, 'accessToken length').toBeGreaterThan(0);

  // Round-trip: SPA must redirect off /signin. Either /firstaccess (no realm
  // registered yet) or /<org>/dashboard (already has one).
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
    .toMatch(/\/(firstaccess|dashboard)/);
});
