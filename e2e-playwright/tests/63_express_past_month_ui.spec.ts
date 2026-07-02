/**
 * BROWSER regression (reported 2026-07, fixed in 595b4499): an EXPRESS katavolh
 * on a PAST month must SUCCEED in the real UI, not toast/422.
 *
 * The root cause was the round-3t "date is after this rent month + 7d" guard:
 * express stamps the payment date = TODAY, so any term >~1 month old was
 * rejected. The unit spec (expressPastMonthPayment.test.js) proves the server
 * contract; THIS spec drives the actual landlord UI in Greek (/el), navigates
 * to a 3-month-old rents page, opens the express drawer, settles the tenant,
 * and asserts the payment lands (no error toast, tenant leaves the owed list /
 * the API confirms a recorded payment). Screenshots the Greek surface so the
 * flow is eyeballed, per ui-review-do-not-skip.md.
 */
import { test, expect, request as pwRequest } from '@playwright/test';
import { ensureSeedLeasedTenant } from './lib/api';

const TEST_EMAIL = process.env.TEST_EMAIL || '';
const TEST_PASSWORD = process.env.TEST_PASSWORD || '';
const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

let seed: any = null;
let pastYm = '';
let pastTerm = '';

test.beforeAll(async () => {
  const ctx = await pwRequest.newContext();
  // 6-months-ago begin → plenty of old unpaid months. Target 3 months back:
  // safely OUTSIDE the term-end+7d window the old guard rejected.
  seed = await ensureSeedLeasedTenant(ctx);
  const now = new Date();
  const past = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  pastYm = `${past.getFullYear()}.${String(past.getMonth() + 1).padStart(2, '0')}`;
  pastTerm = `${past.getFullYear()}${String(past.getMonth() + 1).padStart(2, '0')}0100`;
  await ctx.dispose();
});

test('express-settle a 3-month-old term through the Greek UI [#595b4499]', async ({
  page
}) => {
  // --- sign in (Greek locale) ---
  await page.goto('el/signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
    .toMatch(/\/(firstaccess|dashboard)/);

  // --- navigate to the PAST month's rents page, in Greek ---
  await page.goto(`el/${encodeURIComponent(seed.realmName)}/rents/${pastYm}`);
  const nameSpan = page
    .locator(`span.text-lg.font-medium:text-is("${seed.tenantName}")`)
    .first();
  await expect(nameSpan, 'seeded tenant visible on the past-month page').toBeVisible({
    timeout: 20_000
  });

  await page.screenshot({ path: '_express_past/01_past_month_page.png', fullPage: true });

  // --- open the express drawer ---
  const expressBtn = page.locator('[data-cy="expressPaymentBtn"]');
  await expect(expressBtn, 'express button present on past-month page').toBeVisible({
    timeout: 10_000
  });
  await expressBtn.click();
  const drawer = page.locator('[role=dialog][vaul-drawer]');
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  await expect(drawer, 'drawer lists the seeded tenant').toContainText(seed.tenantName, {
    timeout: 5_000
  });
  await page.screenshot({ path: '_express_past/02_express_drawer.png', fullPage: true });

  // --- tick the seeded tenant's master checkbox (selects its owed options) ---
  // Rows start UNSELECTED; the submit button («Εκτέλεση») is disabled until at
  // least one tenant/option is ticked (totals.count === 0 guard).
  const tenantLabel = drawer
    .locator('label', { hasText: seed.tenantName })
    .first();
  await tenantLabel.locator('button[role="checkbox"], [role="checkbox"]').first().click();

  // --- submit; capture the express POST outcome ---
  const [expressResp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/rents/express') && r.request().method() === 'POST',
      { timeout: 20_000 }
    ),
    (async () => {
      // Submit button inside the drawer: t('Record') === «Εκτέλεση» in el
      // (t('Saving')/«Αποθήκευση» while pending). Match either state, exclude
      // «Ακύρωση» (Cancel).
      const submit = drawer
        .locator('button')
        .filter({ hasText: /Εκτέλεση|Αποθήκευση|Record|Saving/i })
        .last();
      await expect(submit, 'submit enabled once a tenant is ticked').toBeEnabled({
        timeout: 5_000
      });
      await submit.click();
    })()
  ]);

  expect(expressResp.status(), 'express POST HTTP status').toBe(200);
  const body = await expressResp.json();
  const results = body?.results || [];
  const anyFailed = results.some((r: any) => r.failed);
  const anySettled = results.some((r: any) => !r.failed && !r.skipped && Number(r.amount) > 0);
  expect(anyFailed, `no express row failed (results=${JSON.stringify(results)})`).toBeFalsy();
  expect(anySettled, 'at least one row settled a positive amount').toBeTruthy();

  // No error toast surfaced (the old guard raised a sonner error toast).
  const errorToast = page.locator('[data-sonner-toast][data-type="error"]');
  await expect(errorToast).toHaveCount(0);

  await page.screenshot({ path: '_express_past/03_after_settle.png', fullPage: true });

  // --- confirm the payment actually persisted on the past term via API ---
  const ctx = await pwRequest.newContext();
  const rentsResp = await ctx.get(`${GATEWAY}/api/v2/rents/tenant/${seed.tenantId}`, {
    headers: {
      Authorization: `Bearer ${seed.token}`,
      organizationid: seed.realmId
    }
  });
  const rents = (await rentsResp.json()).rents || [];
  const target = rents.find((r: any) => String(r.term) === pastTerm);
  expect(Number(target?.payment), `past term ${pastTerm} now has a recorded payment`).toBeGreaterThan(0);
  await ctx.dispose();
});
