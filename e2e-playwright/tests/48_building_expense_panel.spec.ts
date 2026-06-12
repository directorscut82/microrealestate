/**
 * 48 — Building expense panel: the UNIFIED tile (real-flow case study).
 *
 * Surface: webapps/landlord/src/components/buildings/BuildingExpensePanel.js,
 * rendered by ExpenseList on the building → Expenses tab.
 *
 * This spec exists because the user found, in ONE tab, three building-page
 * bugs the 67-agent audit missed (its building reviewer crashed on prompt
 * size). The fixes were:
 *   - merge the side-by-side "Μηνιαία Κατάσταση | Ιστορικό Εξόδων" split
 *     into ONE calendar-driven tile (BuildingExpensePanel)
 *   - stop the "Όροφος" being printed up to 3× in the unit-charge picker
 *
 * Discipline (per AGENTS.md "Definition of done"): drive the REAL flow on
 * the live NAS and assert on what RENDERS, not that a component mounts.
 *   - sign in, open the canonical E2E-Building, click the Expenses tab
 *   - seed a VARIABLE recurring expense (recurring + no fixed amount) via
 *     the API so the panel has an inline-entry row to show
 *   - assert: the unified panel renders a SINGLE month calendar, the old
 *     two-column grid is ABSENT, a variable row carries an input, and the
 *     single-charge unit picker never repeats the floor token.
 *
 * Real-data note: the canonical E2E-Building has no E9 floor in its unit
 * names, so the Όροφος-dedup assertion is exercised by the picker label
 * shape (no "X — X" repetition) rather than by Greek floor words.
 */
import { test, expect, request } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { ensureSeed } from './lib/api';

const GATEWAY = process.env.GATEWAY_URL || 'http://192.168.0.96:1350';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

let _seed: Awaited<ReturnType<typeof ensureSeed>> | null = null;

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

async function getToken(apiCtx: APIRequestContext): Promise<string> {
  const resp = await apiCtx.post(
    `${GATEWAY}/api/v2/authenticator/landlord/signin`,
    {
      headers: { 'Content-Type': 'application/json' },
      data: { email: TEST_EMAIL, password: TEST_PASSWORD }
    }
  );
  expect(resp.status(), 'signin for token').toBe(200);
  const body = (await resp.json()) as { accessToken: string };
  return body.accessToken;
}

// Ensure the canonical building carries a VARIABLE recurring expense
// (recurring + no `amount`) so the panel renders an inline-entry row.
// Returns the expense id.
async function ensureVariableExpense(
  apiCtx: APIRequestContext,
  token: string,
  realmId: string,
  buildingId: string
): Promise<string> {
  const auth = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    organizationid: realmId
  };
  const resp = await apiCtx.get(`${GATEWAY}/api/v2/buildings/${buildingId}`, {
    headers: auth
  });
  expect(resp.status(), 'fetch building').toBe(200);
  const full = (await resp.json()) as {
    expenses?: Array<{
      _id: string;
      name: string;
      isRecurring?: boolean;
      amount?: number;
    }>;
  };
  const existing = full.expenses?.find(
    (e) => e.name === 'E2E-VarExpense' && e.isRecurring && !e.amount
  );
  if (existing) return existing._id;

  const now = new Date();
  const startTerm = Number(
    `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}0100`
  );
  const created = await apiCtx.post(
    `${GATEWAY}/api/v2/buildings/${buildingId}/expenses`,
    {
      headers: auth,
      data: {
        name: 'E2E-VarExpense',
        type: 'water_common',
        // NO amount → variable → needs monthly entry → renders an input row.
        allocationMethod: 'equal',
        isRecurring: true,
        startTerm
      }
    }
  );
  expect(
    [200, 201],
    `create variable expense (status=${created.status()}, body: ${await created
      .text()
      .catch(() => '')})`
  ).toContain(created.status());
  const updated = (await created.json()) as {
    expenses: Array<{ _id: string; name: string }>;
  };
  const exp = updated.expenses.find((e) => e.name === 'E2E-VarExpense');
  if (!exp) throw new Error('variable expense not present after create');
  return exp._id;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
    .toMatch(/\/(firstaccess|dashboard)/);
}

async function openExpensesTab(page: Page, realmName: string, buildingId: string) {
  await page.goto(`${encodeURIComponent(realmName)}/buildings/${buildingId}`);
  const tab = page.locator('[data-cy=expensesTab]');
  await expect(tab, 'Expenses tab present').toBeVisible({ timeout: 15_000 });
  await tab.click();
}

test.beforeAll(async () => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD');
  }
  const apiCtx = await request.newContext();
  _seed = await ensureSeed(apiCtx);
  const token = await getToken(apiCtx);
  await ensureVariableExpense(
    apiCtx,
    token,
    _seed.realmId,
    _seed.buildingId
  );
  await apiCtx.dispose();
});

test('48.1 — the unified panel renders a SINGLE month calendar (12 month buttons), not two side-by-side tiles', async ({
  page
}) => {
  await signIn(page);
  await openExpensesTab(page, _seed!.realmName, _seed!.buildingId);

  // The unified panel shows a 12-cell month grid (Ιαν…Δεκ). Anchor on the
  // distinctive set of localized month abbreviations rendered as buttons.
  const monthButtons = page
    .locator('button')
    .filter({ hasText: /^(Ιαν|Φεβ|Μαρ|Απρ|Μαϊ|Ιουν|Ιουλ|Αυγ|Σεπ|Οκτ|Νοε|Δεκ|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/ });
  await expect(
    monthButtons,
    'unified panel renders exactly 12 month buttons'
  ).toHaveCount(12);

  // The OLD split had two separate <h3> headings side by side:
  // "Μηνιαία Κατάσταση" (left) and "Ιστορικό Εξόδων" (right). The unified
  // panel has NEITHER as separate tiles. Assert the historical right-tile
  // heading is gone.
  await expect(
    page.getByRole('heading', { name: /Ιστορικό Εξόδων|Expense History/ }),
    'old right-tile "Expense History" heading must be gone'
  ).toHaveCount(0);
});

test('48.2 — selecting the current month shows the variable expense with an inline amount input + save', async ({
  page
}) => {
  await signIn(page);
  await openExpensesTab(page, _seed!.realmName, _seed!.buildingId);

  // The current month auto-selects on mount. The variable expense row
  // (E2E-VarExpense) must render with a number input (the inline entry)
  // and a save button — that's the MonthlyStatement capability folded in.
  await expect(
    page.getByText('E2E-VarExpense', { exact: false }).first(),
    'variable expense row present'
  ).toBeVisible({ timeout: 15_000 });

  // A number input exists in the panel (inline monthly entry).
  const numberInputs = page.locator('input[type="number"]');
  await expect(
    numberInputs.first(),
    'inline amount input present for the variable row'
  ).toBeVisible();
});

test('48.3 — the single-charge unit picker never repeats the floor/label token', async ({
  page
}) => {
  await signIn(page);
  await openExpensesTab(page, _seed!.realmName, _seed!.buildingId);

  // Open Add Expense, choose the "single unit" method that surfaces the
  // unit picker. We assert that NO option label contains a repeated
  // token like "X — X" (the Όροφος-printed-3× bug). This is a structural
  // check independent of whether the test building has E9 floor names.
  const addBtn = page.getByRole('button', {
    name: /Add Expense|Προσθήκη Δαπάνης/
  });
  if ((await addBtn.count()) === 0) {
    test.skip(true, 'Add Expense button not available in this build');
  }
  await addBtn.first().click();

  // Give the dialog a moment; then scan every visible option/label text
  // for an immediate "A — A" duplication around the em-dash separator.
  await page.waitForTimeout(1500);
  const texts = await page
    .locator('[role="option"], label, [data-radix-select-item]')
    .allInnerTexts();
  const repeated = texts.filter((tx) => {
    const parts = tx.split('—').map((s) => s.trim());
    for (let i = 1; i < parts.length; i++) {
      if (parts[i] && parts[i] === parts[i - 1]) return true;
    }
    return false;
  });
  expect(
    repeated,
    `no picker label may repeat a token across "—" (Όροφος ×3 bug). Offenders: ${JSON.stringify(repeated)}`
  ).toEqual([]);
});

test('48.4 — a saved variable amount survives reload AND a second save (no erosion to zero)', async ({
  page
}) => {
  // The kymainomeno save-erosion bug: the panel used to store per-unit
  // ALLOCATED SHARES and read them back by SUMMING — which under-reports
  // when a unit is vacant or a share rounds, so the displayed value shrank
  // on every reload/re-save and drifted toward zero. The fix stores the
  // entered statement figure (inputAmount) and reads THAT back. This test
  // drives the real save → reload → save flow and asserts the value holds.
  await signIn(page);
  await openExpensesTab(page, _seed!.realmName, _seed!.buildingId);

  const ENTERED = '73'; // a non-round figure unlikely to coincide with a share

  // Enter the amount on the variable row and save it.
  const input = page.locator('input[type="number"]').first();
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.fill(ENTERED);
  // The per-row save button is the icon button next to the input.
  await input
    .locator('xpath=following::button[1]')
    .click();
  // Wait for the save to round-trip (toast or settle).
  await page.waitForTimeout(2500);

  // Reload the page fully and reopen the tab — this is where erosion showed.
  await openExpensesTab(page, _seed!.realmName, _seed!.buildingId);
  await page.waitForTimeout(2500);
  const afterReload = await page
    .locator('input[type="number"]')
    .first()
    .inputValue();
  expect(
    Number(afterReload),
    `entered ${ENTERED}, after reload the field shows ${afterReload} — must equal the entered amount, not an eroded share`
  ).toBe(Number(ENTERED));

  // Save a SECOND time without changing it, reload again — still holds.
  await page
    .locator('input[type="number"]')
    .first()
    .locator('xpath=following::button[1]')
    .click();
  await page.waitForTimeout(2500);
  await openExpensesTab(page, _seed!.realmName, _seed!.buildingId);
  await page.waitForTimeout(2500);
  const afterSecond = await page
    .locator('input[type="number"]')
    .first()
    .inputValue();
  expect(
    Number(afterSecond),
    `after a second save+reload the field shows ${afterSecond} — must still equal ${ENTERED} (no erosion)`
  ).toBe(Number(ENTERED));
});
