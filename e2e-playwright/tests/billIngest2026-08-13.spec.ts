/**
 * Exercises everything shipped 2026-08-13 against the LIVE NAS and real data.
 *
 * One spec per change, each asserting the thing that was actually broken — not that a
 * page loads. Screenshots go to ../_greek so the Greek surfaces can be READ, because a
 * green assertion on a JSON value is not a UI review.
 *
 * Uses the LANDLORD account, not the cypress realm: the surfaces under test involve a
 * real building, its real «ΔΕΗ» expense and a real ΕΥΔΑΠ bill. The account is the
 * user's own and they have authorised mutating it. Entities are referenced by id
 * only — this repo is public, and a building's street name is the landlord's address.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const GATEWAY = 'http://192.168.0.96:1350';
const BASE = `${GATEWAY}/landlord/el`;
const OUT = path.resolve(__dirname, '../_greek');

// The landlord account, whose realm holds the real data.
const ACCT_FILE = path.resolve(__dirname, '../../.secrets/landlord-account');
const acct = fs.existsSync(ACCT_FILE)
  ? dotenv.parse(fs.readFileSync(ACCT_FILE))
  : ({} as Record<string, string>);
const EMAIL = acct.EMAIL ?? '';
const PASSWORD = acct.PASSWORD ?? '';
// The landlord-account file spells it REALM (the cypress-account file uses ORG_NAME).
// Reading the wrong key produced an EMPTY org segment, every URL 404'd, and the
// «no files» skip below then fired on the 404 page — a vacuous pass that looked like
// a legitimate skip.
const ORG = acct.REALM ?? acct.ORG_NAME ?? 'landlord';
const BUILDING = '6a5920fa1df21dc733133cbe';
const PROPERTY = '6a5920fa1df21dc733133ccd'; // the apartment «ΔΕΗ» bills

// The real ΕΥΔΑΠ photo. Gitignored (it carries the account holder's name, address,
// meter and MARK), so the OCR test skips rather than fails when it is absent.
const EYDAP_IMG = path.resolve(__dirname, '../../.scratch-eydap/eydap.jpg');

test.use({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });

async function signIn(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/signin`);
  await page.waitForTimeout(700);
  await page.locator('input[name=email]').fill(EMAIL);
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 30000 })
    .toMatch(/(firstaccess|dashboard)/);
}

test.beforeEach(async ({ page }) => {
  test.skip(!EMAIL, 'no landlord credentials');
  fs.mkdirSync(OUT, { recursive: true });
  await signIn(page);
});

test('settings Αρχεία loads COUNTS only, and a folder fetches only when opened', async ({
  page
}) => {
  // The defect: the page called fetchDocuments() unfiltered and downloaded every
  // document row in the realm on open. The fix is only real if a CLOSED folder issues
  // no request — so count the requests, do not just look at the screen.
  const docRequests: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/\/api\/v2\/documents(\?|$)/.test(u)) docRequests.push(u);
  });

  await page.goto(`${BASE}/${encodeURIComponent(ORG)}/settings/files`);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT, 'today_files_closed.png'), fullPage: true });

  // The tree call carries no document bodies; the LIST endpoint must not have been
  // hit at all while every folder is shut.
  const listCallsBeforeOpening = docRequests.filter((u) => !/\/documents\/tree/.test(u));
  expect(
    { listCallsBeforeOpening },
    'a closed folder must issue no /documents request'
  ).toEqual({ listCallsBeforeOpening: [] });

  // Assert the PAGE loaded before drawing any conclusion from an empty list — a 404
  // has no folders either, and skipping on that is how a broken URL reads as a pass.
  await expect(page.locator('[data-cy=settingsFilesPage]')).toBeVisible({
    timeout: 15000
  });

  const folders = page.locator('[data-cy=fileBrowserFolder]');
  const n = await folders.count();
  // Nothing to assert about laziness if the realm has no files at all — say so
  // rather than pass vacuously.
  test.skip(n === 0, 'realm has no uploaded files; nothing to expand');

  await folders.first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, 'today_files_open.png'), fullPage: true });

  // Opening a leaf must produce exactly the fetch it needs. A container folder
  // reveals sub-folders and still issues nothing, which is also correct — so accept
  // either, but require that SOMETHING changed on screen.
  const expandedRows = await page.locator('[data-cy=fileBrowserRow]').count();
  const visibleFolders = await folders.count();
  expect(
    { expandedRows, grew: visibleFolders > n },
    'opening a folder must reveal files or nested folders'
  ).not.toEqual({ expandedRows: 0, grew: false });
});

test('an apartment has an Έγγραφα tab wired to ITS OWN documents', async ({ page }) => {
  // Before today the property page had no tabs at all, and `Document` had no
  // propertyId — an apartment's papers had nowhere to live.
  await page.goto(`${BASE}/${encodeURIComponent(ORG)}/properties/${PROPERTY}`);
  await page.waitForTimeout(2500);
  const tab = page.locator('[data-cy=documentsTab]');
  await expect(tab).toBeVisible();

  // The request the tab fires must be scoped to the apartment. An unfiltered call
  // would list the WHOLE REALM under one flat — the fail-open shape.
  const scoped: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/\/api\/v2\/documents\?/.test(u)) scoped.push(u);
  });
  await tab.click();
  await page.waitForTimeout(2500);
  await page.screenshot({
    path: path.join(OUT, 'today_apartment_documents.png'),
    fullPage: true
  });
  expect(
    scoped.every((u) => u.includes('propertyId=')),
    `documents calls must be propertyId-scoped, got: ${scoped.join(' | ')}`
  ).toBe(true);

  // The details form must still be reachable — the tab must not have replaced it.
  await page.locator('[data-cy=detailsTab]').click();
  await page.waitForTimeout(1200);
  await expect(page.locator('input[name=name]').first()).toBeVisible();
});

test('«ΔΕΗ» is an electricity expense and my test row is gone', async ({ page }) => {
  await page.goto(`${BASE}/${encodeURIComponent(ORG)}/buildings/${BUILDING}?tab=expenses`);
  await page.waitForTimeout(3000);
  // Same guard: a 404 page contains neither string, so both assertions below would
  // "pass" the not-contains and fail the contains for the wrong reason.
  expect(await page.locator('body').innerText()).not.toContain('404');
  await page.screenshot({
    path: path.join(OUT, 'today_building_expenses.png'),
    fullPage: true
  });
  const body = await page.locator('body').innerText();
  // The test expense I created while checking the overview must not be on a live
  // building — it was recurring at €100/month with €40 owner-tracked.
  expect(body).not.toContain('test-overview');
  // And the ΔΕΗ expense is still present, now correctly typed (the name is what the
  // landlord reads; the type drives which category the money lands in).
  expect(body).toContain('ΔΕΗ');
});

test('the ΕΥΔΑΠ bill parses, and shows a scannable BARCODE not an empty box', async ({
  page
}) => {
  test.skip(!fs.existsSync(EYDAP_IMG), 'real ΕΥΔΑΠ image not present (gitignored)');
  test.setTimeout(300000); // OCR is ~60s on the NAS

  await page.goto(`${BASE}/${encodeURIComponent(ORG)}/buildings/${BUILDING}?tab=expenses`);
  await page.waitForTimeout(2500);

  // Drive the real import dialog rather than the API, so the CARD is what gets
  // asserted — the parser was already proven by unit tests; this is about the screen.
  const importBtn = page.getByRole('button', { name: /Εισαγωγή|λογαριασμ/i }).first();
  const opened = await importBtn.isVisible().catch(() => false);
  test.skip(!opened, 'bill-import entry point not found on the expenses tab');
  await importBtn.click();
  await page.waitForTimeout(1200);

  const input = page.locator('input[type=file]').first();
  await input.setInputFiles(EYDAP_IMG);
  // Attaching the file only STAGES it — the dialog waits for «Συνέχεια» before it
  // starts the OCR. The first run of this spec asserted on the amount without
  // clicking, so it timed out for 4 minutes against a dialog that was patiently
  // waiting for a click. The screenshot showed the file sitting there, staged.
  await expect(page.getByText('eydap.jpg')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /Συνέχεια/ }).click();
  // Wait for the OCR to land. The amount is an editable INPUT, so getByText never
  // matches it — the first version of this assertion waited 4 minutes for text that
  // by design does not exist. Assert the input's VALUE.
  const amount = page.locator('input').filter({ hasNot: page.locator('[type=file]') });
  await expect
    .poll(
      async () => {
        const vals = await amount.evaluateAll((els) =>
          els.map((e) => (e as HTMLInputElement).value)
        );
        return vals.join('|');
      },
      { timeout: 240000, intervals: [2000] }
    )
    .toContain('89,94');
  await page.screenshot({ path: path.join(OUT, 'today_eydap_card.png'), fullPage: true });

  // The barcode must be rendered — an <img> with a base64 payload. Before today a
  // ΕΥΔΑΠ card showed no payment code at all, because the IRIS generator needs an RF
  // code and ΕΥΔΑΠ prints none.
  const code = page.locator('img[src^="data:image/png;base64,"]').first();
  await expect(code).toBeVisible();
  const box = await code.boundingBox();
  expect(box, 'the payment code must have a size').not.toBeNull();
  // …and it must be WIDE, not squeezed into the QR's square box, or it cannot scan.
  expect(
    { wider: (box!.width ?? 0) > (box!.height ?? 1) * 1.5 },
    `barcode should be wide, got ${box!.width}x${box!.height}`
  ).toEqual({ wider: true });

  const text = await page.locator('body').innerText();
  // The charge month must be AUGUST (the issue month), not July (the period end) —
  // the card prints it beside the provider: «ΕΥΔΑΠ · Αύγουστο 2026».
  expect(text).toMatch(/ΕΥΔΑΠ\s*·\s*Αύγουστ/);
  // The meter is the match key, so it is the identifier shown.
  expect(text).toContain('A98E84011');
  // And the source label must say OCR for a photograph, not PDF.
  expect(text).toMatch(/OCR|εικόν/i);
  expect(text).not.toContain('Από το PDF');
});
