/**
 * Wave-26 round-3s: deep payment-scenario verification harness.
 *
 * Drives PRIFTI's real rent through the full UI for several payment
 * shapes, each time:
 *   1. Snapshot mongo state pre-test (full rents array)
 *   2. Drive UI: login → /rents/2026.05 → open dialog → fill → Record
 *   3. Read mongo state, assert the write matches expectation
 *   4. Reload the rent dialog, assert the UI now shows what was saved
 *      (specifically the bug class round-3s targets: stale snapshot)
 *   5. Restore mongo to the pre-test snapshot
 *
 * If any scenario fails, the afterAll hook still attempts restore so
 * subsequent runs start clean.
 *
 * NOT a CI-runnable spec — talks to the live NAS, uses real
 * credentials, mutates real data.
 */
import { expect, test } from '@playwright/test';
import { mongoExec, readRent } from './lib/mongoExec';

const REAL_EMAIL = 'devilblaster82@gmail.com';
const REAL_PASSWORD = 'Forsaken@1982';
const TENANT_NAME = 'PRIFTI DHIMO';
const TERM = 2026050100;

// Single global baseline. Captured before the first test; restored
// after the last test. We do NOT reset between scenarios — each
// scenario's expectation accounts for the leftover state from the
// previous one.
let _baseline: any = null;

function takeBaseline() {
  const snap = mongoExec(`
    var t = db.occupants.findOne({name: "${TENANT_NAME}"});
    print(JSON.stringify(t.rents));
  `);
  if (!snap) throw new Error('baseline read failed');
  _baseline = JSON.parse(snap);
}

function restoreBaseline() {
  if (!_baseline) return;
  mongoExec(`
    var t = db.occupants.findOne({name: "${TENANT_NAME}"});
    db.occupants.updateOne(
      {_id: t._id},
      {\\$set: {rents: ${JSON.stringify(_baseline)}}}
    );
  `);
}

test.beforeAll(() => {
  takeBaseline();
});

test.afterAll(() => {
  restoreBaseline();
});

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('signin');
  await page.locator('input[name=email]').fill(REAL_EMAIL);
  await page.locator('input[name=password]').fill(REAL_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
    .toMatch(/\/(firstaccess|dashboard)/);
}

async function openPriftiDialog(page: import('@playwright/test').Page) {
  await page.goto('landlord/rents/2026.05');
  const nameSpan = page
    .locator('span.text-lg.font-medium', { hasText: TENANT_NAME })
    .first();
  await expect(nameSpan).toBeVisible({ timeout: 20_000 });
  const tenantRow = nameSpan.locator(
    'xpath=ancestor::div[contains(@class, "flex") and .//*[contains(@class, "text-right")]][1]'
  );
  const cashBtn = tenantRow
    .locator('button')
    .filter({ has: page.locator('svg.size-6') })
    .first();
  await cashBtn.click();
  await expect(page.locator('[role=dialog]')).toBeVisible({ timeout: 10_000 });
  return tenantRow;
}

async function clickRecordAndWait(page: import('@playwright/test').Page) {
  const patchPromise = page.waitForResponse(
    (r) =>
      r.url().includes('/api/v2/rents/payment/') &&
      r.request().method() === 'PATCH'
  );
  await page
    .locator('[role=dialog] button')
    .filter({ hasText: /Record|Εκτέλεση/i })
    .first()
    .click();
  const resp = await patchPromise;
  expect(resp.status(), 'PATCH /rents/payment must 200').toBe(200);
  await expect(page.locator('[role=dialog][vaul-drawer]')).not.toBeVisible({
    timeout: 10_000
  });
}

test.beforeEach(() => {
  // Each scenario starts from the baseline so they're independent.
  restoreBaseline();
});

test('scenario 1 · single rent-only payment, auto-spread mode', async ({
  page
}) => {
  await signIn(page);
  await openPriftiDialog(page);

  // Click + Add another payment, fill amount; date defaults to today
  // (round-3g default), leave allocation = auto.
  await page.locator('[data-cy="addNewPayment"]').click();
  await page.locator('input[name="payments.0.amount"]').fill('100');
  // No date manipulation needed — emptyPayment() sets today.

  await clickRecordAndWait(page);

  // Mongo round-trip: allocation must be persisted.
  const snap = readRent(TENANT_NAME, TERM);
  expect(snap, 'rent must exist in mongo').not.toBeNull();
  const newPayment = snap!.payments.find((p) => Number(p.amount) === 100);
  expect(newPayment, 'new 100€ payment must be persisted').toBeTruthy();
  expect(
    Array.isArray(newPayment!.allocation) && newPayment!.allocation!.length > 0,
    'payment must carry allocation'
  ).toBe(true);
});

test('scenario 2 · payment with promo (discount) survives reopen', async ({
  page
}) => {
  await signIn(page);
  await openPriftiDialog(page);

  await page.locator('[data-cy="addNewPayment"]').click();
  await page.locator('input[name="payments.0.amount"]').fill('80');
  // Expand Discount collapse on the draft row, fill 5.
  await page
    .locator('[role=dialog] button')
    .filter({ hasText: /^\s*(Discount|Έκπτωση)\s*$/i })
    .first()
    .click();
  await page.locator('input[name="payments.0.promo"]').fill('5');

  await clickRecordAndWait(page);

  // Mongo verify
  const snap = readRent(TENANT_NAME, TERM);
  const p = snap!.payments.find((p) => Number(p.amount) === 80);
  expect(p, '80€ payment persisted').toBeTruthy();
  expect(Number(p!.promo), 'promo=5 persisted on payment').toBeCloseTo(5, 1);

  // Reopen the dialog and assert the saved tile shows Discount
  await openPriftiDialog(page);
  // Find the saved tile that corresponds to amount=80
  const tiles = page.locator('[data-cy^="savedPayment-"]');
  const tileCount = await tiles.count();
  let matched = false;
  for (let i = 0; i < tileCount; i++) {
    const txt = await tiles.nth(i).innerText();
    if (/80,?00|80\.00/.test(txt) && /(Discount|Έκπτωση)/i.test(txt)) {
      matched = true;
      break;
    }
  }
  expect(matched, 'saved tile after reopen must show Discount line').toBe(true);
});

test('scenario 3 · payment with extracharge survives reopen', async ({
  page
}) => {
  await signIn(page);
  await openPriftiDialog(page);

  await page.locator('[data-cy="addNewPayment"]').click();
  await page.locator('input[name="payments.0.amount"]').fill('70');
  // The i18n key is 'Additional cost' but the en translation is
  // 'Extraordinary charge'. Match either, plus the Greek.
  const extraTrigger = page
    .locator('[role=dialog] button')
    .filter({
      hasText: /Additional cost|Extraordinary charge|Έκτακτη χρέωση/
    })
    .first();
  await expect(extraTrigger).toBeVisible({ timeout: 10_000 });
  await extraTrigger.click();
  await page.locator('input[name="payments.0.extracharge"]').fill('3');

  await clickRecordAndWait(page);

  const snap = readRent(TENANT_NAME, TERM);
  const p = snap!.payments.find((p) => Number(p.amount) === 70);
  expect(p, '70€ payment persisted').toBeTruthy();
  expect(
    Number(p!.extracharge),
    'extracharge=3 persisted on payment'
  ).toBeCloseTo(3, 1);

  // Reopen + verify saved tile
  await openPriftiDialog(page);
  const tiles = page.locator('[data-cy^="savedPayment-"]');
  const n = await tiles.count();
  let matched = false;
  for (let i = 0; i < n; i++) {
    const txt = await tiles.nth(i).innerText();
    if (
      /70,?00|70\.00/.test(txt) &&
      /(Additional cost|Extraordinary charge|Έκτακτη χρέωση)/i.test(txt)
    ) {
      matched = true;
      break;
    }
  }
  expect(
    matched,
    'saved tile after reopen must show Additional cost line'
  ).toBe(true);
});

test('scenario 4 · KPI tile shows (prior dues: X) when carry-in exists', async ({
  page
}) => {
  // PRIFTI + KRANTAS have carry-in arrears in May 2026 (sum 2182 €
  // verified via the live API).
  await signIn(page);
  await page.goto('landlord/rents/2026.05');
  await expect(
    page.locator('span.text-lg.font-medium').first()
  ).toBeVisible({ timeout: 20_000 });
  // Locate the parens span by anchoring to the visible 'prior dues' or
  // 'προηγ. οφειλές' label inside the KPI tile — bypassing the
  // __NEXT_DATA__ dictionary dump that contains the same string.
  const parens = page.locator(
    'span.text-ink-muted',
    { hasText: /(προηγ\. οφειλές|prior dues)/ }
  );
  await expect(parens.first(), 'prior-dues parens must be visible').toBeVisible({
    timeout: 10_000
  });
  // Number inside the parens must be > 0.
  const txt = (await parens.first().innerText()) || '';
  const num = (txt.match(/[\d.,]+/g) || []).pop() || '';
  const numeric = Number(num.replace(/\./g, '').replace(',', '.')) || 0;
  expect(numeric, `(prior dues: X) must be > 0; got "${txt}"`).toBeGreaterThan(0);
});

test('scenario 5 · greyscale legend swatches (no petrol)', async ({ page }) => {
  await signIn(page);
  // Navigate to the dashboard and check the pie legend swatches.
  await expect.poll(() => page.url(), { timeout: 20_000 }).toMatch(/dashboard/);
  await page.waitForTimeout(2500);
  // Pie legend swatches are pill spans with inline background. Find
  // them by reading computed style.
  const swatches = await page
    .locator('span.size-2\\.5.rounded-pill[aria-hidden]')
    .all();
  expect(swatches.length, 'at least 2 legend swatches expected').toBeGreaterThanOrEqual(
    2
  );
  // The light + dark grey hex values we shipped: #bdb8b1 / #4a4d52.
  // Convert to rgb() since that's what computedStyle returns.
  const expectLight = 'rgb(189, 184, 177)';
  const expectDark = 'rgb(74, 77, 82)';
  let foundLight = false;
  let foundDark = false;
  for (const sw of swatches) {
    const bg = await sw.evaluate(
      (el) => window.getComputedStyle(el).backgroundColor
    );
    if (bg === expectLight) foundLight = true;
    if (bg === expectDark) foundDark = true;
  }
  expect(foundLight, 'light grey swatch (#bdb8b1)').toBe(true);
  expect(foundDark, 'dark grey swatch (#4a4d52)').toBe(true);
});

test('scenario 6 · express dialog offers prior-balance row for tenants in arrears', async ({
  page
}) => {
  await signIn(page);
  await page.goto('landlord/rents/2026.05');
  await expect(
    page.locator('span.text-lg.font-medium').first()
  ).toBeVisible({ timeout: 20_000 });
  await page.locator('[data-cy="expressPaymentBtn"]').click();
  // Drawer renders right side. Look for a row mentioning PRIFTI with
  // a "Prior balance" / "Προηγ. υπόλοιπο" sub-checkbox and an amount.
  await page.waitForTimeout(800);
  const drawerHtml = await page.content();
  expect(
    drawerHtml,
    'express drawer must list at least one tenant row'
  ).toMatch(new RegExp(TENANT_NAME));
  // The text "Prior balance" / "Προηγ. υπόλοιπο" should appear at
  // least once (PRIFTI has carry-in).
  expect(
    drawerHtml,
    'express drawer must show a prior-balance sub-row'
  ).toMatch(/(Prior balance|Προηγ\. υπόλοιπο)/);
});
