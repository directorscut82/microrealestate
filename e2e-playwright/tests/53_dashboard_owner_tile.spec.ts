/**
 * Spec 53 — main dashboard owner-expenses tile (Batch 2 SB4).
 *
 *   53.1 — with a seeded current-year owner charge, the main dashboard renders
 *          the "Owner expenses paid" tile with the right paid/total figures.
 *
 * Seeds a dedicated building with a current-year owner charge (€200, of which
 * €50 paid via a καταβολή) and drops it in afterAll. Skips without
 * portainer-token.
 */
import { Page, expect, test } from '@playwright/test';
import { mongoExec } from './lib/mongoExec';

const REALM_NAME = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';
const TEST_EMAIL = process.env.TEST_EMAIL || '';
const TEST_PASSWORD = process.env.TEST_PASSWORD || '';

const B_NAME = 'E2E-DashOwner-Building';
const BID = 'aa0000000000000000000053';
const P1 = 'aa0000000000000000005301';
const EXP_A = 'aa00000000000000000053a1';
const YEAR = new Date().getFullYear();
const TERM = YEAR * 1000000 + 30100; // March this year

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

function q(s: string) {
  return s.replace(/"/g, '\\"');
}

function seed() {
  return mongoExec(`
    var r = db.realms.findOne({name: "${q(REALM_NAME)}"});
    if (!r) { print("NO_REALM"); quit(); }
    var rid = String(r._id.valueOf());
    db.buildings.deleteOne({_id: ObjectId("${BID}")});
    db.buildings.insertOne({
      _id: ObjectId("${BID}"), realmId: rid, name: "${B_NAME}", atakPrefix: "E2E53",
      address: { street1: "T", city: "T", zipCode: "00000" },
      units: [
        { _id: ObjectId(), atakNumber: "E2E53-U1", isManaged: true, occupancyType: "owner_occupied", propertyId: "${P1}", generalThousandths: 1000, surface: 60, monthlyCharges: [],
          owners: [{ type: "external", percentage: 100, name: "E2E53-Owner", taxId: "530000530" }] }
      ],
      expenses: [],
      ownerMonthlyExpenses: [
        { _id: ObjectId(), expenseId: "${EXP_A}", term: ${TERM}, amount: 200, source: "expense", description: "E2E53-Charge", paid: false, paidDate: null,
          payments: [{ date: new Date(${YEAR}, 2, 10), amount: 50, type: "transfer", reference: "" }] }
      ],
      createdDate: new Date(), updatedDate: new Date(), __v: 0
    });
    print(rid);
  `);
}

test.beforeAll(async () => {
  const probe = mongoExec('print("ok")');
  test.skip(probe === null, 'portainer-token absent');
  if (!TEST_EMAIL || !TEST_PASSWORD) throw new Error('missing TEST creds');
  const raw = seed();
  const lastLine = String(raw).split('\n').map((l) => l.trim()).filter(Boolean).pop()!;
  expect(lastLine).not.toBe('NO_REALM');
});

test.afterAll(async () => {
  mongoExec(`db.buildings.deleteOne({_id: ObjectId("${BID}")}); print("cleaned");`);
});

async function signIn(page: Page) {
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
    .toMatch(/\/(firstaccess|dashboard)/);
}

test('53.1 — dashboard owner-expenses tile shows paid/total (€50 / €200)', async ({
  page
}) => {
  await signIn(page);
  await page.goto(`${encodeURIComponent(REALM_NAME)}/dashboard`);
  await expect(page.locator('[data-cy=dashboardPage]')).toBeVisible({
    timeout: 25_000
  });
  // The owner-expenses tile header (el: "Πληρωμένα έξοδα ιδιοκτήτη").
  const tile = page
    .getByText(/Owner expenses paid|Πληρωμένα έξοδα ιδιοκτήτη/)
    .first();
  await expect(tile, 'owner-expenses tile present').toBeVisible({
    timeout: 15_000
  });
  // Paid 50 and total 200 appear (the seeded charge: €50 of €200 paid).
  await expect(
    page.getByText(/Paid:\s*50([.,]\d+)?\s*€/).first(),
    'tile shows Paid: 50 €'
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(/Outstanding:\s*150([.,]\d+)?\s*€/).first(),
    'tile shows Outstanding: 150 €'
  ).toBeVisible();
});
