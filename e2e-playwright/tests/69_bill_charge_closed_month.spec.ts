/**
 * A UTILITY BILL CHARGED TO TENANTS, followed to the screen that matters: what the rents
 * page says each tenant owes afterwards.
 *
 * The landlord imports a common-electricity bill for a building («Έξοδα» → «Εισαγωγή
 * Λογαριασμού»), switches on «Χρέωση ενοικιαστών για <μήνα>» and confirms. The app
 * answers that the tenants were charged. Two situations, two tenants each at half the
 * building:
 *
 *   · PAST MONTH   the bill is dated last month (100 €). That month is over.
 *   · PAID MONTH   the bill is dated this month (60 €), but one of the two tenants has
 *                  already paid this month in full.
 *
 * A month that is over, or that a tenant has paid in full, is closed for that tenant:
 * nothing can be added to it (contract.ts, `_isFrozen` — deliberate, see spec 68). What
 * is NOT deliberate is the outcome here. The share is written on the building's side —
 * its own «Χρεώσεις» table lists the tenant against the amount — the app reports success,
 * and the tenant is asked for it in no month at all. The landlord pays the utility and
 * recovers nothing, with no warning in the import window.
 *
 * Both are KNOWN BUGS, first watched on the NAS on 2026-11-22. Each group below ends in
 * one test that asserts the CORRECT outcome under `test.fail`: today it runs and is
 * reported as an expected failure — the bug still reproduces.
 *
 * HOW EACH GROUP IS BUILT, and why:
 *
 *   1. a CONTROL, as an ordinary test: a charge that must reach a tenant does reach
 *      them, and the readings see it. In PAST MONTH that is a bill dated this month
 *      charged to the same two tenants before anything else; in PAID MONTH it is the
 *      tenant who had not paid, on the very import under test. If charging or reading
 *      were broken in general, the control fails and the group stops there.
 *   2. the import under test, as an ordinary test: every click, every reading.
 *   3. the expected failure: a comparison of numbers already read, and nothing else —
 *      `test.fail` is satisfied by ANY failure, so nothing that can fail for another
 *      reason is allowed inside it.
 *
 * WHEN A BUG HERE IS FIXED, expect one of two things, depending on the shape of the fix:
 *
 *   · the tenant ends up owing their share in some open month, and the import still
 *     answers as it does today → the expected-failure test reports «Expected to fail,
 *     but passed». Delete its `test.fail` call; it is now the regression test.
 *   · the fix changes what the import does or answers — it refuses to charge, answers
 *     something other than `charged: true`, or records the charge under another month →
 *     the ORDINARY import test fails first, on the lines that pin today's answer and
 *     today's «Χρεώσεις». That is intended: those lines describe the present contract,
 *     and a fix that changes it must rewrite them, and the expected-failure test with
 *     them, on purpose.
 *
 * Either way the run goes red, so a fix cannot slip past this file. A failure stops only
 * its own group; the other group still runs.
 *
 * The bills are generated for the day the spec runs (tools/make-bill-fixtures.mjs,
 * custom mode): a fixed-date fixture would age out of the tenants' leases. Every
 * identifier is from the reserved synthetic bands.
 *
 * Self-cleaning: tenants, buildings (their bills go with them) and apartments are removed
 * before and after the run.
 */
import { expect, Page, request, test } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { ensureSeedLease, LeaseSeed } from './lib/api';
import {
  BillBuilding,
  chargeSwitchLabel,
  createBillBuilding,
  createLedgerTenant,
  expectRowAddsUp,
  importBillAndChargeTenants,
  monthRef,
  openRents,
  readRentRow,
  recordPayment,
  removeLedgerFixtures,
  renderDehBill,
  RentRow,
  serverAndBrowserAgreeOnTheMonth,
  signIn,
  tenantSharesFor
} from './lib/ledger';

const RENT = 400;
const MONTHS_BACK = 3;
const SEARCH = 'E2E-BILLFRZ';

const LAST_MONTH = monthRef(-1);
const CURRENT = monthRef(0);
const NEXT = monthRef(1);

const PAST = {
  building: 'E2E-BILLFRZ-PastMonth',
  atakPrefix: '999691',
  expense: 'E2E-BILLFRZ ΔΕΗ κοινοχρήστων Α',
  supply: '9 99969001-016',
  controlAmount: 80,
  amount: 100,
  tenantA: 'E2E-BILLFRZ-PastA',
  tenantB: 'E2E-BILLFRZ-PastB',
  properties: ['E2E-BILLFRZ-AptPA', 'E2E-BILLFRZ-AptPB']
};
const PAID = {
  building: 'E2E-BILLFRZ-PaidMonth',
  atakPrefix: '999692',
  expense: 'E2E-BILLFRZ ΔΕΗ κοινοχρήστων Β',
  supply: '9 99969002-016',
  amount: 60,
  hasPaid: 'E2E-BILLFRZ-HasPaid',
  notPaid: 'E2E-BILLFRZ-NotPaid',
  properties: ['E2E-BILLFRZ-AptHP', 'E2E-BILLFRZ-AptNP']
};
const FIXTURES = {
  tenants: [PAST.tenantA, PAST.tenantB, PAID.hasPaid, PAID.notPaid],
  buildings: [PAST.building, PAID.building],
  properties: [...PAST.properties, ...PAID.properties]
};

/** The 9-digit body of a printed παροχή — what an expense's billing id is matched on. */
const supplyBody = (printed: string) => printed.replace(/\D/g, '').slice(0, 9);
const asShown = (amount: number) => amount.toFixed(2).replace('.', ',');
const cents = (n: number) => Math.round(n * 100) / 100;

const WORK = path.resolve(__dirname, '../_bill_closed_month');

test.describe.configure({ timeout: 6 * 60_000 });

let seed: LeaseSeed;
let pastBuilding: BillBuilding;
let paidBuilding: BillBuilding;
const pdf = { pastControl: '', past: '', paid: '' };

/** Read several tenants' rows off the rents page that is open; each must add up. */
async function rowsOf(
  page: Page,
  names: string[],
  what: string
): Promise<Record<string, RentRow>> {
  const rows: Record<string, RentRow> = {};
  for (const name of names) {
    rows[name] = await readRentRow(page, name);
    expectRowAddsUp(rows[name], `${name}, ${what}`);
  }
  return rows;
}

/** What the building's own «Χρεώσεις» is built from, for one month. */
async function sharesOf(building: BillBuilding, term: number) {
  const api = await request.newContext();
  const shares = await tenantSharesFor(api, seed, building.buildingId, term);
  await api.dispose();
  return shares;
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
  fs.mkdirSync(WORK, { recursive: true });

  const api = await request.newContext();
  seed = await ensureSeedLease(api);
  await removeLedgerFixtures(api, seed, FIXTURES);

  const tenant = (
    tenantName: string,
    propertyName: string,
    afmFirst8: string
  ) =>
    createLedgerTenant(api, seed, {
      tenantName,
      propertyName,
      afmFirst8,
      rent: RENT,
      monthsBack: MONTHS_BACK
    });
  const pastA = await tenant(PAST.tenantA, PAST.properties[0], '99900003');
  const pastB = await tenant(PAST.tenantB, PAST.properties[1], '99900004');
  const hasPaid = await tenant(PAID.hasPaid, PAID.properties[0], '99900005');
  const notPaid = await tenant(PAID.notPaid, PAID.properties[1], '99900006');

  const startTerm = monthRef(-MONTHS_BACK).term;
  pastBuilding = await createBillBuilding(api, seed, {
    name: PAST.building,
    atakPrefix: PAST.atakPrefix,
    propertyIds: [pastA.propertyId, pastB.propertyId],
    expenseName: PAST.expense,
    billingId: supplyBody(PAST.supply),
    startTerm
  });
  paidBuilding = await createBillBuilding(api, seed, {
    name: PAID.building,
    atakPrefix: PAID.atakPrefix,
    propertyIds: [hasPaid.propertyId, notPaid.propertyId],
    expenseName: PAID.expense,
    billingId: supplyBody(PAID.supply),
    startTerm
  });
  await api.dispose();

  // A bill is charged in the month it was ISSUED, not the month its period ended
  // (common/utils/billterm.ts `computeChargeTerm`). The two «this month» bills are built
  // to tell those apart: their period ended LAST month and they were issued on the 1st
  // of THIS month (never later than the day the spec runs). The ordinary tests assert
  // that the import names, and charges, THIS month — which only holds if the issue date
  // printed on the bill is the one that is read.
  const thisMonth = {
    periodFrom: LAST_MONTH.day(1),
    periodTo: LAST_MONTH.lastDay,
    issue: CURRENT.day(1),
    due: NEXT.day(16)
  };
  pdf.pastControl = renderDehBill(WORK, 'control-dated-this-month', {
    supply: PAST.supply,
    rf: 'RF33999000000000000000300',
    total: asShown(PAST.controlAmount),
    ...thisMonth
  });
  pdf.paid = renderDehBill(WORK, 'dated-this-month', {
    supply: PAID.supply,
    rf: 'RF33999000000000000000302',
    total: asShown(PAID.amount),
    ...thisMonth
  });
  // Issued LAST month: its charge month is over by the time it is imported.
  pdf.past = renderDehBill(WORK, 'dated-last-month', {
    supply: PAST.supply,
    rf: 'RF33999000000000000000301',
    total: asShown(PAST.amount),
    periodFrom: monthRef(-2).day(9),
    periodTo: LAST_MONTH.day(9),
    issue: LAST_MONTH.day(12),
    due: NEXT.day(16)
  });
});

test.afterAll(async () => {
  if (!seed) return;
  const api = await request.newContext();
  await removeLedgerFixtures(api, seed, FIXTURES);
  await api.dispose();
});

test.describe('PAST MONTH', () => {
  test.describe.configure({ mode: 'serial' });

  const tenants = [PAST.tenantA, PAST.tenantB];
  const seen: {
    nextBefore?: Record<string, RentRow>;
    nextAfter?: Record<string, RentRow>;
  } = {};

  test('control — a bill dated this month is charged to both tenants, and the rents page shows it', async ({
    page
  }) => {
    await signIn(page);
    await openRents(page, seed.realmName, NEXT, SEARCH);
    const before = await rowsOf(page, tenants, 'next month, before');

    const { bill, switchLabel } = await importBillAndChargeTenants(
      page,
      seed.realmName,
      pastBuilding.buildingId,
      pdf.pastControl,
      asShown(PAST.controlAmount)
    );
    expect(switchLabel, 'the switch names the month it charges').toBe(
      chargeSwitchLabel(CURRENT)
    );
    expect(
      {
        term: Number(bill.term),
        charged: bill.charged,
        chargeError: bill.chargeError ?? null
      },
      'what the app answered for the import'
    ).toEqual({ term: CURRENT.term, charged: true, chargeError: null });

    await openRents(page, seed.realmName, CURRENT, SEARCH);
    const current = await rowsOf(page, tenants, 'this month, after');
    await openRents(page, seed.realmName, NEXT, SEARCH);
    const after = await rowsOf(page, tenants, 'next month, after');

    for (const name of tenants) {
      expect(
        {
          name,
          monthly: current[name].monthly,
          owesMoreByNextMonth: cents(
            after[name].totalDue - before[name].totalDue
          )
        },
        'a charge to an open month reaches the tenant'
      ).toEqual({
        name,
        monthly: RENT + PAST.controlAmount / 2,
        owesMoreByNextMonth: PAST.controlAmount / 2
      });
    }
  });

  test('a bill dated last month is imported with «Χρέωση ενοικιαστών» on, and the app reports it charged', async ({
    page
  }) => {
    await signIn(page);
    await openRents(page, seed.realmName, NEXT, SEARCH);
    const nextBefore = await rowsOf(page, tenants, 'next month, before');

    const { bill, switchLabel } = await importBillAndChargeTenants(
      page,
      seed.realmName,
      pastBuilding.buildingId,
      pdf.past,
      asShown(PAST.amount)
    );
    await page.screenshot({
      path: path.join(WORK, 'past-month-after-import.png'),
      fullPage: true
    });
    // The window names the closed month in so many words, and warns of nothing.
    expect(switchLabel, 'the switch names the month it charges').toBe(
      chargeSwitchLabel(LAST_MONTH)
    );
    expect(
      {
        term: Number(bill.term),
        chargeRequested: bill.chargeRequested,
        charged: bill.charged,
        chargeError: bill.chargeError ?? null
      },
      'what the app answered for the import'
    ).toEqual({
      term: LAST_MONTH.term,
      chargeRequested: true,
      charged: true,
      chargeError: null
    });
    // The building's side: each tenant is listed against half the bill, for that month.
    expect(
      await sharesOf(pastBuilding, LAST_MONTH.term),
      'the building’s «Χρεώσεις» for the bill’s month'
    ).toEqual({
      [PAST.tenantA]: PAST.amount / 2,
      [PAST.tenantB]: PAST.amount / 2
    });

    await openRents(page, seed.realmName, NEXT, SEARCH);
    const nextAfter = await rowsOf(page, tenants, 'next month, after');
    await page.screenshot({
      path: path.join(WORK, 'past-month-rents-next-month.png'),
      fullPage: true
    });

    seen.nextBefore = nextBefore;
    seen.nextAfter = nextAfter;
    console.log(
      tenants
        .map(
          (name) =>
            `[69] PAST MONTH ${name} next month «Συνολική οφειλή»: ` +
            `${nextBefore[name].totalDue} → ${nextAfter[name].totalDue}`
        )
        .join('\n')
    );
  });

  test('KNOWN BUG (expected failure) — a bill reported as charged must be owed by the tenants', async () => {
    // Preconditions first, outside the expected failure: if the readings are missing
    // this must fail as an ordinary test, not be counted as «the bug reproduced».
    expect(seen.nextBefore, 'rows before the import were read').toBeTruthy();
    expect(seen.nextAfter, 'rows after the import were read').toBeTruthy();

    test.fail(
      true,
      'KNOWN BUG, watched on the NAS 2026-11-22: a bill charged to a month that is already over is ' +
        'written on the building and reported as charged, and reaches no tenant’s rent in any month. ' +
        'See the header for what to do when this starts passing.'
    );
    const nowOwed = cents(
      seen.nextAfter![PAST.tenantA].totalDue -
        seen.nextBefore![PAST.tenantA].totalDue +
        (seen.nextAfter![PAST.tenantB].totalDue -
          seen.nextBefore![PAST.tenantB].totalDue)
    );
    expect(
      nowOwed,
      'how much more the two tenants owe by next month, after a 100 € bill was charged to them'
    ).toBe(PAST.amount);
  });
});

test.describe('PAID MONTH', () => {
  test.describe.configure({ mode: 'serial' });

  const tenants = [PAID.hasPaid, PAID.notPaid];
  const seen: {
    currentAfter?: Record<string, RentRow>;
    nextBefore?: Record<string, RentRow>;
    nextAfter?: Record<string, RentRow>;
  } = {};

  test('one tenant pays this month in full, then a bill dated this month is imported with «Χρέωση ενοικιαστών» on', async ({
    page
  }) => {
    await signIn(page);

    await openRents(page, seed.realmName, CURRENT, SEARCH);
    const owed = (await readRentRow(page, PAID.hasPaid)).totalDue;
    expect(owed, 'the tenant owes three past months plus this one').toBe(
      RENT * (MONTHS_BACK + 1)
    );
    await recordPayment(page, PAID.hasPaid, owed);
    expect(
      (await readRentRow(page, PAID.hasPaid)).remaining,
      'this month is paid in full'
    ).toBe(0);

    await openRents(page, seed.realmName, NEXT, SEARCH);
    const nextBefore = await rowsOf(page, tenants, 'next month, before');

    const { bill, switchLabel } = await importBillAndChargeTenants(
      page,
      seed.realmName,
      paidBuilding.buildingId,
      pdf.paid,
      asShown(PAID.amount)
    );
    await page.screenshot({
      path: path.join(WORK, 'paid-month-after-import.png'),
      fullPage: true
    });
    expect(switchLabel, 'the switch names the month it charges').toBe(
      chargeSwitchLabel(CURRENT)
    );
    expect(
      {
        term: Number(bill.term),
        chargeRequested: bill.chargeRequested,
        charged: bill.charged,
        chargeError: bill.chargeError ?? null
      },
      'what the app answered for the import'
    ).toEqual({
      term: CURRENT.term,
      chargeRequested: true,
      charged: true,
      chargeError: null
    });
    expect(
      await sharesOf(paidBuilding, CURRENT.term),
      'the building’s «Χρεώσεις» for this month'
    ).toEqual({
      [PAID.hasPaid]: PAID.amount / 2,
      [PAID.notPaid]: PAID.amount / 2
    });

    await openRents(page, seed.realmName, CURRENT, SEARCH);
    const currentAfter = await rowsOf(page, tenants, 'this month, after');
    await page.screenshot({
      path: path.join(WORK, 'paid-month-rents-this-month.png'),
      fullPage: true
    });
    await openRents(page, seed.realmName, NEXT, SEARCH);
    const nextAfter = await rowsOf(page, tenants, 'next month, after');

    seen.currentAfter = currentAfter;
    seen.nextBefore = nextBefore;
    seen.nextAfter = nextAfter;
    console.log(
      tenants
        .map(
          (name) =>
            `[69] PAID MONTH ${name} this month «Μηνιαίο ποσό» ${currentAfter[name].monthly}; ` +
            `next month «Συνολική οφειλή»: ${nextBefore[name].totalDue} → ${nextAfter[name].totalDue}`
        )
        .join('\n')
    );
  });

  test('control — the tenant who had not paid is charged their half, this month', async () => {
    expect(seen.currentAfter, 'rows after the import were read').toBeTruthy();
    expect(
      seen.currentAfter![PAID.notPaid].monthly,
      'this month «Μηνιαίο ποσό»: rent plus half the bill'
    ).toBe(RENT + PAID.amount / 2);
    expect(
      cents(
        seen.nextAfter![PAID.notPaid].totalDue -
          seen.nextBefore![PAID.notPaid].totalDue
      ),
      'how much more this tenant owes by next month'
    ).toBe(PAID.amount / 2);
  });

  test('KNOWN BUG (expected failure) — the tenant who had already paid must be asked for their half too', async () => {
    expect(seen.nextBefore, 'rows before the import were read').toBeTruthy();
    expect(seen.nextAfter, 'rows after the import were read').toBeTruthy();

    test.fail(
      true,
      'KNOWN BUG, watched on the NAS 2026-11-22: a tenant who has paid the current month in full is ' +
        'listed against their share on the building and charged it in no month. ' +
        'See the header for what to do when this starts passing.'
    );
    expect(
      cents(
        seen.nextAfter![PAID.hasPaid].totalDue -
          seen.nextBefore![PAID.hasPaid].totalDue
      ),
      'how much more this tenant owes by next month, after half of a 60 € bill was charged to them'
    ).toBe(PAID.amount / 2);
  });
});
