/**
 * THE DETAILS OF A BUILDING THAT HAS BEEN IN USE FOR A WHILE, on the building page
 * («Πληροφορίες»).
 *
 * A building's record holds every owner charge stored for it — one per apartment,
 * expense and month — so it grows with every month. Until 2026-11 «Αποθήκευση» on the
 * details form sent that whole record back with the form laid over it, although the
 * server keeps nothing of it but the details. The api reads 100 KB of JSON per request.
 * On 24/11/2026 the real 11-apartment building's record was 489 KB: its details could not
 * be saved at all — 413, and the screen said only «Κάτι πήγε στραβά». Its name, address,
 * manager, bank account and shared meters (the numbers incoming bills are matched on)
 * were frozen. The two 5-apartment buildings were at 63 and 69 KB and on their way.
 *
 * ONE BUILDING WITH 1,200 STORED OWNER CHARGES (about 250 KB). They are written straight
 * into the database: no door of the app writes that many at once — on the real
 * building they accumulated over eleven months.
 *   1. a note is typed in «Σημειώσεις» and «Αποθήκευση» is pressed: the save goes through,
 *      what the browser sent is the form (under 20 KB, no owner charges in it), and the
 *      screen says «Το κτίριο ενημερώθηκε»;
 *   2. the page is opened again: the note is there — and so are the 1,200 owner charges.
 *
 * Self-cleaning: the building is removed before and after the run. Every identifier is
 * from the reserved synthetic bands.
 */
import { expect, request, test } from '@playwright/test';
import { ensureSeedLease, LeaseSeed } from './lib/api';
import {
  BillBuilding,
  createBillBuilding,
  monthRef,
  removeLedgerFixtures,
  signIn
} from './lib/ledger';
import { mongoExec } from './lib/mongoExec';

const GATEWAY = process.env.GATEWAY_URL || 'http://192.168.0.96:1350';
const F = {
  building: 'E2E-BIGBUILDING',
  atakPrefix: '999741',
  expense: 'E2E-BIGBUILDING ΑΣΦΑΛΙΣΗ'
};
const FIXTURES = { buildings: [F.building] };
const OWNER_CHARGES = 1200;
const API_JSON_LIMIT = 100 * 1024;
const NOTE = 'E2E-BIGBUILDING σημείωση';

test.describe.configure({ timeout: 5 * 60_000 });

let seed: LeaseSeed;
let building: BillBuilding;

const headers = () => ({
  Authorization: `Bearer ${seed.token}`,
  organizationid: seed.realmId
});

test.beforeAll(async () => {
  test.setTimeout(5 * 60_000);
  if (!process.env.TEST_EMAIL || !process.env.TEST_PASSWORD) {
    throw new Error(
      'Missing TEST_EMAIL/TEST_PASSWORD. Expected .secrets/cypress-test-account.'
    );
  }
  const api = await request.newContext();
  seed = await ensureSeedLease(api);
  await removeLedgerFixtures(api, seed, FIXTURES);
  building = await createBillBuilding(api, seed, {
    name: F.building,
    atakPrefix: F.atakPrefix,
    propertyIds: [],
    expenseName: F.expense,
    billingId: '999741001',
    startTerm: monthRef(-12).term,
    expenseExtra: {
      type: 'insurance',
      isVariable: false,
      amount: 100,
      allocationMethod: 'equal'
    }
  });

  // The owner charges of a building that has been in use: 100 a month for a year.
  const wrote = mongoExec(
    `var rows = [];
     for (var i = 0; i < ${OWNER_CHARGES}; i++) {
       rows.push({
         _id: new ObjectId(),
         expenseId: '${building.expenseId}',
         term: Number('2026' + ('0' + (1 + (i % 12))).slice(-2) + '0100'),
         amount: 1,
         description: 'E2E-BIGBUILDING OWNER CHARGE',
         propertyId: null,
         source: 'owner-fixed',
         payments: [],
         paid: false,
         paidDate: null
       });
     }
     var r = db.buildings.updateOne(
       { _id: ObjectId('${building.buildingId}'), name: '${F.building}' },
       { $set: { ownerMonthlyExpenses: rows } }
     );
     print('modified ' + r.modifiedCount);`
  );
  test.skip(
    wrote === null,
    'No way to write to the database from here (no Portainer token, no local shell).'
  );
  expect(wrote, 'the owner charges are written').toContain('modified 1');

  const loaded = await api.get(
    `${GATEWAY}/api/v2/buildings/${building.buildingId}`,
    { headers: headers() }
  );
  expect(loaded.status(), 'the building').toBe(200);
  expect(
    Buffer.byteLength(await loaded.text()),
    'the record is past what the api reads in one request — the case that could not be saved'
  ).toBeGreaterThan(API_JSON_LIMIT);
  await api.dispose();
});

test.afterAll(async () => {
  if (!seed) return;
  const api = await request.newContext();
  await removeLedgerFixtures(api, seed, FIXTURES);
  await api.dispose();
});

test('the details of a building with 1,200 stored owner charges can be saved', async ({
  page
}) => {
  await signIn(page);
  const openDetails = async () => {
    await page.goto(
      `el/${encodeURIComponent(seed.realmName)}/buildings/${building.buildingId}`
    );
    await page.locator('[data-cy=settingsTab]').click();
  };
  const notes = page.locator('textarea#notes');

  // ── 1. a note is typed, «Αποθήκευση» ───────────────────────────────────────────
  await openDetails();
  await expect(notes).toHaveValue('');
  await notes.fill(NOTE);
  const answered = page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' &&
      new URL(r.url()).pathname.endsWith(`/buildings/${building.buildingId}`),
    { timeout: 110_000 }
  );
  await page.locator('form [data-cy=submit]').click();
  const answer = await answered;
  const sent = answer.request().postData() || '';
  expect(answer.status(), 'the details are saved').toBe(200);
  expect(
    Buffer.byteLength(sent),
    'what the browser sent is the form, not the record'
  ).toBeLessThan(20_000);
  expect(
    Object.keys(JSON.parse(sent)),
    'no stored owner charge travels with the details'
  ).not.toContain('ownerMonthlyExpenses');
  await expect(
    page
      .locator('[data-sonner-toast]')
      .filter({ hasText: 'Το κτίριο ενημερώθηκε' }),
    'the screen says the building was updated'
  ).toHaveCount(1);

  // ── 2. the page, opened again ──────────────────────────────────────────────────
  await openDetails();
  await expect(notes, 'the note is there').toHaveValue(NOTE);
  const api = await request.newContext();
  const stored = await api.get(
    `${GATEWAY}/api/v2/buildings/${building.buildingId}`,
    { headers: headers() }
  );
  expect(stored.status(), 'the building').toBe(200);
  const record = await stored.json();
  expect(record.notes, 'the stored note').toBe(NOTE);
  expect(
    (record.ownerMonthlyExpenses || []).length,
    'every owner charge is still stored'
  ).toBe(OWNER_CHARGES);
  await api.dispose();
});
