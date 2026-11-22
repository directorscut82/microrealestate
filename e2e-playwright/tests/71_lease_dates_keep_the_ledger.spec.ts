/**
 * EDITING A LEASE'S DATES, followed to the rents page: what the months after the edit say
 * the tenant owes.
 *
 * Changing the dates of a lease adds or removes months. Months that are already over
 * are closed, and until 2026-11 a closed month kept whatever «Προηγούμενο υπόλοιπο» it
 * was built or stored with. Three edits a landlord really makes, each with one tenant
 * at 400 € a month:
 *
 *   · «extend»   a six-month lease that ended three months ago, every month paid, is
 *                extended. The months in between used to open with 2.400 € carried in:
 *                every euro the tenant had ever paid, shown as owed.
 *   · «earlier»  a lease that began two months ago, both months paid, turns out to have
 *                begun four months ago. The two new unpaid months used to stay out of
 *                every later month: this month showed nothing carried in.
 *   · «later»    a lease with five unpaid months is corrected to begin two months
 *                later. The debt of the two months that no longer exist used to stay in
 *                this month's «Προηγούμενο υπόλοιπο».
 *
 * The rule (documentation/DEFERRED_DECISIONS.md, D-8): a month carries in exactly what
 * the month before it left unpaid — also when both are closed, and also when the month
 * before it has just appeared or disappeared.
 *
 * The edit itself is sent the way the tenant form sends it (the whole tenant, PATCH
 * /tenants/:id); what this spec looks at is the rents page afterwards.
 *
 * Self-cleaning: the tenants and the apartments are removed before and after the run.
 */
import { expect, Page, request, test } from '@playwright/test';
import { ensureSeedLease, LeaseSeed } from './lib/api';
import {
  createDatedTenant,
  editTenant,
  expectRowAddsUp,
  MonthRef,
  monthRef,
  openRents,
  readRentRow,
  removeLedgerFixtures,
  RentRow,
  serverAndBrowserAgreeOnTheMonth,
  signIn
} from './lib/ledger';

const RENT = 400;
const EXTEND = 'E2E-LEASEDATES-Extend';
const EARLIER = 'E2E-LEASEDATES-Earlier';
const LATER = 'E2E-LEASEDATES-Later';
const SEARCH = 'E2E-LEASEDATES';
const FIXTURES = {
  tenants: [EXTEND, EARLIER, LATER],
  properties: [
    'E2E-LEASEDATES-Apt1',
    'E2E-LEASEDATES-Apt2',
    'E2E-LEASEDATES-Apt3'
  ]
};
const CURRENT = monthRef(0);

test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 });

let seed: LeaseSeed;
const tenantIds: Record<string, string> = {};

/** The five figures of a row, in the order the landlord reads them. */
const figures = (row: RentRow) => ({
  monthly: row.monthly,
  previousBalance: row.previousBalance,
  totalDue: row.totalDue,
  payment: row.payment,
  remaining: row.remaining
});

const unpaid = (monthsCarried: number) => ({
  monthly: RENT,
  previousBalance: RENT * monthsCarried,
  totalDue: RENT * (monthsCarried + 1),
  payment: 0,
  remaining: RENT * (monthsCarried + 1)
});

async function rowOn(
  page: Page,
  month: MonthRef,
  tenantName: string
): Promise<ReturnType<typeof figures>> {
  await openRents(page, seed.realmName, month, SEARCH);
  const row = await readRentRow(page, tenantName);
  expectRowAddsUp(row, `${tenantName}, ${month.ym}`);
  return figures(row);
}

test.beforeAll(async () => {
  test.setTimeout(4 * 60_000);
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
  const shapes = [
    { name: EXTEND, begin: -8, end: -3, markPastPaid: true },
    { name: EARLIER, begin: -2, end: 9, markPastPaid: true },
    { name: LATER, begin: -4, end: 7, markPastPaid: false }
  ];
  for (const [i, shape] of shapes.entries()) {
    const created = await createDatedTenant(api, seed, {
      tenantName: shape.name,
      propertyName: FIXTURES.properties[i],
      afmFirst8: `9990000${i + 7}`,
      rent: RENT,
      begin: monthRef(shape.begin),
      end: monthRef(shape.end),
      markPastPaid: shape.markPastPaid
    });
    tenantIds[shape.name] = created.tenantId;
  }
  await api.dispose();
});

test.afterAll(async () => {
  if (!seed) return;
  const api = await request.newContext();
  await removeLedgerFixtures(api, seed, FIXTURES);
  await api.dispose();
});

test('«extend»: a paid lease that had ended is extended, and nothing that was paid comes back as owed', async ({
  page
}) => {
  await signIn(page);
  // The starting point, on the screen: the last month of the old lease is paid.
  expect(
    await rowOn(page, monthRef(-3), EXTEND),
    'the last month of the lease before the extension'
  ).toEqual({
    monthly: RENT,
    previousBalance: 0,
    totalDue: RENT,
    payment: RENT,
    remaining: 0
  });

  const api = await request.newContext();
  await editTenant(api, seed, tenantIds[EXTEND], (body) => {
    body.endDate = monthRef(6).lastDay;
    body.properties.forEach((p) => (p.exitDate = monthRef(6).lastDay));
  });
  await api.dispose();

  // The first new month starts clean; the unpaid new months then add up as usual.
  expect(
    await rowOn(page, monthRef(-2), EXTEND),
    'the first month added by the extension'
  ).toEqual(unpaid(0));
  expect(await rowOn(page, monthRef(-1), EXTEND), 'the second').toEqual(
    unpaid(1)
  );
  expect(await rowOn(page, CURRENT, EXTEND), 'this month').toEqual(unpaid(2));
});

test('«earlier»: the begin date moves two months back, and the two new unpaid months reach this month', async ({
  page
}) => {
  await signIn(page);
  expect(
    await rowOn(page, CURRENT, EARLIER),
    'this month before the edit: the two months before it are paid'
  ).toEqual(unpaid(0));

  const api = await request.newContext();
  await editTenant(api, seed, tenantIds[EARLIER], (body) => {
    body.beginDate = monthRef(-4).day(1);
    body.properties.forEach((p) => (p.entryDate = monthRef(-4).day(1)));
  });
  await api.dispose();

  expect(
    await rowOn(page, monthRef(-4), EARLIER),
    'the first new month'
  ).toEqual(unpaid(0));
  expect(
    await rowOn(page, monthRef(-3), EARLIER),
    'the second new month'
  ).toEqual(unpaid(1));
  // The two months that were paid keep their payment and now carry the new debt.
  expect(
    await rowOn(page, monthRef(-2), EARLIER),
    'the old first month: its 400 € is still on it'
  ).toEqual({
    monthly: RENT,
    previousBalance: RENT * 2,
    totalDue: RENT * 3,
    payment: RENT,
    remaining: RENT * 2
  });
  expect(await rowOn(page, CURRENT, EARLIER), 'this month').toEqual(unpaid(2));
});

test('«later»: the begin date moves two months forward, and the debt of the months that are gone goes with them', async ({
  page
}) => {
  await signIn(page);
  expect(
    await rowOn(page, CURRENT, LATER),
    'this month before the edit: four unpaid months before it'
  ).toEqual(unpaid(4));

  const api = await request.newContext();
  await editTenant(api, seed, tenantIds[LATER], (body) => {
    body.beginDate = monthRef(-2).day(1);
    body.properties.forEach((p) => (p.entryDate = monthRef(-2).day(1)));
  });
  await api.dispose();

  expect(
    await rowOn(page, monthRef(-2), LATER),
    'the month the lease now begins on'
  ).toEqual(unpaid(0));
  expect(await rowOn(page, CURRENT, LATER), 'this month').toEqual(unpaid(2));
});
