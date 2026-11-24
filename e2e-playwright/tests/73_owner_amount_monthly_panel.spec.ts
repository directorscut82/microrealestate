/**
 * THE OWNER AMOUNT OF A MONTH, on the building page («Έξοδα»).
 *
 * An expense that is also followed for the owners, with no fixed owner amount, has an
 * input under «Ιδιοκτήτες» where the month's owner amount can be typed. Until 2026-11 the
 * page pre-filled that input with the FIRST owner entry of the month that named the
 * expense — whatever it was. In a month with an empty apartment that entry is the
 * apartment's own share (the owner is charged for it), so the input showed a figure
 * nobody had entered, the «Ιδιοκτήτες» total was that much too high, and the next
 * «Αποθήκευση» sent it as the building's owner amount: new owner charges out of nothing.
 * Saved again, ONE of those per-apartment charges was read back as the amount, and so
 * on — less with every save. Found on a copy of the real data on 24/11/2026.
 *
 * ONE BUILDING, TWO APARTMENTS IN EQUAL SHARES — one rented, one EMPTY — and a heating
 * expense with a monthly figure, charged to the owner for an empty apartment:
 *   1. this month's heating is typed, 100 € → the empty apartment's 50 € is the owner's;
 *   2. the page is opened again: the owner amount is BLANK and «Ιδιοκτήτες» adds nothing
 *      (it showed «50», and 50 € more);
 *   3. the month is saved again as it stands: no owner amount has appeared (25 € per
 *      apartment did);
 *   4. an owner amount IS entered, 40 €: opened again, the input says 40 (it said one
 *      apartment's 20), and saving the month once more leaves 40 (it became 20, then 10).
 *
 * Self-cleaning: the tenant, the building and both apartments are removed before and
 * after the run. Every identifier is from the reserved synthetic bands.
 */
import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { ensureSeedLease, LeaseSeed } from './lib/api';
import {
  BillBuilding,
  createBillBuilding,
  createLedgerTenant,
  monthRef,
  openBuildingMonth,
  removeLedgerFixtures,
  serverAndBrowserAgreeOnTheMonth,
  signIn
} from './lib/ledger';

const GATEWAY = process.env.GATEWAY_URL || 'http://192.168.0.96:1350';
const CURRENT = monthRef(0);
const F = {
  building: 'E2E-OWNERAMT',
  atakPrefix: '999731',
  expense: 'E2E-OWNERAMT ΘΕΡΜΑΝΣΗ',
  tenant: 'E2E-OWNERAMT-Tenant',
  rented: 'E2E-OWNERAMT-AptRented',
  empty: 'E2E-OWNERAMT-AptEmpty'
};
const FIXTURES = {
  tenants: [F.tenant],
  buildings: [F.building],
  properties: [F.rented, F.empty]
};
const HEATING = 100;
const OWNER_AMOUNT = 40;

test.describe.configure({ timeout: 5 * 60_000 });

let seed: LeaseSeed;
let building: BillBuilding;

const headers = () => ({
  Authorization: `Bearer ${seed.token}`,
  organizationid: seed.realmId
});

/** The owner entries of this month that name the expense: `kind amount`, sorted. */
async function ownerEntries(api: APIRequestContext): Promise<string[]> {
  const r = await api.get(
    `${GATEWAY}/api/v2/buildings/${building.buildingId}`,
    {
      headers: headers()
    }
  );
  expect(r.status(), 'the building').toBe(200);
  const entries = ((await r.json()).ownerMonthlyExpenses || []) as Array<{
    term: number;
    expenseId: string;
    source?: string;
    amount: number;
  }>;
  return entries
    .filter(
      (e) =>
        Number(e.term) === CURRENT.term &&
        String(e.expenseId) === building.expenseId
    )
    .map((e) => `${e.source || 'expense'} ${e.amount}`)
    .sort();
}

const tenantRow = (page: Page) =>
  page.locator(
    `[data-cy=tenantExpenseRow][data-expense="${building.expenseId}"]`
  );
const ownerRow = (page: Page) =>
  page.locator(
    `[data-cy=ownerExpenseRow][data-expense="${building.expenseId}"]`
  );

/** Type `amount` in a row of the month and press its «Αποθήκευση». */
async function saveRow(
  page: Page,
  row: ReturnType<typeof tenantRow>,
  amount: number
): Promise<void> {
  await row.locator('input[type=number]').fill(String(amount));
  const saved = page.waitForResponse(
    (r) =>
      r.url().includes('/monthly-statement') && r.request().method() === 'POST',
    { timeout: 110_000 }
  );
  await row.getByRole('button', { name: 'Αποθήκευση' }).click();
  expect((await saved).status(), 'the month is saved').toBe(200);
}

/**
 * The page opened afresh on the month: the owner amount its input shows, and the
 * «Ιδιοκτήτες» total above it.
 */
async function reopened(
  page: Page,
  shows: { ownerAmount: string; ownersTotal: string },
  why: string
): Promise<void> {
  await openBuildingMonth(page, seed.realmName, building.buildingId, CURRENT);
  await expect(tenantRow(page).locator('input[type=number]')).toHaveValue(
    String(HEATING)
  );
  await expect(
    ownerRow(page).locator('input[type=number]'),
    `the owner amount: ${why}`
  ).toHaveValue(shows.ownerAmount);
  await expect(
    page.locator('[data-cy=ownersMonthTotal]'),
    `«Ιδιοκτήτες»: ${why}`
  ).toHaveText(shows.ownersTotal);
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

  const rented = await createLedgerTenant(api, seed, {
    tenantName: F.tenant,
    propertyName: F.rented,
    afmFirst8: '99900008',
    rent: 400,
    monthsBack: 1
  });
  const empty = await api.post(`${GATEWAY}/api/v2/properties`, {
    headers: headers(),
    data: {
      name: F.empty,
      type: 'apartment',
      price: 400,
      surface: 50,
      address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1', city: 'ΔΟΚΙΜΑΙ', zipCode: '00000' }
    }
  });
  expect([200, 201], 'the empty apartment').toContain(empty.status());
  building = await createBillBuilding(api, seed, {
    name: F.building,
    atakPrefix: F.atakPrefix,
    propertyIds: [rented.propertyId, (await empty.json())._id as string],
    expenseName: F.expense,
    billingId: '999731001',
    startTerm: monthRef(-1).term,
    expenseExtra: {
      type: 'heating',
      allocationMethod: 'equal',
      trackOwnerExpense: true,
      ownerAmount: 0,
      chargeOwnerWhenVacant: true
    }
  });
  await api.dispose();
});

test.afterAll(async () => {
  if (!seed) return;
  const api = await request.newContext();
  await removeLedgerFixtures(api, seed, FIXTURES);
  await api.dispose();
});

test('the owner amount of a month is what was entered for it: an empty apartment’s share is not it', async ({
  page
}) => {
  const api = await request.newContext();
  await signIn(page);

  // ── 1. this month's heating is typed ───────────────────────────────────────────
  await openBuildingMonth(page, seed.realmName, building.buildingId, CURRENT);
  await saveRow(page, tenantRow(page), HEATING);
  expect(
    await ownerEntries(api),
    'the empty apartment’s half is the owner’s; no owner amount was entered'
  ).toEqual([`vacant ${HEATING / 2}`]);

  // ── 2. the page, opened again ──────────────────────────────────────────────────
  await reopened(
    page,
    { ownerAmount: '', ownersTotal: '—' },
    'nothing was entered — an empty apartment’s share is not an owner amount'
  );

  // ── 3. the month, saved again as it stands ─────────────────────────────────────
  await saveRow(page, tenantRow(page), HEATING);
  expect(
    await ownerEntries(api),
    'saving the month again entered no owner amount'
  ).toEqual([`vacant ${HEATING / 2}`]);

  // ── 4. an owner amount IS entered ──────────────────────────────────────────────
  await saveRow(page, ownerRow(page), OWNER_AMOUNT);
  const entered = [
    `expense ${OWNER_AMOUNT / 2}`,
    `expense ${OWNER_AMOUNT / 2}`,
    `vacant ${HEATING / 2}`
  ];
  expect(
    await ownerEntries(api),
    'the owner amount, split over the two apartments'
  ).toEqual(entered);
  await reopened(
    page,
    {
      ownerAmount: String(OWNER_AMOUNT),
      ownersTotal: `${OWNER_AMOUNT.toFixed(2).replace('.', ',')} €`
    },
    'what was entered, not one apartment’s share of it'
  );
  await saveRow(page, tenantRow(page), HEATING);
  expect(
    await ownerEntries(api),
    'saved once more, the owner amount is still what was entered'
  ).toEqual(entered);
  await api.dispose();
});
