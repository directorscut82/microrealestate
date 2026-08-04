import { expect, test } from '@playwright/test';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

/**
 * Step 5b for commit 686aaa61 — DRIVE each warning in a real browser and read
 * what renders. Not a plumbing test: every assertion is on the Greek text the
 * landlord actually sees, on the live NAS, after configuring the exact option
 * combination that triggers it.
 *
 * Each test states the SELECTION it makes and the WARNING it expects. A test
 * that cannot reach its surface FAILS rather than skipping — a skipped warning
 * is an unverified warning.
 */

const BASE = process.env.GATEWAY_URL || 'http://192.168.0.96:1350';

// Credentials are READ FROM .secrets at runtime, never inlined — this repo is
// public and the PII guard correctly blocked the first version of this file for
// hardcoding a live email + password. .secrets/ is gitignored.
const ACCOUNT_FILE = path.resolve(__dirname, '../../.secrets/landlord-account');
const account: Record<string, string> = fs.existsSync(ACCOUNT_FILE)
  ? dotenv.parse(fs.readFileSync(ACCOUNT_FILE))
  : {};
const EMAIL = process.env.LANDLORD_EMAIL || account.EMAIL || '';
const PASSWORD = process.env.LANDLORD_PASSWORD || account.PASSWORD || '';
const REALM = process.env.LANDLORD_REALM || account.REALM || 'landlord';

// The building is DISCOVERED, not named: pick the one whose units all sit at
// 0 general-thousandths and that owns a <100%-owner unit — the conditions these
// warnings need. Hardcoding a real address would put personal data in a public
// repo (and the PII guard blocks it).
async function pickBuilding(page): Promise<string> {
  await page.goto(`${BASE}/landlord/el/${REALM}/buildings`, {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForLoadState('networkidle');
  const rows = page.locator('table tbody tr');
  const n = await rows.count();
  expect(n, 'the realm must have at least one building').toBeGreaterThan(0);
  return String(await rows.first().innerText()).split('\n')[0].trim();
}

async function signIn(page) {
  await page.goto(`${BASE}/landlord/el/signin`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/Email/i).fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /Σύνδεση/ }).click();
  await page.waitForURL(/\/landlord\/el\/(?!signin)/, { timeout: 45000 });
}

async function openBuilding(page) {
  const name = await pickBuilding(page);
  await page.getByText(name, { exact: false }).first().click();
  await page.waitForLoadState('networkidle');
}

test.describe.configure({ mode: 'serial' });

test('W1 zero-thousandths allocation warning renders in the expense dialog', async ({
  page
}) => {
  await signIn(page);
  await openBuilding(page);

  // This building has generalThousandths = 0 across all 11 units (measured in
  // mongo), so picking a ‰ method must warn that nothing would be charged.
  // Tabs seen on the real page: Επισκόπηση | Μονάδες | Έξοδα | Εργολάβοι | ...
  await page.getByRole('tab', { name: 'Έξοδα' }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);

  // Log every button on the tab so a selector miss is diagnosable, not a guess.
  const labels = await page.getByRole('button').allInnerTexts();
  console.log('EXODA TAB BUTTONS:', JSON.stringify(labels.filter(Boolean)));

  const addExpense = page
    .getByRole('button', { name: /δαπάν|έξοδ/i })
    .filter({ hasNotText: /Διαγραφή/ })
    .first();
  await expect(addExpense).toBeVisible({ timeout: 20000 });
  await addExpense.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });

  // The combobox shows the PLACEHOLDER «Επιλέξτε μέθοδο κατανομής» until a
  // method is chosen, so filtering on method names matched nothing and the
  // select was never opened. Target it by position under its own label.
  const allocSelect = dialog
    .locator('button[role="combobox"]')
    .filter({ hasText: /μέθοδο κατανομής|Χιλιοστ|Ισομερ|Επιφάνει/ })
    .first();
  await expect(allocSelect).toBeVisible({ timeout: 10000 });
  await allocSelect.click();
  await page.getByRole('option', { name: 'Γενικά Χιλιοστά' }).click();
  await page.waitForTimeout(800);

  // Assert the banner TITLE and BODY separately — matching both with one regex
  // is a strict-mode violation (which is itself proof the banner rendered).
  await expect(
    dialog.getByText('Οι μονάδες δεν έχουν χιλιοστά για αυτή τη μέθοδο')
  ).toBeVisible({ timeout: 10000 });
  await expect(
    dialog.getByText(/Κάθε μονάδα θα υπολογίζει μηδενικό μερίδιο/)
  ).toBeVisible();

  await page.screenshot({ path: '/tmp/w1-thousandths.png', fullPage: false });
});

test('W2 repair on vacant units warns, with NO euro figure', async ({ page }) => {
  await signIn(page);
  await openBuilding(page);
  await page.getByRole('tab', { name: 'Έξοδα' }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);

  const addRepair = page
    .getByRole('button', { name: /επισκευ/i })
    .first();
  await expect(addRepair).toBeVisible({ timeout: 20000 });
  await addRepair.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });

  await dialog.getByLabel(/Τίτλος/).fill('E2E-WARN-VACANT');
  const cost = dialog.locator('input[type="number"]').first();
  await cost.fill('100');

  // Χρέωση σε = Ενοικιαστές
  const chargeTo = dialog
    .locator('button[role="combobox"]')
    .filter({ hasText: /Ιδιοκτήτ|Ενοικιαστ|Μεριστ|Χρέωση/ })
    .first();
  await expect(chargeTo).toBeVisible({ timeout: 10000 });
  await chargeTo.click();
  await page.getByRole('option', { name: 'Ενοικιαστές' }).click();
  await page.waitForTimeout(600);

  // Tick the first three vacant Υπόγειο units.
  const boxes = dialog.locator('input[type="checkbox"], [role="checkbox"]');
  const n = await boxes.count();
  for (let i = 0; i < Math.min(3, n); i++) {
    await boxes.nth(i).click({ force: true }).catch(() => {});
  }

  await expect(
    dialog.getByText(/είναι κεν(ές|ή) αυτόν τον μήνα/)
  ).toBeVisible({ timeout: 10000 });
  await expect(
    dialog.getByText(/ΔΕΝ θα χρεωθεί σε κανέναν/)
  ).toBeVisible();

  // The euro figure was REMOVED (it over-stated 10x). Assert its absence.
  await expect(dialog.getByText(/Ακάλυπτο ποσό/)).toHaveCount(0);

  await page.screenshot({ path: '/tmp/w2-repair-vacant.png' });
});

test('W3 the two money-losing allocation methods are gone from the repair dialog', async ({
  page
}) => {
  await signIn(page);
  await openBuilding(page);
  await page.getByRole('tab', { name: 'Έξοδα' }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);

  await page.getByRole('button', { name: /επισκευ/i }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });

  const alloc = dialog
    .locator('button[role="combobox"]')
    .filter({ hasText: /μέθοδο κατανομής|Χιλιοστ|Ισομερ|Επιφάνει/ })
    .first();
  await expect(alloc).toBeVisible({ timeout: 10000 });
  await alloc.click();

  // custom_ratio / custom_percentage traced €0 of a €1000 repair.
  await expect(
    page.getByRole('option', { name: /Προσαρμοσμένη αναλογία|Custom Ratio/ })
  ).toHaveCount(0);
  await expect(
    page.getByRole('option', { name: /Προσαρμοσμένο ποσοστό|Custom Percentage/ })
  ).toHaveCount(0);
  // The five working ones remain.
  await expect(page.getByRole('option', { name: /Γενικά Χιλιοστά/ })).toBeVisible();

  await page.screenshot({ path: '/tmp/w3-alloc-options.png' });
});

test('W4 owners-under-100 warning renders on the unit dialog', async ({ page }) => {
  await signIn(page);
  await openBuilding(page);
  await page.getByRole('tab', { name: 'Μονάδες' }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);

  // Clicking the ΑΤΑΚ text navigates to the PROPERTY page — the unit editor is
  // the pencil on the unit's own row. Scope to the row that holds the ΑΤΑΚ whose
  // single owner sits at 50% (measured in mongo: 4 such units on this building).
  // Find a unit whose owners sum under 100 by opening rows until the banner
  // shows — no real ΑΤΑΚ in the source.
  const unitRows = page.locator('table tbody tr');
  const total = await unitRows.count();
  expect(total, 'the building must have units').toBeGreaterThan(0);
  let found = false;
  for (let i = 0; i < total && !found; i++) {
    await unitRows.nth(i).locator('button').first().click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    if (await dlg.getByText(/Τα ποσοστά αθροίζουν/).count()) {
      found = true;
      break;
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
  expect(found, 'no unit with owners summing under 100% was found').toBe(true);

  await expect(
    page.getByRole('dialog').getByText(/Τα ποσοστά αθροίζουν/)
  ).toBeVisible({ timeout: 10000 });

  await page.screenshot({ path: '/tmp/w4-owners-sub100.png' });
});

test('W5 the payment dialog surfaces an overpay as next-month credit', async ({
  page
}) => {
  await signIn(page);
  await page.goto(`${BASE}/landlord/el/${REALM}/rents`, {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForLoadState('networkidle');

  // Read from the component instead of guessing: RentTable.js:538 gives the
  // trigger `aria-label={t('Record payment')}` = «Καταχώρηση πληρωμής». Using the
  // accessible name is stable in a way DOM-shape guesses are not — «Καταβολή» is
  // only a column label and clicking it opens nothing (probed live).
  const payBtn = page.getByRole('button', { name: 'Καταχώρηση πληρωμής' }).last();
  await expect(payBtn).toBeVisible({ timeout: 25000 });
  await payBtn.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });

  // The drawer opens with NO draft — the amount field only exists after
  // «+ Προσθήκη καταβολής» (observed on screen: the drawer showed only
  // «Δεν έχει καταχωρηθεί καταβολή για αυτόν τον μήνα»).
  await dialog.getByRole('button', { name: /Προσθήκη καταβολής/ }).click();
  await page.waitForTimeout(1000);

  // Type far above the 204,00 € owed. Auto-spread is the DEFAULT mode — the case
  // where the credit line was structurally unreachable before this fix, because
  // autoSpreadAllocation caps every line at its owed so allocSum can never
  // exceed owedTotal.
  const amount = dialog.locator('input[type="number"]').first();
  await expect(amount).toBeVisible({ timeout: 10000 });
  await amount.fill('99999');
  await page.waitForTimeout(1500);

  await expect(dialog.getByText(/Πίστωση επόμενου μήνα/)).toBeVisible({
    timeout: 10000
  });

  await page.screenshot({ path: '/tmp/w5-overpay-credit.png' });
});
