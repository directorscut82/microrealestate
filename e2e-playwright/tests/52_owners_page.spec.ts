/**
 * Spec 52 — Owners page UI (Batch 2 SB2+SB3) driven in a real browser on NAS.
 *
 *   52.1 — the top-level Owners page lists a seeded owner with their
 *          outstanding total (browser render, not just API).
 *   52.2 — opening the owner detail shows the charges ledger + a "Record an
 *          owner payment" button; recording a payment via the dialog (auto
 *          allocation) drops the owner's outstanding and mongo-readback
 *          confirms the καταβολή landed on the oldest charge.
 *
 * Seeds a dedicated building+owner via mongo; drops it in afterAll. Skips when
 * portainer-token is absent.
 */
import { Page, expect, test } from '@playwright/test';
import { mongoExec } from './lib/mongoExec';

const REALM_NAME = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';
const TEST_EMAIL = process.env.TEST_EMAIL || '';
const TEST_PASSWORD = process.env.TEST_PASSWORD || '';

const B_NAME = 'E2E-OwnersPage-Building';
const BID = 'aa0000000000000000000052';
const P1 = 'aa0000000000000000005201';
const EXP_A = 'aa00000000000000000052a1';
const OWNER_NAME = 'E2E52-Papadopoulos';
const OWNER_TAX = '520000520';
const OWNER_KEY = `n:${OWNER_NAME.toLowerCase()}|${OWNER_TAX}`;
const YEAR = new Date().getFullYear();
const TERM = (YEAR - 1) * 1000000 + 110100; // last Nov — a past outstanding charge

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
      _id: ObjectId("${BID}"), realmId: rid, name: "${B_NAME}", atakPrefix: "E2E52",
      address: { street1: "T", city: "T", zipCode: "00000" },
      units: [
        { _id: ObjectId(), atakNumber: "E2E52-U1", isManaged: true, occupancyType: "owner_occupied", propertyId: "${P1}", generalThousandths: 1000, surface: 60, monthlyCharges: [],
          owners: [{ type: "external", percentage: 100, name: "${OWNER_NAME}", taxId: "${OWNER_TAX}" }] }
      ],
      expenses: [
        { _id: ObjectId("${EXP_A}"), name: "E2E52-Mgmt", type: "management_fee", amount: 0, allocationMethod: "equal", isRecurring: true, startTerm: ${TERM}, customAllocations: [], trackOwnerExpense: true, ownerAmount: 0 }
      ],
      ownerMonthlyExpenses: [
        { _id: ObjectId(), expenseId: "${EXP_A}", term: ${TERM}, amount: 120, source: "expense", description: "E2E52-Mgmt", paid: false, paidDate: null, payments: [] }
      ],
      createdDate: new Date(), updatedDate: new Date(), __v: 0
    });
    print(rid);
  `);
}

function readPaySum() {
  const out = mongoExec(`
    var b = db.buildings.findOne({_id: ObjectId("${BID}")});
    if (!b) { print("null"); quit(); }
    var e = (b.ownerMonthlyExpenses||[])[0];
    print((e.payments||[]).reduce(function(s,p){return s+(Number(p.amount)||0)},0));
  `);
  return out === null ? null : Number(out);
}

let realmId = '';

test.beforeAll(async () => {
  const probe = mongoExec('print("ok")');
  test.skip(probe === null, 'portainer-token absent');
  if (!TEST_EMAIL || !TEST_PASSWORD) throw new Error('missing TEST creds');
  const raw = seed();
  const lastLine = String(raw).split('\n').map((l) => l.trim()).filter(Boolean).pop()!;
  expect(lastLine).not.toBe('NO_REALM');
  realmId = (lastLine.match(/[a-f0-9]{24}/i) || [''])[0];
  expect(realmId).toBeTruthy();
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

test('52.1 — Owners page lists the seeded owner with outstanding', async ({ page }) => {
  await signIn(page);
  await page.goto(`${encodeURIComponent(REALM_NAME)}/owners`);
  await expect(page.locator('[data-cy=ownersPage]')).toBeVisible({ timeout: 20_000 });
  // The owner card shows the name + an Outstanding pill (€120).
  const card = page.locator('text=' + OWNER_NAME).first();
  await expect(card, 'owner card present').toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(/Outstanding/).first(),
    'outstanding pill present'
  ).toBeVisible();
});

test('52.2 — record a payment via the dialog drops outstanding + readback confirms', async ({
  page
}) => {
  await signIn(page);
  await page.goto(
    `${encodeURIComponent(REALM_NAME)}/owners/${encodeURIComponent(OWNER_KEY)}`
  );
  await expect(page.locator('[data-cy=ownerDetailPage]')).toBeVisible({
    timeout: 20_000
  });

  const before = readPaySum();
  expect(before, 'no payments before').toBe(0);

  // Open the payment dialog.
  await page.getByRole('button', { name: /Record an owner payment|Καταχώρηση πληρωμής/ }).click();
  await expect(page.locator('#ownerPayAmount')).toBeVisible({ timeout: 10_000 });
  // €120 in auto mode (default) → settles the €120 charge.
  await page.locator('#ownerPayAmount').fill('120');
  await page.getByRole('button', { name: /^Record$|^Καταχώρηση$/ }).click();

  // Mongo readback: the καταβολή landed (€120 on the charge).
  await expect
    .poll(() => readPaySum(), { timeout: 15_000, intervals: [500, 1000, 2000] })
    .toBeGreaterThanOrEqual(119.99);

  // The detail page reflects settled (outstanding €0).
  await page.reload();
  await expect(page.locator('[data-cy=ownerDetailPage]')).toBeVisible({
    timeout: 20_000
  });
  // After full settlement the "Record" button is disabled (outstanding<=0).
  const recordBtn = page.getByRole('button', {
    name: /Record an owner payment|Καταχώρηση πληρωμής/
  });
  await expect(recordBtn, 'record button disabled once settled').toBeDisabled({
    timeout: 15_000
  });
});
