/**
 * A PAYMENT RECORDED ON A PAST MONTH'S PAGE, followed to the screen that matters: what the
 * rents page says the tenant still owes.
 *
 * Three tenants in the same position — rent 400 €, a lease that began three months ago,
 * nothing paid, so 1.600 € is owed this month. The landlord then records money for each
 * of them through the payment window, in the ways the app offers:
 *
 *   · «at once»      one payment of 1.600 € on THIS month's page
 *   · «each month»   400 € on each month's own page (three past months, then this one)
 *   · «in advance»   1.000 € on the OLDEST month's page — 600 € more than that month owed
 *
 * The rule under test: whatever page a payment is recorded on, the months after it owe
 * that much less. Until 2026-11 only the first way worked. A payment on a past month's
 * page was saved on that month and went no further: every later month kept showing the
 * same «Προηγούμενο υπόλοιπο», for money that had been received (watched on the NAS on
 * 2026-11-22; this spec carried that as an expected failure until the fix shipped).
 *
 * Owner decisions this spec pins (documentation/DEFERRED_DECISIONS.md, D-8):
 *   · the two ways of paying the same 1.600 € leave the tenant in the same position;
 *   · more than a month owed is not lost and not refused: it reaches the later months,
 *     as a credit where it exceeds what they carry;
 *   · taking a payment back puts the debt back on the months after it.
 *
 * WHAT IS NOT IN QUESTION. What a past month BILLED is frozen on purpose, so that a later
 * edit to a rent or a building expense cannot re-price a month that is over (contract.ts,
 * `_isFrozen`). Every row below still shows «Μηνιαίο ποσό» 400 € — only what a month
 * carries in from the months before it moves.
 *
 * Self-cleaning: the tenants and the apartments are removed before and after the run.
 */
import { expect, Page, request, test } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { ensureSeedLease, LeaseSeed } from './lib/api';
import {
  createLedgerTenant,
  expectRowAddsUp,
  monthRef,
  openRents,
  readRentRow,
  recordPayment,
  removeLedgerFixtures,
  removeSavedPayment,
  rentRow,
  RentRow,
  serverAndBrowserAgreeOnTheMonth,
  signIn
} from './lib/ledger';

const RENT = 400;
const MONTHS_BACK = 3;
const OWED_THIS_MONTH = RENT * (MONTHS_BACK + 1);
const IN_ADVANCE_AMOUNT = 1000;

const EACH_MONTH = 'E2E-PASTPAY-EachMonth';
const AT_ONCE = 'E2E-PASTPAY-AtOnce';
const IN_ADVANCE = 'E2E-PASTPAY-InAdvance';
const SEARCH = 'E2E-PASTPAY';
const FIXTURES = {
  tenants: [EACH_MONTH, AT_ONCE, IN_ADVANCE],
  properties: ['E2E-PASTPAY-Apt1', 'E2E-PASTPAY-Apt2', 'E2E-PASTPAY-Apt3']
};

// Oldest first: three past months, then the current one.
const MONTHS = Array.from({ length: MONTHS_BACK + 1 }, (_, i) =>
  monthRef(i - MONTHS_BACK)
);
const OLDEST = MONTHS[0];
const CURRENT = monthRef(0);
const NEXT = monthRef(1);

const SHOTS = path.resolve(__dirname, '../_past_month_carry');

test.describe.configure({ mode: 'serial', timeout: 6 * 60_000 });

let seed: LeaseSeed;
// What the screen showed, kept for the tests that only compare.
const seen: {
  atOnce?: { current: RentRow; next: RentRow };
  eachMonth?: { current: RentRow; next: RentRow };
} = {};

/** The five figures of a row, in the order the landlord reads them. */
const figures = (row: RentRow) => ({
  monthly: row.monthly,
  previousBalance: row.previousBalance,
  totalDue: row.totalDue,
  payment: row.payment,
  remaining: row.remaining,
  credit: row.credit
});

/** «Nothing is owed beyond next month's own rent» — the same check for both tenants. */
function expectSettled(rows: { current: RentRow; next: RentRow }) {
  expect(rows.current.remaining, 'this month «Υπόλοιπο»').toBe(0);
  expect(rows.next.previousBalance, 'next month «Προηγούμενο υπόλοιπο»').toBe(
    0
  );
  expect(rows.next.totalDue, 'next month «Συνολική οφειλή»').toBe(RENT);
}

/** Read the «in advance» tenant's row on every month from the oldest to next month. */
async function inAdvanceRows(page: Page) {
  const rows: RentRow[] = [];
  for (const month of [...MONTHS, NEXT]) {
    await openRents(page, seed.realmName, month, SEARCH);
    const row = await readRentRow(page, IN_ADVANCE);
    expectRowAddsUp(row, `«in advance», ${month.ym}`);
    rows.push(row);
  }
  return rows;
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
  fs.mkdirSync(SHOTS, { recursive: true });

  const api = await request.newContext();
  seed = await ensureSeedLease(api);
  await removeLedgerFixtures(api, seed, FIXTURES);
  for (const [i, tenantName] of FIXTURES.tenants.entries()) {
    await createLedgerTenant(api, seed, {
      tenantName,
      propertyName: FIXTURES.properties[i],
      afmFirst8: `9990000${i + 1}`,
      rent: RENT,
      monthsBack: MONTHS_BACK
    });
  }
  await api.dispose();
});

test.afterAll(async () => {
  if (!seed) return;
  const api = await request.newContext();
  await removeLedgerFixtures(api, seed, FIXTURES);
  await api.dispose();
});

test('every tenant starts this month owing three past months plus this one', async ({
  page
}) => {
  await signIn(page);
  await openRents(page, seed.realmName, CURRENT, SEARCH);

  for (const name of FIXTURES.tenants) {
    const row = await readRentRow(page, name);
    expectRowAddsUp(row, `${name}, this month`);
    expect(
      { name, ...figures(row) },
      'the starting row, as the landlord reads it'
    ).toEqual({
      name,
      monthly: RENT,
      previousBalance: RENT * MONTHS_BACK,
      totalDue: OWED_THIS_MONTH,
      payment: 0,
      remaining: OWED_THIS_MONTH,
      credit: 0
    });
  }
});

test('«at once»: one payment for everything, on this month’s page, settles the tenant', async ({
  page
}) => {
  await signIn(page);
  await openRents(page, seed.realmName, CURRENT, SEARCH);
  await recordPayment(page, AT_ONCE, OWED_THIS_MONTH);
  const current = await readRentRow(page, AT_ONCE);
  await rentRow(page, AT_ONCE).screenshot({
    path: path.join(SHOTS, 'at-once-this-month.png')
  });

  await openRents(page, seed.realmName, NEXT, SEARCH);
  const next = await readRentRow(page, AT_ONCE);
  await rentRow(page, AT_ONCE).screenshot({
    path: path.join(SHOTS, 'at-once-next-month.png')
  });

  expectRowAddsUp(current, '«at once», this month');
  expectRowAddsUp(next, '«at once», next month');
  seen.atOnce = { current, next };
  console.log(
    `[68] «at once»    this month: ${JSON.stringify(current)}\n` +
      `[68]              next month: ${JSON.stringify(next)}`
  );
  expectSettled(seen.atOnce);
});

test('«each month»: as each month is paid on its own page, that month shows nothing carried in and nothing left', async ({
  page
}) => {
  await signIn(page);

  const perMonth: RentRow[] = [];
  for (const month of MONTHS) {
    await openRents(page, seed.realmName, month, SEARCH);
    await recordPayment(page, EACH_MONTH, RENT);
    perMonth.push(await readRentRow(page, EACH_MONTH));
    await rentRow(page, EACH_MONTH).screenshot({
      path: path.join(SHOTS, `each-month-${month.ym}.png`)
    });
  }
  perMonth.forEach((row, i) =>
    expectRowAddsUp(row, `«each month», ${MONTHS[i].ym}`)
  );
  console.log(
    MONTHS.map(
      (month, i) =>
        `[68] «each month» ${month.ym}: ${JSON.stringify(perMonth[i])}`
    ).join('\n')
  );

  // Oldest first, so by the time a month is paid every month before it is settled: it
  // carries nothing in, and its own 400 € clears it. Before the fix the second month
  // still carried the first month's 400 € although it had just been received.
  expect(
    perMonth.map(figures),
    'each month’s row, read right after its own payment'
  ).toEqual(
    MONTHS.map(() => ({
      monthly: RENT,
      previousBalance: 0,
      totalDue: RENT,
      payment: RENT,
      remaining: 0,
      credit: 0
    }))
  );

  await openRents(page, seed.realmName, NEXT, SEARCH);
  const next = await readRentRow(page, EACH_MONTH);
  await rentRow(page, EACH_MONTH).screenshot({
    path: path.join(SHOTS, 'each-month-next-month.png')
  });
  expectRowAddsUp(next, '«each month», next month');
  seen.eachMonth = { current: perMonth[perMonth.length - 1], next };
  console.log(`[68]              next month: ${JSON.stringify(next)}`);
});

test('«each month» leaves the tenant settled, exactly as «at once» does', async () => {
  expect(seen.atOnce, 'rows of the «at once» tenant were read').toBeTruthy();
  expect(
    seen.eachMonth,
    'rows of the «each month» tenant were read'
  ).toBeTruthy();

  expectSettled(seen.eachMonth!);
  // The same 1.600 € was received either way: next month must read the same for both.
  expect(figures(seen.eachMonth!.next), 'next month, «each month»').toEqual(
    figures(seen.atOnce!.next)
  );
});

test('«in advance»: 1.000 € on the oldest month’s page reaches every month after it', async ({
  page
}) => {
  await signIn(page);
  await openRents(page, seed.realmName, OLDEST, SEARCH);
  await recordPayment(page, IN_ADVANCE, IN_ADVANCE_AMOUNT);

  const rows = await inAdvanceRows(page);
  console.log(
    [...MONTHS, NEXT]
      .map(
        (month, i) =>
          `[68] «in advance» ${month.ym}: ${JSON.stringify(rows[i])}`
      )
      .join('\n')
  );
  await openRents(page, seed.realmName, MONTHS[1], SEARCH);
  await rentRow(page, IN_ADVANCE).screenshot({
    path: path.join(SHOTS, 'in-advance-credit-month.png')
  });

  // 1.000 € against four bills of 400 €. The oldest month keeps its own 400 € and shows
  // the 600 € surplus; the second month is covered and still has 200 € over; the third
  // owes its last 200 €; this month owes 600 € = 1.600 € billed − 1.000 € received.
  expect(
    rows.map(figures),
    'every month, oldest first, then next month'
  ).toEqual(
    [
      {
        previousBalance: 0,
        totalDue: 400,
        payment: 1000,
        remaining: 0,
        credit: 600
      },
      {
        previousBalance: -600,
        totalDue: -200,
        payment: 0,
        remaining: 0,
        credit: 200
      },
      {
        previousBalance: -200,
        totalDue: 200,
        payment: 0,
        remaining: 200,
        credit: 0
      },
      {
        previousBalance: 200,
        totalDue: 600,
        payment: 0,
        remaining: 600,
        credit: 0
      },
      {
        previousBalance: 600,
        totalDue: 1000,
        payment: 0,
        remaining: 1000,
        credit: 0
      }
    ].map((row) => ({ monthly: RENT, ...row }))
  );
});

test('taking that payment back puts the debt back on every month after it', async ({
  page
}) => {
  await signIn(page);
  await openRents(page, seed.realmName, OLDEST, SEARCH);
  await removeSavedPayment(page, IN_ADVANCE);

  const rows = await inAdvanceRows(page);
  expect(
    rows.map(figures),
    'every month, oldest first, then next month'
  ).toEqual(
    [0, 1, 2, 3, 4].map((monthsBefore) => ({
      monthly: RENT,
      previousBalance: RENT * monthsBefore,
      totalDue: RENT * (monthsBefore + 1),
      payment: 0,
      remaining: RENT * (monthsBefore + 1),
      credit: 0
    }))
  );
});
