/**
 * Spec 50 — owner-expenses paid/unpaid Overview tile + breakdown toggle.
 *
 * The user asked for a progress-bar tile under the income tile on the
 * building Overview showing owner expenses paid-vs-unpaid for the year, and
 * a way to mark each owner-side charge paid. This spec drives the REAL flow
 * on the deployed NAS:
 *   50.1 — the Overview renders the paid/unpaid progress tile with the
 *          correct "paid / total" figures from seeded owner-direct rows.
 *   50.2 — the tile is refetch-resilient (navigate away + back; value holds).
 *   50.3 — toggling a charge's paid checkbox in the Expenses → breakdown
 *          PATCHes the flag and the tile's paid total moves by that amount.
 *
 * Seeding: a dedicated building (unique name + fixed ids) inserted via mongo
 * with two owner-direct ownerMonthlyExpenses for the CURRENT term — one paid
 * (€200), one unpaid (€300). Total €500, paid €200. Dropped in afterAll.
 * Skips when portainer-token is absent (CI dry-run).
 */
import { expect, request, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mongoExec } from './lib/mongoExec';
import { getAccessToken } from './lib/api';

const ORG_NAME = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';
const REALM_NAME = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

const B_NAME = 'E2E-PaidTile-Building';
const BID = 'aa0000000000000000000050';
// Two owner-direct expense ids (source:'expense', not vacant) for the tile.
const EXP_PAID = 'aa00000000000000000005a1';
const EXP_UNPAID = 'aa00000000000000000005a2';

const PAID_AMOUNT = 200;
const UNPAID_AMOUNT = 300;
const TOTAL = PAID_AMOUNT + UNPAID_AMOUNT; // 500

const now = new Date();
const YEAR = now.getFullYear();
const MM = String(now.getMonth() + 1).padStart(2, '0');
const TERM = Number(`${YEAR}${MM}0100`);

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

function q(s: string) {
  return s.replace(/"/g, '\\"');
}

function seedBuilding() {
  return mongoExec(`
    var r = db.realms.findOne({name: "${q(ORG_NAME)}"});
    if (!r) { print("NO_REALM"); quit(); }
    var rid = String(r._id.valueOf());
    db.buildings.deleteOne({_id: ObjectId("${BID}")});
    db.buildings.insertOne({
      _id: ObjectId("${BID}"), realmId: rid, name: "${B_NAME}", atakPrefix: "E2E50",
      address: { street1: "T", city: "T", zipCode: "00000" },
      units: [
        { _id: ObjectId(), atakNumber: "E2E50-U1", isManaged: true, occupancyType: "rented", propertyId: "aa0000000000000000005101", generalThousandths: 1000, heatingThousandths: 0, elevatorThousandths: 0, surface: 60, monthlyCharges: [] }
      ],
      expenses: [
        { _id: ObjectId(), name: "E2E50-Cleaning", type: "cleaning", amount: 50, allocationMethod: "general_thousandths", isRecurring: true, startTerm: ${YEAR}010100, customAllocations: [], chargeOwnerWhenVacant: false }
      ],
      repairs: [],
      ownerMonthlyExpenses: [
        { _id: ObjectId(), expenseId: "${EXP_PAID}",   term: ${TERM}, amount: ${PAID_AMOUNT},   source: "expense", description: "E2E50-Insurance", paid: true,  paidDate: new Date() },
        { _id: ObjectId(), expenseId: "${EXP_UNPAID}", term: ${TERM}, amount: ${UNPAID_AMOUNT}, source: "expense", description: "E2E50-Management", paid: false, paidDate: null }
      ],
      createdDate: new Date(), updatedDate: new Date(), __v: 0
    });
    print(rid);
  `);
}

function readPaidTotal(): number | null {
  const out = mongoExec(`
    var b = db.buildings.findOne({_id: ObjectId("${BID}")});
    if (!b) { print("null"); quit(); }
    var s = 0;
    (b.ownerMonthlyExpenses||[]).forEach(function(e){ if (e.paid) s += (e.amount||0); });
    print(String(s));
  `);
  if (!out || out === 'null') return null;
  return Number(out);
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

async function openOverview(page: Page) {
  await page.goto(`${encodeURIComponent(REALM_NAME)}/buildings/${BID}`);
  const tab = page.locator('[data-cy=overviewTab]');
  await expect(tab, 'Overview tab present').toBeVisible({ timeout: 15_000 });
  await tab.click();
}

test.beforeAll(async () => {
  const probe = mongoExec('print("ok")');
  test.skip(probe === null, 'portainer-token absent — cannot reach NAS mongo');
  if (!TEST_EMAIL || !TEST_PASSWORD) throw new Error('Missing TEST creds');
  // Touch token to confirm auth works (and warm any first-call latency).
  const apiCtx = await request.newContext();
  await getAccessToken(apiCtx);
  await apiCtx.dispose();
  const raw = seedBuilding();
  const lastLine = String(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()!;
  const m = lastLine.match(/[a-f0-9]{24}/i);
  expect(m, `seed realmId hex not found (realm missing?): ${lastLine}`).toBeTruthy();
});

test.afterAll(async () => {
  mongoExec(`db.buildings.deleteOne({_id: ObjectId("${BID}")}); print("cleaned");`);
});

test('50.1 — Overview renders the owner paid/unpaid tile with correct paid/total (€200 / €500)', async ({
  page
}) => {
  await signIn(page);
  await openOverview(page);

  // The tile header is "Owner expenses paid" (el: "Πληρωμένα έξοδα ιδιοκτήτη").
  const tileHeader = page.getByText(
    /Owner expenses paid|Πληρωμένα έξοδα ιδιοκτήτη/
  );
  await expect(tileHeader, 'paid/unpaid tile header present').toBeVisible({
    timeout: 15_000
  });

  // The "paid / total" figure: 200 / 500. Locale formats the number; match
  // the digits with optional thousands/decimal separators around them.
  // Assert both the paid (200) and total (500) appear in the tile region.
  // The tile shows "200,00 € / 500,00 €" (paid / total), a progress bar, and
  // "Paid: 200,00 €" + "Outstanding: 300,00 €" footers. Assert on the footer
  // labels (unique to this tile) and the paid/total line — value-delta, not
  // existence. Locale formats with comma decimals (200,00) so match the
  // integer part with a flexible decimal tail.
  await expect(
    page.getByText(/Paid:\s*200([.,]\d+)?\s*€/),
    'tile shows Paid: 200 €'
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText(/Outstanding:\s*300([.,]\d+)?\s*€/),
    'tile shows Outstanding: 300 € (the unpaid €300 charge)'
  ).toBeVisible();
  // The paid/total headline "200,00 € / 500,00 €".
  await expect(
    page.getByText(/200([.,]\d+)?\s*€\s*\/\s*500([.,]\d+)?\s*€/),
    'tile shows 200 / 500 headline'
  ).toBeVisible();
});

test('50.2 — the tile value is refetch-resilient (navigate away + back)', async ({
  page
}) => {
  await signIn(page);
  await openOverview(page);
  await expect(
    page.getByText(/Owner expenses paid|Πληρωμένα έξοδα ιδιοκτήτη/)
  ).toBeVisible({ timeout: 15_000 });

  // Navigate away to the buildings list, then back. The value must re-render
  // identically (not a one-shot artifact).
  await page.goto(`${encodeURIComponent(REALM_NAME)}/buildings`);
  await page.waitForTimeout(1000);
  await openOverview(page);

  // Same value after the round-trip — not a one-shot render artifact.
  await expect(page.getByText(/Paid:\s*200([.,]\d+)?\s*€/)).toBeVisible({
    timeout: 15_000
  });
  await expect(
    page.getByText(/Outstanding:\s*300([.,]\d+)?\s*€/)
  ).toBeVisible();
});

test('50.3 — marking the unpaid charge paid in the breakdown moves the tile to €500 / €500', async ({
  page
}) => {
  // Drive the real toggle: Expenses tab → breakdown → check the unpaid row's
  // paid box. The PATCH /owner-expense/:id/paid must flip the flag, and the
  // Overview tile must then show paid == total (€500).
  await signIn(page);
  await page.goto(`${encodeURIComponent(REALM_NAME)}/buildings/${BID}`);
  const expTab = page.locator('[data-cy=expensesTab]');
  await expect(expTab).toBeVisible({ timeout: 15_000 });
  await expTab.click();

  // The breakdown's owner-direct section lists E2E50-Management (unpaid) with
  // a checkbox. Find the row and its checkbox.
  const mgmtRow = page
    .locator('label')
    .filter({ hasText: 'E2E50-Management' })
    .first();
  // The breakdown only renders when the term has owner-direct rows; the
  // current term does. Wait for it.
  await expect(mgmtRow, 'unpaid owner-direct row visible in breakdown').toBeVisible({
    timeout: 15_000
  });

  const before = readPaidTotal();
  expect(before, 'paid total readable before toggle').toBe(PAID_AMOUNT);

  // Click the checkbox inside the management row.
  await mgmtRow.locator('button[role="checkbox"], input[type="checkbox"]').first().click();

  // Wait for the PATCH to round-trip and the mongo flag to flip.
  await expect
    .poll(() => readPaidTotal(), { timeout: 15_000, intervals: [500, 1000, 2000] })
    .toBe(TOTAL);

  // Now the Overview tile must show paid == total (500 / 500) and the
  // outstanding footer must read €0 — the €300 charge is no longer unpaid.
  await openOverview(page);
  await expect(
    page.getByText(/Paid:\s*500([.,]\d+)?\s*€/),
    'after toggle, Paid: 500 €'
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(/Outstanding:\s*0([.,]\d+)?\s*€/),
    'after toggle, Outstanding: 0 €'
  ).toBeVisible();
});
