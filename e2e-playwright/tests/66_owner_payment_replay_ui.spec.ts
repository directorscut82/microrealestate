/**
 * Spec 66 — owner-καταβολή REPLAY through the real Greek UI.
 *
 * Spec 65 proves the server contract (txnId reconcile / alreadyRecorded) at the
 * API level. That is NOT sign-off for a flow the landlord performs with a mouse:
 * the client has to derive the SAME content hash on the second submit (it is
 * computed in the browser from the draft's own fields), and the dialog has to
 * tell the landlord the truth instead of a plain success toast. Both are
 * browser-only behaviours, so they need a browser spec (test-running-guide:
 * "a jest/API test is NEVER sufficient sign-off for a bug the user hit in the UI").
 *
 *   66.1 — open /el/<org>/owners/<key>, add a draft, type €50, «Εκτέλεση» →
 *          the Greek success toast appears and mongo shows exactly ONE slice of
 *          €50 stamped with an `own-` txnId.
 *   66.2 — re-open the dialog and submit the IDENTICAL payment (same amount,
 *          same date-default, same type, empty reference) → the browser derives
 *          the same txnId, the server refuses to double-record, and the dialog
 *          shows the GREEK «έχει ήδη καταγραφεί» warning. Value-delta proof:
 *          payments count STILL 1 and paySum STILL 50 (the duplicate-money
 *          path is dead through the UI, not just through curl).
 *
 * Everything renders in Greek (`/landlord/el/...`) per the UI-review rule; both
 * states are screenshotted and the images are read.
 *
 * Seeds a DEDICATED building via direct mongo insert (never touches canonical
 * fixtures) and drops it in afterAll. Skips cleanly when portainer-token is
 * absent (mongoExec → null).
 */
import { Page, expect, test } from '@playwright/test';
import { mongoExec } from './lib/mongoExec';

const REALM_NAME = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';
const TEST_EMAIL = process.env.TEST_EMAIL || '';
const TEST_PASSWORD = process.env.TEST_PASSWORD || '';

const B_NAME = 'E2E-OwnerReplay-Building';
const BID = 'aa0000000000000000000066';
const P1 = 'aa0000000000000000006601';
const EXP_A = 'aa00000000000000000066a1';
const OWNER_NAME = 'E2E66-Owner-Replay';
const OWNER_TAX = '669999660';
const OWNER_KEY = `n:${OWNER_NAME.toLowerCase()}|${OWNER_TAX}`;

const YEAR = new Date().getFullYear();
const TERM = (YEAR - 1) * 1000000 + 110100; // last Nov — a past outstanding charge
const CHARGE = 200; // outstanding, so a 2nd €50 WOULD fit if it were recorded
const PAY = 50;

const SHOT_DIR = '_owner_replay';

let realmId = '';

test.describe.configure({ mode: 'serial', timeout: 4 * 60_000 });

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
      _id: ObjectId("${BID}"), realmId: rid, name: "${B_NAME}", atakPrefix: "E2E66",
      address: { street1: "T", city: "T", zipCode: "00000" },
      units: [
        { _id: ObjectId(), atakNumber: "E2E66-U1", isManaged: true, occupancyType: "owner_occupied", propertyId: "${P1}", generalThousandths: 1000, surface: 60, monthlyCharges: [],
          owners: [{ type: "external", percentage: 100, name: "${OWNER_NAME}", taxId: "${OWNER_TAX}" }] }
      ],
      expenses: [
        { _id: ObjectId("${EXP_A}"), name: "E2E66-Mgmt", type: "management_fee", amount: 0, allocationMethod: "equal", isRecurring: true, startTerm: ${TERM}, customAllocations: [], trackOwnerExpense: true, ownerAmount: 0 }
      ],
      ownerMonthlyExpenses: [
        { _id: ObjectId(), expenseId: "${EXP_A}", term: ${TERM}, amount: ${CHARGE}, source: "expense", description: "E2E66-Mgmt", paid: false, paidDate: null, payments: [] }
      ],
      createdDate: new Date(), updatedDate: new Date(), __v: 0
    });
    print(rid);
  `);
}

/** Slice-level readback — count, sum and the txnIds actually persisted. */
function readSlices() {
  const out = mongoExec(`
    var b = db.buildings.findOne({_id: ObjectId("${BID}")});
    if (!b) { print("null"); quit(); }
    var e = (b.ownerMonthlyExpenses||[])[0];
    print(JSON.stringify({
      payCount: (e.payments||[]).length,
      paySum: (e.payments||[]).reduce(function(s,p){return s+(Number(p.amount)||0)},0),
      txnIds: (e.payments||[]).map(function(p){return p.txnId||null})
    }));
  `);
  if (!out || String(out).indexOf('null') === 0) return null;
  const line = String(out).split('\n').map((l) => l.trim()).filter(Boolean).pop()!;
  return JSON.parse(line) as {
    payCount: number;
    paySum: number;
    txnIds: (string | null)[];
  };
}

async function signInGreek(page: Page) {
  // `el` locale segment — the realm's actual language. Never /en.
  await page.goto('el/signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 25_000 })
    .toMatch(/\/(firstaccess|dashboard)/);
}

async function openOwnerDetail(page: Page) {
  await page.goto(
    `el/${encodeURIComponent(REALM_NAME)}/owners/${encodeURIComponent(OWNER_KEY)}`
  );
  await expect(page.locator('[data-cy=ownerDetailPage]')).toBeVisible({
    timeout: 25_000
  });
}

/** Add one draft row and submit `amount` — leaves every other field default so
 *  a second run of this same helper produces an IDENTICAL content hash. */
async function submitPayment(page: Page, amount: number) {
  await page
    .getByRole('button', { name: /Καταχώρηση πληρωμής ιδιοκτήτη/ })
    .click();
  await page.getByRole('button', { name: /Προσθήκη καταβολής/ }).click();
  const amountInput = page.locator('[id="ownerPay.0.amount"]');
  await expect(amountInput).toBeVisible({ timeout: 10_000 });
  await amountInput.fill(String(amount));
  const resp = page.waitForResponse(
    (r) =>
      r.url().includes('/api/v2/owners/') &&
      r.url().includes('/payment') &&
      r.request().method() === 'POST',
    { timeout: 30_000 }
  );
  await page.getByRole('button', { name: /^Εκτέλεση$/ }).click();
  const r = await resp;
  expect(r.status(), 'payOwner POST status').toBe(200);
  return (await r.json()) as {
    allocatedTotal?: number;
    alreadyRecorded?: boolean;
    reconciledTotal?: number;
  };
}

test.beforeAll(async () => {
  const probe = mongoExec('print("ok")');
  test.skip(probe === null, 'portainer-token absent — cannot reach NAS mongo');
  if (!TEST_EMAIL || !TEST_PASSWORD) throw new Error('missing TEST creds');
  const raw = seed();
  const lastLine = String(raw).split('\n').map((l) => l.trim()).filter(Boolean).pop()!;
  expect(lastLine).not.toBe('NO_REALM');
  realmId = (lastLine.match(/[a-f0-9]{24}/i) || [''])[0];
  expect(realmId, `realmId hex not found in: ${lastLine}`).toBeTruthy();
});

test.afterAll(async () => {
  mongoExec(`db.buildings.deleteOne({_id: ObjectId("${BID}")}); print("cleaned");`);
});

test('66.1 — Greek dialog records the καταβολή; slice carries an own- txnId', async ({
  page
}) => {
  await signInGreek(page);
  await openOwnerDetail(page);

  const before = readSlices()!;
  expect(before.payCount, 'no payments before').toBe(0);

  const body = await submitPayment(page, PAY);
  expect(body.alreadyRecorded, 'first submit is not a replay').toBeFalsy();
  expect(body.reconciledTotal, 'first submit reconciles nothing').toBeFalsy();

  // Greek success toast — proves the org locale renders, not /en. The exact
  // el string is «Καταγράφηκε καταβολή {{amount}}» and it must carry the
  // SERVER-allocated figure, so assert the amount too (a plain "recorded"
  // match would pass even if the toast reported the typed amount instead).
  await expect(
    page.getByText(/Καταγράφηκε καταβολή\s*50/).first(),
    'Greek success toast with the allocated amount'
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({
    path: `${SHOT_DIR}/01_first_submit_el.png`,
    fullPage: true
  });

  const after = readSlices()!;
  expect(after.payCount, 'exactly one slice').toBe(1);
  expect(Math.abs(after.paySum - PAY)).toBeLessThanOrEqual(0.01);
  // The browser-derived content hash actually reached mongo.
  expect(after.txnIds[0], 'slice stamped with a content-derived txnId').toMatch(
    /^own-[0-9a-f]{16}$/
  );
});

test('66.2 — IDENTICAL replay through the UI warns in Greek and records NOTHING', async ({
  page
}) => {
  await signInGreek(page);
  await openOwnerDetail(page);

  const before = readSlices()!;
  expect(before.payCount, 'one slice from 66.1').toBe(1);
  const txn1 = before.txnIds[0];

  // Same amount, same defaulted date/type, same empty reference → the dialog
  // must derive the SAME txnId in the browser. €150 is still outstanding, so
  // without the idempotency key this WOULD have recorded a second €50.
  const body = await submitPayment(page, PAY);
  expect(
    body.alreadyRecorded || Number(body.reconciledTotal) > 0.005,
    'server recognised the replay'
  ).toBeTruthy();

  // The landlord is warned in GREEK — never a plain success toast for money
  // that did not land.
  // Either el warning is correct here — «…έχει ήδη καταγραφεί…» (nothing
  // written) or «…είχε ήδη καταγραφεί — ελέγξτε το ιστορικό…» (only the
  // remainder written). What must NEVER appear is the plain success toast.
  await expect(
    page.getByText(/έχει ήδη καταγραφεί|είχε ήδη καταγραφεί/).first(),
    'Greek already-recorded warning toast'
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(/^Καταγράφηκε καταβολή/),
    'never a plain success toast for money that did not land'
  ).toHaveCount(0);
  await page.screenshot({
    path: `${SHOT_DIR}/02_replay_warning_el.png`,
    fullPage: true
  });

  // Value-delta proof (not existence): nothing was added.
  const after = readSlices()!;
  expect(after.payCount, 'still exactly one slice — no duplicate money').toBe(1);
  expect(Math.abs(after.paySum - PAY)).toBeLessThanOrEqual(0.01);
  expect(after.txnIds[0], 'same content hash').toBe(txn1);

  // And the charge is still only partly settled (€50 of €200) — the replay did
  // not inflate the paid figure on the rendered surface either.
  await page.reload();
  // `ownerDetailPage` is on the <Page> wrapper, which mounts while the query is
  // still loading — waiting on it alone screenshotted a bare spinner. Wait for
  // real CONTENT (the history section) before asserting or shooting.
  const history = page.getByText('Ιστορικό πληρωμών');
  await expect(history).toBeVisible({ timeout: 25_000 });

  // Exactly ONE history line, and its money reads €50 — a second €50 row (or a
  // 100,00 € total) is precisely what the duplicate-money bug would render.
  const rows = page.locator('div.text-xs', { hasText: 'E2E-OwnerReplay-Building' });
  await expect(rows, 'one payment line in the history').toHaveCount(1);
  await expect(rows.first()).toContainText('50,00');
  await expect(rows.first(), 'no second slice merged into the line').not.toContainText(
    '100,00'
  );

  // Greek-locale rendering of that same line: the type must read as the dialog's
  // own «Μεταφορά (τραπεζική)» label (the raw enum `transfer` used to leak
  // through t()), and the date must be DD/MM/YYYY, not the US M/D/YYYY that
  // toLocaleDateString() produced.
  await expect(rows.first(), 'payment type localised, not the raw enum').toContainText(
    'Μεταφορά'
  );
  await expect(rows.first(), 'no raw English enum on the Greek screen').not.toContainText(
    'transfer'
  );
  await expect(rows.first(), 'Greek date order DD/MM/YYYY').toContainText(
    /\b\d{2}\/\d{2}\/\d{4}\b/
  );

  await page.screenshot({
    path: `${SHOT_DIR}/03_owner_detail_after_replay_el.png`,
    fullPage: true
  });
  await expect(
    page.getByRole('button', { name: /Καταχώρηση πληρωμής ιδιοκτήτη/ }),
    'still payable (€150 outstanding) — replay did not settle the charge'
  ).toBeEnabled();
});
