/**
 * GATE 9 for the parser-warning rows: LOOK at them, in Greek, on the deployed NAS.
 *
 * Six warning codes now render in the import dialog's amber block. Every one of them was
 * verified by unit test and by mutation, and none of them had ever been rendered — which
 * is the exact class of defect this repo keeps shipping: the logic was right and nobody
 * had seen the screen. The `eydap-mismatch` fixture exists so this surface is reachable
 * at all; the other four fixtures are internally consistent and cannot produce it.
 */
import { expect, test } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const GATEWAY = 'http://192.168.0.96:1350';
const BASE = `${GATEWAY}/landlord/el`;
const OUT = path.resolve(__dirname, '../_greek');
const ACCT_FILE = path.resolve(__dirname, '../../.secrets/landlord-account');
const acct = fs.existsSync(ACCT_FILE)
  ? Object.fromEntries(
      fs
        .readFileSync(ACCT_FILE, 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    )
  : {};
const EMAIL = acct.EMAIL ?? '';
const PASSWORD = acct.PASSWORD ?? '';
const ORG = acct.REALM ?? acct.ORG_NAME ?? 'landlord';
const BUILDING = '6a5920fa1df21dc733133cbe';
const FIX = path.resolve(__dirname, '../.fixtures-bills/eydap-mismatch.png');

fs.mkdirSync(OUT, { recursive: true });

test.beforeEach(async ({ page }) => {
  await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('signin')) {
    await page.locator('input[name=email]').fill(EMAIL);
    await page.locator('input[name=password]').fill(PASSWORD);
    await page.getByRole('button', { name: /Σύνδεση|Sign in/i }).click();
    await page.waitForURL((u) => !u.toString().includes('signin'), { timeout: 30000 });
  }
});

test('the disagreement rows render in GREEK on the import card', async ({ page }) => {
  test.skip(!fs.existsSync(FIX), 'run tools/make-bill-fixtures.mjs');
  test.setTimeout(300000);

  await page.goto(
    `${BASE}/${encodeURIComponent(ORG)}/buildings/${BUILDING}?tab=expenses`,
    { waitUntil: 'domcontentloaded' }
  );
  const importBtn = page
    .getByRole('button', { name: /Εισαγωγή|λογαριασμ/i })
    .first();
  await expect(importBtn).toBeVisible({ timeout: 20000 });
  await importBtn.click();
  await page.locator('input[type=file]').first().setInputFiles(FIX);
  await expect(page.getByText('eydap-mismatch.png')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /Συνέχεια/ }).click();

  // The OCR takes ~50s per page on the NAS.
  await expect
    .poll(async () => await page.locator('body').innerText(), {
      timeout: 240000,
      intervals: [3000]
    })
    .toMatch(/89,94|109,94/);

  await page.screenshot({
    path: path.join(OUT, 'warning_rows_mismatch.png'),
    fullPage: true
  });

  const text = await page.locator('body').innerText();
  const inputs = await page
    .locator('input')
    .filter({ hasNot: page.locator('[type=file]') })
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));

  expect(
    {
      // The override message, in Greek, naming what was used.
      overrideRow: /άθροισμα των γραμμών/.test(text),
      // NOT the raw i18n key — a missing el translation renders the English key.
      noRawKey: !/itemised lines|subtotal disagrees/.test(text),
      /**
       * The amount FIELD carries what the landlord OWES (109,94) — my first version
       * asserted the lower figure here and was simply wrong about the contract: the
       * editable amount is the payable, and the tenants' figure lives in the warning. Same
       * split the arrears card has always used, and reading the screenshot is what
       * corrected me.
       */
      amountIsPayable: inputs.some((v) => v.includes('109,94')),
      tenantFigureStated: /89,94/.test(text),
      /**
       * AND THE DEFECT THIS REVIEW FOUND: the card used to ALSO say «περιλαμβάνει 20,00 €
       * από προηγούμενη περίοδο», explaining the same 20,00 a second time with a cause the
       * document contradicts — its payable equals its stated subtotal, so there is no prior
       * balance. Two explanations for one discrepancy, one of them false, on a money
       * surface.
       */
      noPhantomArrears: !/προηγούμενη περίοδο/.test(text)
    },
    `card text:\n${text.slice(0, 1400)}\ninputs: ${JSON.stringify(inputs)}`
  ).toEqual({
    overrideRow: true,
    noRawKey: true,
    amountIsPayable: true,
    tenantFigureStated: true,
    noPhantomArrears: true
  });
});
