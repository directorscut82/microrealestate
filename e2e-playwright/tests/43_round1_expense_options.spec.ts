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
  await apiCtx.dispose();

  await signIn(page);
  await gotoExpensesTab(page, seed.realmName, seed.buildingId);
  await openAddDialog(page);

  for (const [typeId, expectedMethods] of Object.entries(EXPECTED_METHODS_BY_TYPE)) {
    await pickOption(page, dialogCombobox(page, 0), TYPE_LABEL_REGEX[typeId]);
    const labels = await readOptionLabels(page, dialogCombobox(page, 1));

    expect(labels.length, `type=${typeId} dropdown count`).toBe(expectedMethods.length);
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

test('43.2 · save round-trip for each of 9 allocation methods (server 200 + reopen pre-selects method)', async ({ page }) => {
  test.setTimeout(360_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
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
      await row.locator('button').first().click();
      await expect(page.locator('[role=dialog]')).toBeVisible({ timeout: 10_000 });
      const methodLabel = await readTriggerLabel(dialogCombobox(page, 1));
      expect(methodLabel).toMatch(METHOD_LABEL_REGEX[method]);
      await page.locator('[role=dialog]').getByRole('button', { name: /^(Cancel|Άκυρο)$/ }).click();
      await waitDialogClosed(page);

      const id = await findExpenseIdByName(apiCtx, seed, name);
      if (id) createdIds.push(id);
    }
  } finally {
    for (const id of createdIds) await cleanupExpense(apiCtx, seed, id);
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
    await expect(page.locator('[role=dialog] p.text-destructive').filter({ hasText: /Custom allocations require at least one positive entry/i })).toBeVisible({ timeout: 5_000 });
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

test('43.11 · F3-expense · chargeOwnerWhenVacant Switch is disabled with "coming soon" label', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  await apiCtx.dispose();
  await signIn(page);
  await gotoExpensesTab(page, seed.realmName, seed.buildingId);
  await openAddDialog(page);
  const sw = page.locator('[role=dialog] #chargeOwnerWhenVacant');
  await expect(sw).toBeVisible({ timeout: 5_000 });
  await expect(sw).toBeDisabled();
  await expect(page.locator('[role=dialog] label[for="chargeOwnerWhenVacant"]').filter({ hasText: /coming soon|σύντομα/i })).toBeVisible();
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
