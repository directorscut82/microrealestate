import { expect, request, test } from '@playwright/test';
import { ensureSeed, ensureSeedRichBuilding } from './lib/api';

/**
 * Spec 43 · Round-1 · ExpenseList dialog on /buildings/[id] — full
 * combinatorial coverage of the expense form on the Expenses tab of a
 * building page. Pairs with the F2/F3/F4/F5/F6 audit-driven repairs at
 * `686c04be` and `aaa1e4a2`. The point is set-narrowing coverage that
 * would have caught every audit finding before deploy.
 *
 * Discipline anchors:
 *   - Status-code assertion + round-trip read-back for every save.
 *   - Set-narrowing on dropdown contents (toHaveCount per expense
 *     type) — never just toBeVisible() on a single SelectItem.
 *   - For client-side rejections (F4/F5/F6/percentage-sum/ratio-zero):
 *     install a request listener that fails the test if a PATCH/POST
 *     to /buildings/.../expenses ever fires. The form must short-circuit.
 *   - Cleanup after each save so the building doesn't accumulate
 *     E2E-Round1-* expenses across runs (DELETE via API).
 */

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';
const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error(
      'Missing TEST_EMAIL/TEST_PASSWORD. Expected .secrets/cypress-test-account.'
    );
  }
});

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
    .toMatch(/\/(firstaccess|dashboard)/);
}

async function gotoExpensesTab(
  page: import('@playwright/test').Page,
  realmName: string,
  buildingId: string
) {
  await page.goto(`${encodeURIComponent(realmName)}/buildings/${buildingId}`);
  await page.locator('[data-cy=expensesTab]').click();
  await expect(page.locator('[data-cy=addExpense]')).toBeVisible({
    timeout: 20_000
  });
}

async function openAddDialog(page: import('@playwright/test').Page) {
  await page.locator('[data-cy=addExpense]').click();
  await expect(page.locator('[role=dialog]')).toBeVisible({ timeout: 10_000 });
}

function dialogCombobox(
  page: import('@playwright/test').Page,
  index: number
) {
  return page.locator('[role=dialog] button[role=combobox]').nth(index);
}

async function pickOption(
  page: import('@playwright/test').Page,
  trigger: import('@playwright/test').Locator,
  optionRegex: RegExp
) {
  await trigger.click();
  await page
    .locator('[role=option]')
    .filter({ hasText: optionRegex })
    .first()
    .click();
}

async function readTriggerLabel(
  trigger: import('@playwright/test').Locator
): Promise<string> {
  return (await trigger.innerText()).trim();
}

async function readOptionLabels(
  page: import('@playwright/test').Page,
  trigger: import('@playwright/test').Locator
): Promise<string[]> {
  await trigger.click();
  const opts = page.locator('[role=option]');
  await expect(opts.first()).toBeVisible({ timeout: 5_000 });
  const count = await opts.count();
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    labels.push((await opts.nth(i).innerText()).trim());
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('[role=option]').first()).not.toBeVisible({
    timeout: 5_000
  });
  return labels;
}

async function fillCommon(
  page: import('@playwright/test').Page,
  name: string,
  amount: number
) {
  await page.locator('[role=dialog] input#name').fill(name);
  await page.locator('[role=dialog] input#amount').fill(String(amount));
}

async function clickSave(
  page: import('@playwright/test').Page,
  buttonRegex: RegExp = /^(Add|Update|Προσθήκη|Ενημέρωση|Αποθήκευση)$/
) {
  await page
    .locator('[role=dialog]')
    .getByRole('button', { name: buttonRegex })
    .click();
}

async function waitDialogClosed(page: import('@playwright/test').Page) {
  await expect(page.locator('[role=dialog]')).toBeHidden({ timeout: 15_000 });
}

function failOnExpenseWrite(
  page: import('@playwright/test').Page,
  buildingId: string
) {
  const handler = (req: import('@playwright/test').Request) => {
    const url = req.url();
    const method = req.method();
    if (
      url.includes(`/api/v2/buildings/${buildingId}/expenses`) &&
      (method === 'POST' || method === 'PATCH')
    ) {
      throw new Error(
        `Client-side rejection regressed: ${method} ${url} fired when the form should have refused to submit.`
      );
    }
  };
  page.on('request', handler);
  return () => page.off('request', handler);
}

// The FULL per-type matrix from ExpenseFormDialog's ALLOCATION_METHODS_BY_TYPE.
//
// STALE-SPEC FIX (2026-07): this matrix is flag-BLIND, but the dialog gates the
// two feature-specific thousandths methods on the building's own flags —
// `heating_thousandths` needs hasCentralHeating, `elevator_thousandths` needs
// hasElevator (getAllocationMethodsForType, ExpenseFormDialog.js:286-295).
// Allocating by heating thousandths on a building with no central heating is
// meaningless, so the gating is correct and the spec was wrong: it demanded 7
// options for `heating` on the shared seed building (both flags false) where
// the dialog correctly offers 5. It had been failing since the gating shipped.
// `expectedMethodsFor()` below applies the same gating so the spec tracks the
// real contract, and 43.1b asserts the gating itself rather than ignoring it.
const EXPECTED_METHODS_BY_TYPE: Record<string, readonly string[]> = {
  heating: ['heating_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage', 'single_unit'],
  elevator: ['elevator_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage', 'single_unit'],
  cleaning: ['general_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage', 'single_unit'],
  water_common: ['general_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage', 'single_unit'],
  electricity_common: ['general_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage', 'single_unit'],
  insurance: ['general_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage', 'single_unit'],
  management_fee: ['general_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage', 'single_unit'],
  garden: ['general_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage', 'single_unit'],
  repairs_fund: ['general_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage', 'single_unit'],
  pest_control: ['general_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage', 'single_unit'],
  other: ['general_thousandths', 'heating_thousandths', 'elevator_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage', 'single_unit']
};

/**
 * The methods the dialog actually offers for `typeId` — i.e.
 * EXPECTED_METHODS_BY_TYPE minus everything getAllocationMethodsForType()
 * filters out. THREE gates, all mirrored here:
 *   1. hasCentralHeating absent → no heating_thousandths
 *   2. hasElevator absent       → no elevator_thousandths
 *   3. isVariable (recurring AND amount 0, i.e. a κυμαινόμενο expense whose
 *      total the landlord types each month) → no `fixed`, because fixed means
 *      absolute per-unit amounts that cannot track a changing total.
 * Gate 3 bites in the dropdown-matrix test specifically: it never fills an
 * amount, so the dialog's default (recurring, amount 0) IS variable.
 */
function expectedMethodsFor(
  typeId: string,
  flags: {
    hasElevator?: boolean;
    hasCentralHeating?: boolean;
    isVariable?: boolean;
  }
): readonly string[] {
  return (EXPECTED_METHODS_BY_TYPE[typeId] ?? []).filter((m) => {
    if (m === 'heating_thousandths') return !!flags.hasCentralHeating;
    if (m === 'elevator_thousandths') return !!flags.hasElevator;
    if (m === 'fixed') return !flags.isVariable;
    return true;
  });
}

const TYPE_LABEL_REGEX: Record<string, RegExp> = {
  heating: /^(Heating|Θέρμανση)$/,
  elevator: /^(Elevator|Ασανσέρ)$/,
  cleaning: /^(Cleaning|Καθαριότητα)$/,
  water_common: /^(Water Common|Κοινόχρηστο Νερό)$/,
  electricity_common: /^(Electricity Common|Κοινόχρηστο Ρεύμα)$/,
  insurance: /^(Insurance|Ασφάλεια|Ασφάλιση)$/,
  management_fee: /^(Management Fee|Αμοιβή Διαχείρισης)$/,
  garden: /^(Garden|Κήπος)$/,
  repairs_fund: /^(Repairs Fund|Ταμείο Επισκευών)$/,
  pest_control: /^(Pest Control|Απεντόμωση)$/,
  other: /^(Other|Λοιπά|Άλλο|Άλλα)$/
};

const METHOD_LABEL_REGEX: Record<string, RegExp> = {
  general_thousandths: /^(General Thousandths|Γενικά Χιλιοστά)$/,
  heating_thousandths: /^(Heating Thousandths|Χιλιοστά Θέρμανσης)$/,
  elevator_thousandths: /^(Elevator Thousandths|Χιλιοστά Ανελκυστήρα)$/,
  equal: /^(Equal|Ισομερής)$/,
  by_surface: /^(By Surface|Κατά Επιφάνεια)$/,
  fixed: /^(Fixed|Σταθερό)$/,
  custom_ratio: /^(Custom Ratio|Προσαρμοσμένη Αναλογία)$/,
  custom_percentage: /^(Custom Percentage|Προσαρμοσμένο Ποσοστό)$/,
  single_unit: /^(Single Unit|Συγκεκριμένη μονάδα)$/
};

async function cleanupExpense(
  apiCtx: import('@playwright/test').APIRequestContext,
  seed: { token: string; realmId: string; buildingId: string },
  expenseId: string
) {
  const headers = {
    Authorization: `Bearer ${seed.token}`,
    'Content-Type': 'application/json',
    organizationid: seed.realmId
  };
  await apiCtx
    .delete(
      `${GATEWAY}/api/v2/buildings/${seed.buildingId}/expenses/${expenseId}`,
      { headers }
    )
    .catch(() => undefined);
}

async function findExpenseIdByName(
  apiCtx: import('@playwright/test').APIRequestContext,
  seed: { token: string; realmId: string; buildingId: string },
  name: string
): Promise<string | null> {
  const headers = {
    Authorization: `Bearer ${seed.token}`,
    organizationid: seed.realmId
  };
  const r = await apiCtx.get(
    `${GATEWAY}/api/v2/buildings/${seed.buildingId}`,
    { headers }
  );
  if (r.status() !== 200) return null;
  const b = (await r.json()) as {
    expenses?: Array<{ _id: string; name: string }>;
  };
  const e = (b.expenses || []).reverse().find((e) => e.name === name);
  return e?._id || null;
}

test('43.1 · for each of 11 expense types, allocation-method dropdown lists the correct subset', async ({ page }) => {
  test.setTimeout(240_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  // Read the building's real feature flags — the dialog gates
  // heating_thousandths/elevator_thousandths on them, so the expected set is
  // flag-dependent. Asserting a flag-blind matrix is what made this spec fail
  // from the day the gating shipped.
  const bResp = await apiCtx.get(
    `${GATEWAY}/api/v2/buildings/${seed.buildingId}`,
    { headers: { Authorization: `Bearer ${seed.token}`, organizationid: seed.realmId } }
  );
  expect(bResp.status(), 'read building flags').toBe(200);
  const bJson = (await bResp.json()) as {
    hasElevator?: boolean;
    hasCentralHeating?: boolean;
  };
  const flags = {
    hasElevator: !!bJson.hasElevator,
    hasCentralHeating: !!bJson.hasCentralHeating,
    // This test never fills an amount, so the dialog sits at its default
    // (isRecurring=true, amount=0) → a κυμαινόμενο expense → `fixed` is
    // correctly withheld. Stated explicitly so the expectation is legible.
    isVariable: true
  };
  await apiCtx.dispose();

  await signIn(page);
  await gotoExpensesTab(page, seed.realmName, seed.buildingId);
  await openAddDialog(page);

  for (const typeId of Object.keys(EXPECTED_METHODS_BY_TYPE)) {
    const expectedMethods = expectedMethodsFor(typeId, flags);
    await pickOption(page, dialogCombobox(page, 0), TYPE_LABEL_REGEX[typeId]);
    const labels = await readOptionLabels(page, dialogCombobox(page, 1));

    expect(
      labels.length,
      `type=${typeId} dropdown count (flags: elevator=${flags.hasElevator}, centralHeating=${flags.hasCentralHeating})`
    ).toBe(expectedMethods.length);
    for (const m of expectedMethods) {
      expect(labels.some((l) => METHOD_LABEL_REGEX[m].test(l)), `type=${typeId} method ${m} present`).toBe(true);
    }
    const allMethods = Object.keys(METHOD_LABEL_REGEX);
    for (const m of allMethods.filter((x) => !expectedMethods.includes(x))) {
      expect(labels.some((l) => METHOD_LABEL_REGEX[m].test(l)), `type=${typeId} forbidden method ${m} absent`).toBe(false);
    }
  }
  await page.keyboard.press('Escape');
});

test('43.1b · building feature flags GATE the thousandths methods (both directions)', async ({
  page
}) => {
  // The gating 43.1 now accounts for, asserted head-on: flipping
  // hasCentralHeating/hasElevator must add/remove exactly the corresponding
  // thousandths option. Without this, 43.1 could be satisfied by a dialog that
  // dropped those methods unconditionally.
  test.setTimeout(240_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  const headers = {
    Authorization: `Bearer ${seed.token}`,
    organizationid: seed.realmId
  };
  const url = `${GATEWAY}/api/v2/buildings/${seed.buildingId}`;
  const before = (await (await apiCtx.get(url, { headers })).json()) as {
    hasElevator?: boolean;
    hasCentralHeating?: boolean;
    __v?: number;
  };

  const setFlags = async (hasCentralHeating: boolean, hasElevator: boolean) => {
    const cur = (await (await apiCtx.get(url, { headers })).json()) as {
      __v?: number;
    };
    const r = await apiCtx.patch(url, {
      headers,
      data: { hasCentralHeating, hasElevator, __v: cur.__v }
    });
    expect(
      r.status(),
      `PATCH flags heating=${hasCentralHeating} elevator=${hasElevator} (body: ${await r.text().catch(() => '')})`
    ).toBe(200);
  };

  const optionsForHeating = async () => {
    // gotoExpensesTab does a full page.goto, which is enough to pick up the
    // flag change. An extra page.reload() here bounced the session to
    // /landlord/signin and hung on [data-cy=expensesTab].
    await gotoExpensesTab(page, seed.realmName, seed.buildingId);
    await openAddDialog(page);
    await pickOption(page, dialogCombobox(page, 0), TYPE_LABEL_REGEX.heating);
    const labels = await readOptionLabels(page, dialogCombobox(page, 1));
    await page.keyboard.press('Escape');
    return labels;
  };

  try {
    await signIn(page);

    // OFF → heating_thousandths must be absent.
    await setFlags(false, false);
    const off = await optionsForHeating();
    expect(
      off.some((l) => METHOD_LABEL_REGEX.heating_thousandths.test(l)),
      'no central heating → «Χιλιοστά Θέρμανσης» must NOT be offered'
    ).toBe(false);

    // ON → it must appear, and nothing else may change.
    await setFlags(true, false);
    const on = await optionsForHeating();
    expect(
      on.some((l) => METHOD_LABEL_REGEX.heating_thousandths.test(l)),
      'central heating ON → «Χιλιοστά Θέρμανσης» must be offered'
    ).toBe(true);
    expect(
      on.length,
      'flipping the flag adds exactly ONE option'
    ).toBe(off.length + 1);
  } finally {
    // Restore the shared seed exactly as found — this realm is shared by every
    // other spec in the suite.
    await setFlags(!!before.hasCentralHeating, !!before.hasElevator).catch(
      () => {}
    );
    await apiCtx.dispose();
  }
});

test('43.2 · save round-trip for each of 9 allocation methods (server 200 + reopen pre-selects method)', async ({ page }) => {
  test.setTimeout(360_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  // This spec round-trips ALL 9 methods, and two of them are gated on building
  // feature flags (heating_thousandths ← hasCentralHeating, elevator_thousandths
  // ← hasElevator; ExpenseFormDialog getAllocationMethodsForType). The shared
  // seed has both flags false, so the dropdown legitimately does not offer them
  // and this spec used to hang for 15s on «Χιλιοστά Θέρμανσης». Enable both for
  // the duration and restore them in the finally — the realm is shared.
  const _bHeaders = {
    Authorization: `Bearer ${seed.token}`,
    organizationid: seed.realmId
  };
  const _bUrl = `${GATEWAY}/api/v2/buildings/${seed.buildingId}`;
  const _flagsBefore = (await (
    await apiCtx.get(_bUrl, { headers: _bHeaders })
  ).json()) as { hasElevator?: boolean; hasCentralHeating?: boolean };
  const _setFlags = async (heating: boolean, elevator: boolean) => {
    const cur = (await (
      await apiCtx.get(_bUrl, { headers: _bHeaders })
    ).json()) as { __v?: number };
    const r = await apiCtx.patch(_bUrl, {
      headers: _bHeaders,
      data: {
        hasCentralHeating: heating,
        hasElevator: elevator,
        __v: cur.__v
      }
    });
    expect(
      r.status(),
      `PATCH building flags (body: ${await r.text().catch(() => '')})`
    ).toBe(200);
  };
  await _setFlags(true, true);

  await signIn(page);
  await gotoExpensesTab(page, seed.realmName, seed.buildingId);

  const allMethods = ['general_thousandths', 'heating_thousandths', 'elevator_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage', 'single_unit'] as const;
  const createdIds: string[] = [];
  try {
    for (const method of allMethods) {
      const name = `E2E-Round1-${method}-${Date.now()}`;
      await openAddDialog(page);
      await fillCommon(page, name, 60);

      const typeForMethod = method === 'heating_thousandths' ? 'heating' : method === 'elevator_thousandths' ? 'elevator' : 'other';
      await pickOption(page, dialogCombobox(page, 0), TYPE_LABEL_REGEX[typeForMethod]);
      await pickOption(page, dialogCombobox(page, 1), METHOD_LABEL_REGEX[method]);

      if (method === 'custom_percentage' || method === 'custom_ratio' || method === 'fixed') {
        const valueInput = page.locator('[role=dialog] input[name="customAllocations.0.value"]');
        await expect(valueInput).toBeVisible({ timeout: 5_000 });
        const v = method === 'custom_percentage' ? 100 : method === 'custom_ratio' ? 1 : 60;
        await valueInput.fill(String(v));
      }
      if (method === 'single_unit') {
        await dialogCombobox(page, 2).click();
        await page.locator('[role=option]').first().click();
      }

      const postPromise = page.waitForResponse(
        (r) => r.url().includes(`/api/v2/buildings/${seed.buildingId}/expenses`) && r.request().method() === 'POST',
        { timeout: 20_000 }
      );
      await clickSave(page);
      const postResp = await postPromise;
      expect(
        postResp.status(),
        `POST status for ${method} (resp=${(await postResp.text().catch(() => '')).slice(0, 200)})`
      ).toBe(200);
      await waitDialogClosed(page);

      const row = page.locator('tr', { has: page.locator('td', { hasText: name }) });
      await expect(row).toBeVisible({ timeout: 10_000 });
      // Anchor on the Edit aria-label so we don't accidentally click
      // Delete (row has 2+ buttons). The realm renders el for the bot
      // account but URL doesn't carry the /el/ prefix → button reads
      // English "Edit". Accept both for portability.
      await row
        .locator('button[aria-label="Edit"], button[aria-label="Επεξεργασία"]')
        .first()
        .click();
      await expect(page.locator('[role=dialog]')).toBeVisible({ timeout: 10_000 });
      // The form needs a tick to populate via the `values: expense ? {...}`
      // RHF reset path. Wait for the Allocation Method trigger to show
      // the persisted method (not the placeholder) before reading.
      await expect
        .poll(() => readTriggerLabel(dialogCombobox(page, 1)), { timeout: 8_000 })
        .toMatch(METHOD_LABEL_REGEX[method]);
      const methodLabel = await readTriggerLabel(dialogCombobox(page, 1));
      expect(methodLabel).toMatch(METHOD_LABEL_REGEX[method]);
      await page.locator('[role=dialog]').getByRole('button', { name: /^(Cancel|Άκυρο)$/ }).click();
      await waitDialogClosed(page);

      const id = await findExpenseIdByName(apiCtx, seed, name);
      if (id) createdIds.push(id);
    }
  } finally {
    for (const id of createdIds) await cleanupExpense(apiCtx, seed, id);
    // Restore the building's feature flags exactly as found — leaving them ON
    // would change the dropdown contents for every later spec in the realm
    // (43.1 reads them, so a leak there would silently pass for the wrong
    // reason).
    await _setFlags(
      !!_flagsBefore.hasCentralHeating,
      !!_flagsBefore.hasElevator
    ).catch(() => {});
    await apiCtx.dispose();
  }
});

test('43.3 · F4-expense · single_unit save without picked unit fails client-side', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  await apiCtx.dispose();
  await signIn(page);
  await gotoExpensesTab(page, seed.realmName, seed.buildingId);

  const detach = failOnExpenseWrite(page, seed.buildingId);
  try {
    await openAddDialog(page);
    await fillCommon(page, `E2E-Round1-F4-${Date.now()}`, 50);
    await pickOption(page, dialogCombobox(page, 0), TYPE_LABEL_REGEX.other);
    await pickOption(page, dialogCombobox(page, 1), METHOD_LABEL_REGEX.single_unit);
    await clickSave(page);
    await expect(page.locator('[role=dialog] p.text-destructive').filter({ hasText: /Pick a unit to bill/ })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[role=dialog]')).toBeVisible();
  } finally {
    detach();
  }
});

test('43.4 · F2-expense · single_unit with target → 200, reopen pre-selects unit', async ({ page }) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  await signIn(page);
  await gotoExpensesTab(page, seed.realmName, seed.buildingId);

  const name = `E2E-Round1-F2-${Date.now()}`;
  let createdId: string | null = null;
  try {
    await openAddDialog(page);
    await fillCommon(page, name, 75);
    await pickOption(page, dialogCombobox(page, 0), TYPE_LABEL_REGEX.other);
    await pickOption(page, dialogCombobox(page, 1), METHOD_LABEL_REGEX.single_unit);

    await dialogCombobox(page, 2).click();
    const firstOpt = page.locator('[role=option]').first();
    await expect(firstOpt).toBeVisible({ timeout: 5_000 });
    const expectedUnitLabel = (await firstOpt.innerText()).trim();
    await firstOpt.click();

    const postPromise = page.waitForResponse(
      (r) => r.url().includes(`/api/v2/buildings/${seed.buildingId}/expenses`) && r.request().method() === 'POST'
    );
    await clickSave(page);
    expect((await postPromise).status()).toBe(200);
    await waitDialogClosed(page);

    const row = page.locator('tr', { has: page.locator('td', { hasText: name }) });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator('button').first().click();
    await expect(page.locator('[role=dialog]')).toBeVisible();
    expect(await readTriggerLabel(dialogCombobox(page, 2))).toBe(expectedUnitLabel);
    await page.locator('[role=dialog]').getByRole('button', { name: /^(Cancel|Άκυρο)$/ }).click();
    await waitDialogClosed(page);
    createdId = await findExpenseIdByName(apiCtx, seed, name);
  } finally {
    if (createdId) await cleanupExpense(apiCtx, seed, createdId);
    await apiCtx.dispose();
  }
});

test('43.5 · custom_percentage with rows summing to 99% fails client-side', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  await apiCtx.dispose();
  await signIn(page);
  await gotoExpensesTab(page, seed.realmName, seed.buildingId);
  const detach = failOnExpenseWrite(page, seed.buildingId);
  try {
    await openAddDialog(page);
    await fillCommon(page, `E2E-Round1-pct99-${Date.now()}`, 50);
    await pickOption(page, dialogCombobox(page, 0), TYPE_LABEL_REGEX.other);
    await pickOption(page, dialogCombobox(page, 1), METHOD_LABEL_REGEX.custom_percentage);
    await page.locator('[role=dialog] input[name="customAllocations.0.value"]').fill('99');
    await clickSave(page);
    await expect(page.locator('[role=dialog] p.text-destructive').filter({ hasText: /Percentages must sum to 100/i })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[role=dialog]')).toBeVisible();
  } finally {
    detach();
  }
});

test('43.6 · custom_ratio with all-zero rows fails client-side', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  await apiCtx.dispose();
  await signIn(page);
  await gotoExpensesTab(page, seed.realmName, seed.buildingId);
  const detach = failOnExpenseWrite(page, seed.buildingId);
  try {
    await openAddDialog(page);
    await fillCommon(page, `E2E-Round1-ratio0-${Date.now()}`, 50);
    await pickOption(page, dialogCombobox(page, 0), TYPE_LABEL_REGEX.other);
    await pickOption(page, dialogCombobox(page, 1), METHOD_LABEL_REGEX.custom_ratio);
    await clickSave(page);
    await expect(page.locator('[role=dialog] p.text-destructive').filter({ hasText: /At least one unit must have a non-zero ratio/i })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[role=dialog]')).toBeVisible();
  } finally {
    detach();
  }
});

test('43.7 · F6-expense · custom_percentage with empty customAllocations fails client-side', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeed(apiCtx);
  await apiCtx.dispose();
  await signIn(page);
  await gotoExpensesTab(page, seed.realmName, seed.buildingId);
  const detach = failOnExpenseWrite(page, seed.buildingId);
  try {
    await openAddDialog(page);
    await fillCommon(page, `E2E-Round1-F6-${Date.now()}`, 50);
    await pickOption(page, dialogCombobox(page, 0), TYPE_LABEL_REGEX.other);
    await pickOption(page, dialogCombobox(page, 1), METHOD_LABEL_REGEX.custom_percentage);
    await clickSave(page);
    // The invariant that matters: the form REFUSES to submit (failOnExpenseWrite
    // above throws on any POST) and says why. Which message appears depends on
    // whether the building has units:
    //   - units present → rows are seeded at value 0 → the sum branch fires
    //     («Percentages must sum to 100% (currently 0.0%)»)
    //   - no units       → customAllocations is [] → the length branch fires
    //     («Custom allocations require at least one positive entry»)
    // This spec used to demand ONLY the second message while seeding a building
    // that HAS a unit, so it could never pass. Accept either — both are the
    // guard working. 43.5 pins the sum message specifically.
    await expect(
      page
        .locator('[role=dialog] p.text-destructive')
        .filter({
          hasText:
            /Custom allocations require at least one positive entry|Percentages must sum to 100|Τα ποσοστά πρέπει να αθροίζουν/i
        })
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[role=dialog]')).toBeVisible();
  } finally {
    detach();
  }
});

test('43.8 · F5-expense · switching custom_percentage→single_unit resets customAllocations', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  await apiCtx.dispose();
  await signIn(page);
  await gotoExpensesTab(page, seed.realmName, seed.buildingId);
  const detach = failOnExpenseWrite(page, seed.buildingId);
  try {
    await openAddDialog(page);
    await fillCommon(page, `E2E-Round1-F5-${Date.now()}`, 50);
    await pickOption(page, dialogCombobox(page, 0), TYPE_LABEL_REGEX.other);
    await pickOption(page, dialogCombobox(page, 1), METHOD_LABEL_REGEX.custom_percentage);
    const v0 = page.locator('[role=dialog] input[name="customAllocations.0.value"]');
    await expect(v0).toBeVisible({ timeout: 5_000 });
    await v0.fill('100');
    await pickOption(page, dialogCombobox(page, 1), METHOD_LABEL_REGEX.single_unit);

    const unitLabel = await readTriggerLabel(dialogCombobox(page, 2));
    expect(unitLabel).toMatch(/Select a unit|Επιλέξτε μονάδα|Επιλέξτε|Select/i);
    await clickSave(page);
    await expect(page.locator('[role=dialog] p.text-destructive').filter({ hasText: /Pick a unit to bill/ })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[role=dialog]')).toBeVisible();
  } finally {
    detach();
  }
});

test('43.9 · isRecurring toggle exposes startFromCurrentMonth child input', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  await apiCtx.dispose();
  await signIn(page);
  await gotoExpensesTab(page, seed.realmName, seed.buildingId);
  await openAddDialog(page);
  await fillCommon(page, `E2E-Round1-recurring-${Date.now()}`, 80);
  await pickOption(page, dialogCombobox(page, 0), TYPE_LABEL_REGEX.other);
  await expect(page.locator('[role=dialog] #startFromCurrentMonth')).toBeVisible({ timeout: 5_000 });
  await page.locator('[role=dialog] #isRecurring').click();
  await expect(page.locator('[role=dialog] #startFromCurrentMonth')).toHaveCount(0, { timeout: 3_000 });
  await page.locator('[role=dialog] #isRecurring').click();
  await expect(page.locator('[role=dialog] #startFromCurrentMonth')).toBeVisible({ timeout: 3_000 });
});

test('43.10 · trackOwnerExpense toggle exposes ownerAmount field with default 0', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  await apiCtx.dispose();
  await signIn(page);
  await gotoExpensesTab(page, seed.realmName, seed.buildingId);
  await openAddDialog(page);
  await expect(page.locator('[role=dialog] #ownerAmount')).toHaveCount(0, { timeout: 3_000 });
  await page.locator('[role=dialog] #trackOwnerExpense').click();
  const ownerAmount = page.locator('[role=dialog] #ownerAmount');
  await expect(ownerAmount).toBeVisible({ timeout: 3_000 });
  await expect(ownerAmount).toHaveValue('0');
});

test('43.11 · F3-expense · chargeOwnerWhenVacant Switch is ENABLED (vacant-owner billing shipped; no longer "coming soon")', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  await apiCtx.dispose();
  await signIn(page);
  await gotoExpensesTab(page, seed.realmName, seed.buildingId);
  await openAddDialog(page);
  const sw = page.locator('[role=dialog] #chargeOwnerWhenVacant');
  await expect(sw).toBeVisible({ timeout: 5_000 });
  // Vacant-owner billing SHIPPED (978bf92b → current). The Switch is now
  // ENABLED and the "coming soon" stub is gone. This spec previously asserted
  // the OPPOSITE and had been failing ever since the feature shipped — it was
  // never updated. Mirrors spec 41.11.
  await expect(sw).toBeEnabled();
  await expect(
    page
      .locator('[role=dialog] label[for="chargeOwnerWhenVacant"]')
      .filter({ hasText: /coming soon|σύντομα|συντομα/i })
  ).toHaveCount(0);
});

test('43.12 · edit existing expense round-trips fields; toggling trackOwnerExpense off resets ownerAmount=0 server-side', async ({ page }) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  const headers = {
    Authorization: `Bearer ${seed.token}`,
    'Content-Type': 'application/json',
    organizationid: seed.realmId
  };
  const name = `E2E-Round1-OwnerOff-${Date.now()}`;
  const created = await apiCtx.post(
    `${GATEWAY}/api/v2/buildings/${seed.buildingId}/expenses`,
    {
      headers,
      data: {
        name,
        type: 'other',
        amount: 70,
        allocationMethod: 'general_thousandths',
        isRecurring: true,
        trackOwnerExpense: true,
        ownerAmount: 42,
        startTerm: (() => {
          const d = new Date();
          return Number(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}0100`);
        })()
      }
    }
  );
  expect([200, 201]).toContain(created.status());
  const seedBody = (await created.json()) as { expenses: Array<{ _id: string; name: string }> };
  const expenseId = seedBody.expenses.find((e) => e.name === name)?._id;
  expect(expenseId).toBeTruthy();

  let cleanupId: string | undefined = expenseId;
  try {
    await signIn(page);
    await gotoExpensesTab(page, seed.realmName, seed.buildingId);
    const row = page.locator('tr', { has: page.locator('td', { hasText: name }) });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.locator('button').first().click();
    await expect(page.locator('[role=dialog]')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('[role=dialog] input#name')).toHaveValue(name);
    await expect(page.locator('[role=dialog] input#amount')).toHaveValue('70');
    await expect(page.locator('[role=dialog] input#ownerAmount')).toHaveValue('42');

    await page.locator('[role=dialog] #trackOwnerExpense').click();
    await expect(page.locator('[role=dialog] #ownerAmount')).toHaveCount(0, { timeout: 3_000 });

    const patchPromise = page.waitForResponse(
      (r) => r.url().includes(`/api/v2/buildings/${seed.buildingId}/expenses/${expenseId}`) && r.request().method() === 'PATCH'
    );
    await clickSave(page);
    expect((await patchPromise).status()).toBe(200);
    await waitDialogClosed(page);

    const after = await apiCtx.get(`${GATEWAY}/api/v2/buildings/${seed.buildingId}`, { headers });
    expect(after.status()).toBe(200);
    const body = (await after.json()) as { expenses?: Array<{ _id: string; name: string; ownerAmount?: number; trackOwnerExpense?: boolean }> };
    const persisted = (body.expenses || []).find((e) => e._id === expenseId);
    expect(persisted).toBeTruthy();
    expect(persisted!.trackOwnerExpense).toBe(false);
    expect(Number(persisted!.ownerAmount || 0)).toBe(0);
  } finally {
    if (cleanupId) await cleanupExpense(apiCtx, seed, cleanupId);
    await apiCtx.dispose();
  }
});
