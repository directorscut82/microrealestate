/**
 * A UTILITY BILL CHARGED TO TENANTS WHOSE MONTH IS CLOSED, followed to the screens that
 * matter: what the rents page says each tenant owes afterwards, what the rent says the
 * money is for, and what the building's own page says about where each share went.
 *
 * The landlord imports a common-electricity bill for a building («Έξοδα» → «Εισαγωγή
 * Λογαριασμού»), switches on «Χρέωση ενοικιαστών για <μήνα>» and confirms. Two
 * situations, two tenants each at half the building:
 *
 *   · PAST MONTH   the bill is dated last month (100 €). That month is over.
 *   · PAID MONTH   the bill is dated this month (60 €), but one of the two tenants has
 *                  already paid this month in full.
 *
 * A month that is over, or that a tenant has paid in full, is closed for that tenant:
 * nothing can be added to it (contract.ts, `_isFrozen` — deliberate, see spec 68). Until
 * 2026-11 the share was written on the building's side, the app reported success, and
 * the tenant was asked for it in no month at all (DEFERRED_DECISIONS D-10; this file
 * held the two cases as expected failures, watched on the NAS on 2026-11-22).
 *
 * THE RULE NOW (owner, 2026-11-22): the share goes on that tenant's NEXT OPEN month —
 * this month when they have not paid it, next month when they have — as a line that
 * says which month it is for («… · για Οκτώβριο 2026»). Where it is billed is worked out
 * from the tenant's ledger each time (1_base.ts `_carriedInto`); what the app answers
 * and what the building's page shows are read back from the rents
 * (managers/chargecarry.ts).
 *
 * HOW EACH GROUP IS BUILT:
 *
 *   1. a CONTROL: a charge to an open month reaches the tenant on that month, exactly
 *      as before. In PAST MONTH that is a bill dated this month charged to the same two
 *      tenants before anything else; in PAID MONTH it is the tenant who had not paid,
 *      on the very import under test.
 *   2. the import under test: every click, the app's answer (`chargeOutcome`: one line
 *      per tenant, with the month whose rent holds the share), and the rents page.
 *   3. the screens that say so: the rent's own breakdown names the month the share is
 *      for; the building's page of the bill's month says where each share was charged.
 *   4. (PAST MONTH only) the statement saved again: nothing is charged a second time.
 *
 * A failure stops only its own group; the other group still runs.
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
  chargedOnRentOf,
  chargeSwitchLabel,
  createBillBuilding,
  createLedgerTenant,
  expectRowAddsUp,
  forMonthLabel,
  hasPaidLabel,
  importBillAndChargeTenants,
  monthClosedSentence,
  monthlyBreakdownOf,
  monthRef,
  onRentOf,
  openBuildingMonth,
  openRents,
  readRentRow,
  recordPayment,
  removeLedgerFixtures,
  renderDehBill,
  RentRow,
  saveStatement,
  serverAndBrowserAgreeOnTheMonth,
  shareBillingLines,
  ShareOutcome,
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
/** An amount as the screens print it: «50,00 €». */
const euro = (amount: number) => `${asShown(amount)} €`;
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

/** The app's answer about each tenant's share, as `name: status → month (amount)`. */
const outcomeOf = (rows: ShareOutcome[] | undefined) =>
  (rows || [])
    .map(
      (o) =>
        `${o.tenantName}: ${o.status} → ${o.billedTerm ?? 'no rent'} (${o.billedAmount ?? '-'})`
    )
    .sort();

/** The same month's statement saved again, with the figure it already has. */
async function saveStatementAgain(
  building: BillBuilding,
  term: number,
  amount: number
): Promise<ShareOutcome[]> {
  const api = await request.newContext();
  const outcome = await saveStatement(api, seed, building, term, amount);
  await api.dispose();
  return outcome;
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
  const HALF = PAST.amount / 2;
  const CONTROL_HALF = PAST.controlAmount / 2;
  const seen: {
    nextAfter?: Record<string, RentRow>;
  } = {};

  test('control — a bill dated this month is charged to both tenants, and the rents page shows it', async ({
    page
  }) => {
    await signIn(page);
    await openRents(page, seed.realmName, NEXT, SEARCH);
    const before = await rowsOf(page, tenants, 'next month, before');

    const { bill, switchLabel, windowSaid } = await importBillAndChargeTenants(
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
    // The window stays open on where each share went: this month's rent, for both —
    // and it does not say the month is closed, because it is not.
    expect(windowSaid, 'what the import window says after saving').toEqual({
      sentence: null,
      shares: [
        [
          `${PAST.properties[0]} · ${PAST.tenantA}`,
          euro(CONTROL_HALF),
          onRentOf(CURRENT)
        ],
        [
          `${PAST.properties[1]} · ${PAST.tenantB}`,
          euro(CONTROL_HALF),
          onRentOf(CURRENT)
        ]
      ]
    });
    expect(
      outcomeOf(bill.chargeOutcome),
      'where the app says each share went: this month, for both'
    ).toEqual([
      `${PAST.tenantA}: billed → ${CURRENT.term} (${CONTROL_HALF})`,
      `${PAST.tenantB}: billed → ${CURRENT.term} (${CONTROL_HALF})`
    ]);

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
        monthly: RENT + CONTROL_HALF,
        owesMoreByNextMonth: CONTROL_HALF
      });
    }
  });

  test('a bill dated last month is imported with «Χρέωση ενοικιαστών» on: each half goes on this month’s rent', async ({
    page
  }) => {
    await signIn(page);
    await openRents(page, seed.realmName, NEXT, SEARCH);
    const nextBefore = await rowsOf(page, tenants, 'next month, before');

    const { bill, switchLabel, windowSaid } = await importBillAndChargeTenants(
      page,
      seed.realmName,
      pastBuilding.buildingId,
      pdf.past,
      asShown(PAST.amount)
    );
    // What the landlord is told on the spot: the month is closed, and each share is on
    // this month's rent. (It used to be «εισήχθη με επιτυχία» and nothing else.)
    expect(windowSaid, 'what the import window says after saving').toEqual({
      sentence: monthClosedSentence(LAST_MONTH),
      shares: [
        [
          `${PAST.properties[0]} · ${PAST.tenantA}`,
          euro(HALF),
          onRentOf(CURRENT)
        ],
        [
          `${PAST.properties[1]} · ${PAST.tenantB}`,
          euro(HALF),
          onRentOf(CURRENT)
        ]
      ]
    });
    await page.screenshot({
      path: path.join(WORK, 'past-month-after-import.png'),
      fullPage: true
    });
    expect(switchLabel, 'the switch names the month the bill is for').toBe(
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
    // Read back from the tenants' rents after saving — not assumed.
    expect(
      outcomeOf(bill.chargeOutcome),
      'where the app says each share went'
    ).toEqual([
      `${PAST.tenantA}: moved → ${CURRENT.term} (${HALF})`,
      `${PAST.tenantB}: moved → ${CURRENT.term} (${HALF})`
    ]);
    // The building's side: each tenant is listed against half the bill, for the bill's month.
    expect(
      await sharesOf(pastBuilding, LAST_MONTH.term),
      'the building’s «Χρεώσεις» for the bill’s month'
    ).toEqual({
      [PAST.tenantA]: HALF,
      [PAST.tenantB]: HALF
    });

    await openRents(page, seed.realmName, CURRENT, SEARCH);
    const current = await rowsOf(page, tenants, 'this month, after');
    await openRents(page, seed.realmName, NEXT, SEARCH);
    const nextAfter = await rowsOf(page, tenants, 'next month, after');
    await page.screenshot({
      path: path.join(WORK, 'past-month-rents-next-month.png'),
      fullPage: true
    });
    seen.nextAfter = nextAfter;

    for (const name of tenants) {
      expect(
        {
          name,
          monthly: current[name].monthly,
          owesMoreByNextMonth: cents(
            nextAfter[name].totalDue - nextBefore[name].totalDue
          )
        },
        'a 100 € bill for a month that is over: each tenant owes their half, on this month’s rent'
      ).toEqual({
        name,
        monthly: RENT + CONTROL_HALF + HALF,
        owesMoreByNextMonth: HALF
      });
    }
  });

  test('the rent says which month the share is for', async ({ page }) => {
    await signIn(page);
    await openRents(page, seed.realmName, CURRENT, SEARCH);
    const lines = await monthlyBreakdownOf(page, PAST.tenantA);
    const label = `Κοινόχρηστο Ρεύμα (${PAST.building} - ${PAST.expense})`;
    expect(
      lines.filter((l) => l.includes(PAST.expense)),
      'the building lines of this month’s rent: its own share, then last month’s'
    ).toEqual([
      `${label} ${asShown(CONTROL_HALF)} €`,
      `${label} · ${forMonthLabel(LAST_MONTH)} ${asShown(HALF)} €`
    ]);
  });

  test('the building’s page says where each share was charged', async ({
    page
  }) => {
    await signIn(page);
    await openBuildingMonth(
      page,
      seed.realmName,
      pastBuilding.buildingId,
      LAST_MONTH
    );
    await expect(
      page.getByText(
        'Το μερίδιο κάθε ενοικιαστή για αυτόν τον μήνα μπαίνει στο επόμενο ανοιχτό ενοίκιό του'
      ),
      'the note on a month that is over'
    ).toHaveCount(1);
    await expect
      .poll(() => shareBillingLines(page), {
        message: 'where each share of last month was charged',
        timeout: 30_000
      })
      .toEqual([
        ['olive', chargedOnRentOf(CURRENT)],
        ['olive', chargedOnRentOf(CURRENT)]
      ]);
    await page.screenshot({
      path: path.join(WORK, 'past-month-building-page.png'),
      fullPage: true
    });

    // This month's page lists the two shares under their tenants, each marked with the
    // month it is for — and has nothing to add about its own.
    await openBuildingMonth(
      page,
      seed.realmName,
      pastBuilding.buildingId,
      CURRENT
    );
    await expect(
      page.locator('[data-cy=shareForMonth]'),
      'the shares billed on this month for another'
    ).toHaveText([forMonthLabel(LAST_MONTH), forMonthLabel(LAST_MONTH)]);
    await expect(page.locator('[data-cy=shareBilling]')).toHaveCount(0);
  });

  test('the same statement saved again charges nothing a second time', async ({
    page
  }) => {
    expect(seen.nextAfter, 'rows after the import were read').toBeTruthy();
    const outcome = await saveStatementAgain(
      pastBuilding,
      LAST_MONTH.term,
      PAST.amount
    );
    expect(
      outcomeOf(outcome),
      'where each share is, after saving again'
    ).toEqual([
      `${PAST.tenantA}: moved → ${CURRENT.term} (${HALF})`,
      `${PAST.tenantB}: moved → ${CURRENT.term} (${HALF})`
    ]);
    await signIn(page);
    await openRents(page, seed.realmName, NEXT, SEARCH);
    const again = await rowsOf(page, tenants, 'next month, after saving again');
    for (const name of tenants) {
      expect(
        again[name].totalDue,
        `${name}: «Συνολική οφειλή» of next month is what it was`
      ).toBe(seen.nextAfter![name].totalDue);
    }
  });
});

test.describe('PAID MONTH', () => {
  test.describe.configure({ mode: 'serial' });

  const tenants = [PAID.hasPaid, PAID.notPaid];
  const HALF = PAID.amount / 2;
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

    const { bill, switchLabel, windowSaid } = await importBillAndChargeTenants(
      page,
      seed.realmName,
      paidBuilding.buildingId,
      pdf.paid,
      asShown(PAID.amount)
    );
    // One share is on the bill's own month, so the window does not say «the month is
    // closed for the tenants»; under the share that went on next month it says why.
    expect(windowSaid, 'what the import window says after saving').toEqual({
      sentence: null,
      shares: [
        [
          `${PAID.properties[0]} · ${PAID.hasPaid}`,
          euro(HALF),
          onRentOf(NEXT),
          hasPaidLabel(CURRENT)
        ],
        [
          `${PAID.properties[1]} · ${PAID.notPaid}`,
          euro(HALF),
          onRentOf(CURRENT)
        ]
      ]
    });
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
    // The tenant who had paid this month gets it next month; the other one this month.
    expect(
      outcomeOf(bill.chargeOutcome),
      'where the app says each share went'
    ).toEqual([
      `${PAID.hasPaid}: moved → ${NEXT.term} (${HALF})`,
      `${PAID.notPaid}: billed → ${CURRENT.term} (${HALF})`
    ]);
    expect(
      await sharesOf(paidBuilding, CURRENT.term),
      'the building’s «Χρεώσεις» for this month'
    ).toEqual({
      [PAID.hasPaid]: HALF,
      [PAID.notPaid]: HALF
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
  });

  test('control — the tenant who had not paid is charged their half, this month', async () => {
    expect(seen.currentAfter, 'rows after the import were read').toBeTruthy();
    expect(
      seen.currentAfter![PAID.notPaid].monthly,
      'this month «Μηνιαίο ποσό»: rent plus half the bill'
    ).toBe(RENT + HALF);
    expect(
      cents(
        seen.nextAfter![PAID.notPaid].totalDue -
          seen.nextBefore![PAID.notPaid].totalDue
      ),
      'how much more this tenant owes by next month'
    ).toBe(HALF);
  });

  test('the tenant who had already paid is asked for their half next month, and the month they paid is as they paid it', async () => {
    expect(seen.nextBefore, 'rows before the import were read').toBeTruthy();
    expect(seen.nextAfter, 'rows after the import were read').toBeTruthy();
    expect(
      {
        thisMonthMonthly: seen.currentAfter![PAID.hasPaid].monthly,
        thisMonthLeft: seen.currentAfter![PAID.hasPaid].remaining,
        nextMonthMonthly: seen.nextAfter![PAID.hasPaid].monthly,
        owesMoreByNextMonth: cents(
          seen.nextAfter![PAID.hasPaid].totalDue -
            seen.nextBefore![PAID.hasPaid].totalDue
        )
      },
      'half of a 60 € bill, for a tenant who had paid this month in full'
    ).toEqual({
      thisMonthMonthly: RENT,
      thisMonthLeft: 0,
      nextMonthMonthly: RENT + HALF,
      owesMoreByNextMonth: HALF
    });
  });

  test('next month’s rent says which month the share is for, and the building’s page says where it went', async ({
    page
  }) => {
    await signIn(page);
    await openRents(page, seed.realmName, NEXT, SEARCH);
    const lines = await monthlyBreakdownOf(page, PAID.hasPaid);
    expect(
      lines.filter((l) => l.includes(PAID.expense)),
      'the building line of next month’s rent'
    ).toEqual([
      `Κοινόχρηστο Ρεύμα (${PAID.building} - ${PAID.expense}) · ${forMonthLabel(CURRENT)} ${asShown(HALF)} €`
    ]);

    // This month's page: the share of the tenant who had paid says where it was
    // charged; the other one is on this month's rent, and there is nothing to add.
    await openBuildingMonth(
      page,
      seed.realmName,
      paidBuilding.buildingId,
      CURRENT
    );
    await expect
      .poll(() => shareBillingLines(page), {
        message: 'where each share of this month was charged',
        timeout: 30_000
      })
      .toEqual([['olive', chargedOnRentOf(NEXT)]]);
    await page.screenshot({
      path: path.join(WORK, 'paid-month-building-page.png'),
      fullPage: true
    });
  });
});
