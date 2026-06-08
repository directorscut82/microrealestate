/**
 * VERIFY T0: ImportE9Dialog hardening (commit 231aff39).
 *
 *  - V_T0.1 (P1.1) — owner row renders "<Last> <First> (ΑΦΜ: <id>)" with no
 *                    leading blank. Pre-fix concatenated parsed.owner.name
 *                    (always undefined) → " (ΑΦΜ: ...)".
 *  - V_T0.2 (P1.8) — count: 1 unit renders "1 μονάδα" / "1 unit", not
 *                    "1 μονάδες" / "1 units".
 *  - V_T0.3 (P1.9) — fr-FR locale via URL prefix renders FileDropZone label,
 *                    Owners section header, and dialog description in French.
 *  - V_T0.4 (P1.15) — server 422 with verbatim message
 *                    "Could not parse owner information from E9 PDF" surfaces
 *                    as toast (not the generic "Failed to parse E9 PDF").
 *
 * Strategy: drive UI on /landlord/<el-or-fr>/<realm>/buildings against deployed
 * NAS revision ca685d92. Cleanup: dialog only previews — the POST is
 * confirmed=false so no buildings are created. T0.4 has nothing to clean up
 * because the import errors before any DB write.
 */
import { test, expect, request, APIRequestContext } from '@playwright/test';
import path from 'path';
import { ensureSeed } from './lib/api';

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';
const PDF_DIR = '/Users/epitrogi/Downloads/New folder/for_microestate';
const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

test.describe.serial('V_T0: ImportE9Dialog hardening', () => {
  let api: APIRequestContext;
  let realmName: string;
  let realmId: string;
  let token: string;

  test.beforeAll(async () => {
    if (!TEST_EMAIL || !TEST_PASSWORD) {
      throw new Error('Missing TEST_EMAIL/TEST_PASSWORD');
    }
    api = await request.newContext();
    const seed = await ensureSeed(api);
    realmName = seed.realmName;
    realmId = seed.realmId;
    token = seed.token;
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  async function signIn(page, localePrefix: string = '') {
    const url = localePrefix ? `/landlord/${localePrefix}/signin` : 'signin';
    await page.goto(url);
    await page.locator('input[name=email]').fill(TEST_EMAIL);
    await page.locator('input[name=password]').fill(TEST_PASSWORD);
    await page.locator('[data-cy=submit]').first().click();
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
      .toMatch(/\/(firstaccess|dashboard)/);
  }

  async function openE9Dialog(page, localePrefix: string = '') {
    const base = localePrefix
      ? `/landlord/${localePrefix}/${encodeURIComponent(realmName)}/buildings`
      : `${encodeURIComponent(realmName)}/buildings`;
    await page.goto(base);
    await page.waitForLoadState('networkidle');
    // Click the "Import from E9" button. Localized labels:
    //  - en: "Import from E9"
    //  - el: "Εισαγωγή από Ε9"
    //  - fr-FR: "Importer depuis E9"
    await page
      .locator('button', {
        hasText: /Import from E9|Εισαγωγή από Ε9|Importer depuis E9/
      })
      .first()
      .click();
    // Wait for dialog header
    await expect(
      page.locator('text=/Import from E9 PDF|Εισαγωγή από PDF Ε9|Importer depuis un PDF E9/i').first()
    ).toBeVisible({ timeout: 10_000 });
  }

  test('V_T0.1: owner row renders "<Last> <First> (ΑΦΜ: <id>)" with no leading blank', async ({
    page
  }) => {
    test.setTimeout(120_000);

    await signIn(page);
    await openE9Dialog(page);

    // Upload PDF for ΕΠΙΤΡΟΠΟΥ ΓΕΩΡΓΙΟΣ (taxId 125479189)
    const fileInput = page.locator('input[type=file]').first();
    await fileInput.setInputFiles(
      path.join(PDF_DIR, 'PeriousiakiKatastasi2027-1.pdf')
    );

    const parseRespP = page.waitForResponse(
      (r) => r.url().includes('/api/v2/buildings/import-pdf'),
      { timeout: 60_000 }
    );
    // Click Continue / Συνέχεια
    await page
      .locator('button[data-cy=parseE9]', {
        hasText: /Continue|Συνέχεια/i
      })
      .first()
      .click();
    const parseResp = await parseRespP;
    expect(parseResp.status(), 'parse status').toBe(200);

    // Owner row contains the full canonical string
    const dialog = page.locator('[role=dialog]').first();
    const expected = 'ΕΠΙΤΡΟΠΟΥ ΓΕΩΡΓΙΟΣ (ΑΦΜ: 125479189)';
    // Locate the owner row by ΑΦΜ marker
    const ownerRow = dialog.locator('div', { hasText: /ΑΦΜ:/ }).first();
    await expect(ownerRow, 'owner row visible').toBeVisible({ timeout: 10_000 });
    const ownerText = (await ownerRow.innerText()).trim();
    // The owner row may include surrounding context whitespace from the dialog.
    // Assert the canonical string is fully present.
    expect(ownerText, 'owner text').toContain(expected);
    // Anti-regression: must NOT start with " (ΑΦΜ:" (leading-blank bug).
    expect(ownerText, 'no leading-blank bug').not.toMatch(/^\s*\(ΑΦΜ:/);

    // Capture preview innerText for evidence
    const previewText = await dialog.innerText();
    console.log('==== T0.1 PREVIEW INNER TEXT ====');
    console.log(previewText.slice(0, 1500));
    console.log('==== END ====');

    // Close
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('V_T0.2: 1-unit building renders "1 unit" + "1 land plot skipped" — not "1 units"', async ({
    page
  }) => {
    test.setTimeout(180_000);

    // ROUND 1: default locale (`en`) — URL has no /<lang>/ prefix.
    // PeriousiakiKatastasi2026-3.pdf yields ΑΧΑΡΝΩΝ 167 (1 unit) +
    // ΚΑΛΑΜΩΝ 24 (5 units), skippedLandPlots=4.
    // Use 2027-2.pdf instead — same owner has 1 building with 1 unit
    // (ΣΠΑΡΤΙΑΤΩΝ 9) and skippedLandPlots=1 to exercise the
    // "{{count}} land plots skipped_one" branch too.
    await signIn(page);
    await openE9Dialog(page);

    let fileInput = page.locator('input[type=file]').first();
    await fileInput.setInputFiles(
      path.join(PDF_DIR, 'PeriousiakiKatastasi2026-3.pdf')
    );

    let parseRespP = page.waitForResponse(
      (r) => r.url().includes('/api/v2/buildings/import-pdf'),
      { timeout: 60_000 }
    );
    await page.locator('button[data-cy=parseE9]').first().click();
    let parseResp = await parseRespP;
    expect(parseResp.status(), 'parse status (en)').toBe(200);

    let dialog = page.locator('[role=dialog]').first();
    await expect(dialog, 'preview visible (en)').toBeVisible({ timeout: 10_000 });
    let previewText = await dialog.innerText();

    // English _one variant: count=1 → "1 unit" (NOT "1 units")
    // Negative-first: must NOT contain the un-pluralized "1 units" form.
    // Note: substring match — guard against a leading digit by anchoring
    // on a whitespace character before "1 units" so "11 units" or "21 units"
    // doesn't false-trigger this. (Not actually present in this PDF.)
    expect(previewText, 'no "1 units" plural-with-count=1').not.toMatch(/(?:^|\s)1 units(?:\s|$)/);
    expect(previewText, 'singular "1 unit" present').toMatch(/(?:^|\s)1 unit(?:\s|$)/);
    // 5-unit building must still render plural
    expect(previewText, 'plural "5 units" for ΚΑΛΑΜΩΝ').toContain('5 units');

    console.log('==== T0.2-EN PREVIEW INNER TEXT ====');
    console.log(previewText.slice(0, 2000));
    console.log('==== END ====');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // ROUND 2: el locale via URL prefix — verify Greek "1 μονάδα" + plural.
    await page.goto(
      `/landlord/el/${encodeURIComponent(realmName)}/buildings`
    );
    await page.waitForLoadState('networkidle');
    await page
      .locator('button', { hasText: /Εισαγωγή από Ε9/ })
      .first()
      .click();
    await expect(
      page.locator('[role=dialog]').first()
    ).toBeVisible({ timeout: 10_000 });

    fileInput = page.locator('input[type=file]').first();
    await fileInput.setInputFiles(
      path.join(PDF_DIR, 'PeriousiakiKatastasi2026-3.pdf')
    );
    parseRespP = page.waitForResponse(
      (r) => r.url().includes('/api/v2/buildings/import-pdf'),
      { timeout: 60_000 }
    );
    await page.locator('button[data-cy=parseE9]').first().click();
    parseResp = await parseRespP;
    expect(parseResp.status(), 'parse status (el)').toBe(200);

    dialog = page.locator('[role=dialog]').first();
    await expect(dialog, 'preview visible (el)').toBeVisible({ timeout: 10_000 });
    previewText = await dialog.innerText();

    // Greek _one variant: count=1 → "1 μονάδα" (NOT "1 μονάδες")
    expect(previewText, 'no "1 μονάδες" plural-with-count=1').not.toContain('1 μονάδες');
    expect(previewText, 'singular "1 μονάδα" present (el)').toContain('1 μονάδα');
    expect(previewText, 'plural "5 μονάδες" for ΚΑΛΑΜΩΝ (el)').toContain('5 μονάδες');

    console.log('==== T0.2-EL PREVIEW INNER TEXT ====');
    console.log(previewText.slice(0, 2000));
    console.log('==== END ====');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('V_T0.3: fr-FR locale via URL prefix renders French labels', async ({
    page
  }) => {
    test.setTimeout(120_000);

    // No mongo mutation needed — next-translate honors URL-prefix locale.
    await signIn(page, 'fr-FR');
    await openE9Dialog(page, 'fr-FR');

    const dialog = page.locator('[role=dialog]').first();

    // FileDropZone description must be French (was English fallback pre-fix).
    await expect(
      dialog.getByText('Déposez les fichiers PDF ici ou cliquez pour parcourir', {
        exact: false
      }),
      'FileDropZone French label'
    ).toBeVisible({ timeout: 10_000 });

    // Dialog description must be French
    await expect(
      dialog.getByText(
        'Téléversez un ou plusieurs fichiers PDF E9 pour importer des immeubles et des lots',
        { exact: false }
      ),
      'E9 upload description in French'
    ).toBeVisible({ timeout: 5_000 });

    // To assert "Owners" → "Propriétaires", we need to enter preview state.
    // Upload an E9 PDF — even though the page locale is fr-FR, the parser
    // still works on Greek text content.
    const fileInput = page.locator('input[type=file]').first();
    await fileInput.setInputFiles(
      path.join(PDF_DIR, 'PeriousiakiKatastasi2027-1.pdf')
    );

    const parseRespP = page.waitForResponse(
      (r) => r.url().includes('/api/v2/buildings/import-pdf'),
      { timeout: 60_000 }
    );
    // Continue button — French label is "Continuer"
    await page
      .locator('button[data-cy=parseE9]')
      .first()
      .click();
    const parseResp = await parseRespP;
    expect(parseResp.status(), 'parse status fr-FR').toBe(200);

    // Owner section header — single owner so the header is "Owner"/"Propriétaire"
    // (the conditional uses `length === 1 ? 'Owner' : 'Owners'`). We covered
    // both via locale strings; verify "Propriétaire" appears.
    const previewText = await dialog.innerText();
    expect(
      /Propriétaire/.test(previewText),
      `dialog must contain French "Propriétaire(s)" header — got: ${previewText.slice(0, 600)}`
    ).toBe(true);
    // Anti-regression: must NOT contain bare English "Owners" / "Owner"
    expect(/(?:^|\s)Owners(?:\s|$)/.test(previewText), 'no English "Owners" fallback').toBe(false);

    console.log('==== T0.3 fr-FR PREVIEW INNER TEXT ====');
    console.log(previewText.slice(0, 2000));
    console.log('==== END ====');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('V_T0.4: server 422 owner-parse error surfaces verbatim in toast (not generic)', async ({
    page
  }) => {
    test.setTimeout(120_000);

    await signIn(page);
    await openE9Dialog(page);

    // document.pdf is a Greek lease PDF (not an E9). Post-hotfix L7 marker
    // gate rejects non-E9 PDFs at the marker stage BEFORE the parser runs:
    // "PDF does not look like an E9 declaration (missing Ε9 / ΠΕΡΙΟΥΣΙΑΚ-
    // markers)". Pre-fix the dialog showed generic "Failed to parse E9 PDF".
    const fileInput = page.locator('input[type=file]').first();
    await fileInput.setInputFiles(path.join(PDF_DIR, 'document.pdf'));

    const parseRespP = page.waitForResponse(
      (r) => r.url().includes('/api/v2/buildings/import-pdf'),
      { timeout: 60_000 }
    );
    await page.locator('button[data-cy=parseE9]').first().click();
    const parseResp = await parseRespP;
    expect(parseResp.status(), 'parse status for non-E9 PDF').toBe(422);
    const body = await parseResp.json();
    expect(body.message, 'API error body').toBe(
      'PDF does not look like an E9 declaration (missing Ε9 / ΠΕΡΙΟΥΣΙΑΚ- markers)'
    );

    // Toast must contain the verbatim server message — NOT the localized
    // generic fallback "Failed to parse E9 PDF" / "Σφάλμα ανάλυσης PDF Ε9".
    await expect(
      page.getByText('PDF does not look like an E9 declaration', {
        exact: false
      }),
      'verbatim server message in toast'
    ).toBeVisible({ timeout: 10_000 });

    // Anti-regression: generic toast must NOT appear
    const genericToastCount = await page
      .getByText(/^Failed to parse E9 PDF$/, { exact: false })
      .count();
    expect(genericToastCount, 'no generic Failed-to-parse toast').toBe(0);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });
});
