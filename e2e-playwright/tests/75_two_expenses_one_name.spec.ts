/**
 * TWO EXPENSES OF ONE NAME, on the building page («Έξοδα» → «Μηνιαία Καταχώρηση»).
 *
 * A building where every apartment has its own electricity meter gets one expense per
 * apartment, each charged to its own apartment — and the bill import calls each of them
 * by the provider's name, so they are all «ΔΕΗ». Until 2026-11 the monthly entry matched
 * a stored figure to an expense by its id OR by its name: the figure typed for the first
 * apartment's «ΔΕΗ» was read back for the second one too. The second input showed «100»
 * although nothing had been typed for it, and because the page sends every figure of the
 * month with each save, the next save billed the second apartment's tenant 100 €.
 * Found by review on 24/11/2026.
 *
 * ONE BUILDING, TWO RENTED APARTMENTS, TWO EXPENSES WITH THE SAME NAME — each a monthly
 * figure charged to one apartment:
 *   1. 100 € is typed for the first and saved: the first tenant is charged 100 €;
 *   2. the page is opened again: the second input is BLANK (it showed «100»);
 *   3. the month is saved again as it stands: the second tenant is still charged nothing
 *      (100 € appeared on their rent);
 *   4. 60 € is typed for the second: opened again, the inputs say 100 and 60, and each
 *      tenant's rent carries their own figure.
 *
 * Self-cleaning: the tenants, the building and both apartments are removed before and
 * after the run. Every identifier is from the reserved synthetic bands.
 */
import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { ensureSeedLease, LeaseSeed } from './lib/api';
import {
  BillBuilding,
  createBillBuilding,
  createLedgerTenant,
  LedgerTenant,
  monthRef,
  openBuildingMonth,
  removeLedgerFixtures,
  serverAndBrowserAgreeOnTheMonth,
  signIn,
  tenantSharesFor
} from './lib/ledger';

const GATEWAY = process.env.GATEWAY_URL || 'http://192.168.0.96:1350';
const CURRENT = monthRef(0);
const F = {
  building: 'E2E-NAMESAKE',
  atakPrefix: '999751',
  expense: 'E2E-NAMESAKE ΔΕΗ',
  tenants: ['E2E-NAMESAKE-First', 'E2E-NAMESAKE-Second'],
  apartments: ['E2E-NAMESAKE-Apt1', 'E2E-NAMESAKE-Apt2']
};
const FIXTURES = {
  tenants: F.tenants,
  buildings: [F.building],
  properties: F.apartments
};
const FIRST = 100;
const SECOND = 60;

test.describe.configure({ timeout: 5 * 60_000 });

let seed: LeaseSeed;
let building: BillBuilding;
let first: LedgerTenant;
let second: LedgerTenant;
let secondExpenseId: string;

const headers = () => ({
  Authorization: `Bearer ${seed.token}`,
  organizationid: seed.realmId
});

/** The figures stored for this month, per expense: what each apartment is charged. */
async function storedFigures(
  api: APIRequestContext
): Promise<Record<string, number[]>> {
  const r = await api.get(
    `${GATEWAY}/api/v2/buildings/${building.buildingId}`,
    { headers: headers() }
  );
  expect(r.status(), 'the building').toBe(200);
  const units = ((await r.json()).units || []) as Array<{
    monthlyCharges?: Array<{
      term: number;
      expenseId?: string;
      amount: number;
    }>;
  }>;
  const out: Record<string, number[]> = {
    [building.expenseId]: [],
    [secondExpenseId]: []
  };
  for (const unit of units) {
    for (const c of unit.monthlyCharges || []) {
      if (Number(c.term) !== CURRENT.term) continue;
      (out[String(c.expenseId)] ||= []).push(Number(c.amount));
    }
  }
  return out;
}

const inputOf = (page: Page, expenseId: string) =>
  page.locator(
    `[data-cy=tenantExpenseRow][data-expense="${expenseId}"] input[type=number]`
  );

/** Type `amount` for one expense of the month and press its «Αποθήκευση». */
async function saveFigure(
  page: Page,
  expenseId: string,
  amount: number
): Promise<void> {
  await inputOf(page, expenseId).fill(String(amount));
  const saved = page.waitForResponse(
    (r) =>
      r.url().includes('/monthly-statement') && r.request().method() === 'POST',
    { timeout: 110_000 }
  );
  await page
    .locator(`[data-cy=tenantExpenseRow][data-expense="${expenseId}"]`)
    .getByRole('button', { name: 'Αποθήκευση' })
    .click();
  expect((await saved).status(), 'the month is saved').toBe(200);
}

test.beforeAll(async () => {
  test.setTimeout(5 * 60_000);
  test.skip(
    !serverAndBrowserAgreeOnTheMonth(),
    'Month boundary: the server (UTC) and the browser (local time) disagree on which month is current.'
  );
  if (!process.env.TEST_EMAIL || !process.env.TEST_PASSWORD) {
    throw new Error(
      'Missing TEST_EMAIL/TEST_PASSWORD. Expected .secrets/cypress-test-account.'
    );
  }
  const api = await request.newContext();
  seed = await ensureSeedLease(api);
  await removeLedgerFixtures(api, seed, FIXTURES);

  first = await createLedgerTenant(api, seed, {
    tenantName: F.tenants[0],
    propertyName: F.apartments[0],
    afmFirst8: '99900009',
    rent: 400,
    monthsBack: 1
  });
  second = await createLedgerTenant(api, seed, {
    tenantName: F.tenants[1],
    propertyName: F.apartments[1],
    afmFirst8: '99900010',
    rent: 400,
    monthsBack: 1
  });
  const own = (propertyId: string) => ({
    type: 'electricity_private',
    allocationMethod: 'single_unit',
    customAllocations: [{ propertyId, value: 100 }]
  });
  building = await createBillBuilding(api, seed, {
    name: F.building,
    atakPrefix: F.atakPrefix,
    propertyIds: [first.propertyId, second.propertyId],
    expenseName: F.expense,
    billingId: '999751001',
    startTerm: monthRef(-1).term,
    expenseExtra: own(first.propertyId)
  });
  // the second apartment's own «ΔΕΗ»: the same name
  const added = await api.post(
    `${GATEWAY}/api/v2/buildings/${building.buildingId}/expenses`,
    {
      headers: headers(),
      data: {
        name: F.expense,
        amount: 0,
        isVariable: true,
        isRecurring: true,
        startTerm: monthRef(-1).term,
        billingId: '999751002',
        ...own(second.propertyId)
      }
    }
  );
  expect(
    [200, 201],
    `the second expense: ${await added.text().catch(() => '')}`
  ).toContain(added.status());
  const sameName = (
    (await added.json()).expenses as Array<{ _id: string; name: string }>
  ).filter((e) => e.name === F.expense);
  expect(sameName, 'two expenses of one name').toHaveLength(2);
  secondExpenseId = sameName.find((e) => e._id !== building.expenseId)!._id;
  await api.dispose();
});

test.afterAll(async () => {
  if (!seed) return;
  const api = await request.newContext();
  await removeLedgerFixtures(api, seed, FIXTURES);
  await api.dispose();
});

test('a figure typed for one of two expenses with the same name is not the other one’s', async ({
  page
}) => {
  const api = await request.newContext();
  const open = () =>
    openBuildingMonth(page, seed.realmName, building.buildingId, CURRENT);
  const shares = () =>
    tenantSharesFor(api, seed, building.buildingId, CURRENT.term);
  await signIn(page);

  // ── 1. the first apartment's figure is typed ───────────────────────────────────
  await open();
  await expect(inputOf(page, building.expenseId)).toHaveValue('');
  await expect(inputOf(page, secondExpenseId)).toHaveValue('');
  await saveFigure(page, building.expenseId, FIRST);
  expect(await storedFigures(api), 'only the first has a figure').toEqual({
    [building.expenseId]: [FIRST],
    [secondExpenseId]: []
  });

  // ── 2. the page, opened again ──────────────────────────────────────────────────
  await open();
  await expect(inputOf(page, building.expenseId)).toHaveValue(String(FIRST));
  await expect(
    inputOf(page, secondExpenseId),
    'nothing was typed for the second: its input is blank'
  ).toHaveValue('');

  // ── 3. the month, saved again as it stands ─────────────────────────────────────
  await saveFigure(page, building.expenseId, FIRST);
  expect(
    await storedFigures(api),
    'saving the month again typed nothing for the second'
  ).toEqual({
    [building.expenseId]: [FIRST],
    [secondExpenseId]: []
  });
  expect(await shares(), 'who is charged what this month').toEqual({
    [F.tenants[0]]: FIRST
  });

  // ── 4. the second apartment's figure is typed ──────────────────────────────────
  await saveFigure(page, secondExpenseId, SECOND);
  await open();
  await expect(inputOf(page, building.expenseId)).toHaveValue(String(FIRST));
  await expect(
    inputOf(page, secondExpenseId),
    'the second shows its own figure'
  ).toHaveValue(String(SECOND));
  expect(await storedFigures(api), 'each has its own figure').toEqual({
    [building.expenseId]: [FIRST],
    [secondExpenseId]: [SECOND]
  });
  expect(await shares(), 'each tenant is charged their own figure').toEqual({
    [F.tenants[0]]: FIRST,
    [F.tenants[1]]: SECOND
  });
  await api.dispose();
});
