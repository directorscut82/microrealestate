/**
 * A UTILITY BILL THAT ARRIVES THROUGH TELEGRAM, recorded from the bell with «Χρέωση
 * ενοικιαστών» on: what the bell says before «Καταχώρηση», and what the card turns into
 * after it.
 *
 * Until 2026-11 the switch said «Χρέωση ενοικιαστών αυτόν τον μήνα» while the charge went
 * to the BILL's month, and after «Καταχώρηση» the card vanished with no message at all —
 * also when the charge had failed, and also when a tenant's share had reached no rent
 * (DEFERRED_DECISIONS D-10). The owner-approved screens of 2026-11-22:
 *
 *   · the switch names the month it will charge: «Χρέωση ενοικιαστών για Οκτώβριο 2026»;
 *   · after «Καταχώρηση» the card stays, as what was recorded — «✓ Καταχωρήθηκε» and one
 *     line per tenant share with the month whose rent holds it, read back from the rents
 *     by the server — until «Εντάξει».
 *
 * ONE BUILDING, THREE APARTMENTS IN EQUAL SHARES, a 90 € bill dated LAST month:
 *   · Unpaid  has not paid this month                 → the share is on THIS month's rent
 *   · Paid    has paid this month in full             → on NEXT month's rent
 *   · Left    lease ended at the end of last month    → charged nowhere, and the card says so
 *
 * The bill is put in the bell with a DIRECT MONGO INSERT, as the repo's rule for this
 * lane has it (telegramInboxStates.spec.ts): the only healthy writer of an inbox item is
 * the Telegram scanner, and a bot does not receive its own messages.
 *
 * What is asserted: the switch's words; the app's answer to the confirm; the card, line
 * by line, in Greek — while the item is already out of the bell's list of pending items
 * (the card must not go with it), and again after the bell is closed and opened; the
 * tenants' ledgers; the item's status in the database; and that «Εντάξει» takes the card
 * away for good — pressed while the list the page asked for after the confirm is still
 * on its way (the spec holds it), when going by the last list the page had would bring
 * the bill back as a card to record.
 *
 * Self-cleaning: tenants, the building (its bill goes with it), apartments and the inbox
 * item are removed before and after the run. Every identifier is from the reserved
 * synthetic bands.
 */
import { expect, request, test } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { ensureSeedLease, LeaseSeed } from './lib/api';
import {
  BillBuilding,
  chargeSwitchLabel,
  createBillBuilding,
  createDatedTenant,
  ledgerOf,
  LedgerTenant,
  monthRef,
  payByApi,
  removeLedgerFixtures,
  serverAndBrowserAgreeOnTheMonth,
  signIn
} from './lib/ledger';
import { mongoExec } from './lib/mongoExec';

const RENT = 400;
const AMOUNT = 90;
const SHARE = AMOUNT / 3;

const LAST_MONTH = monthRef(-1);
const CURRENT = monthRef(0);
const NEXT = monthRef(1);

const F = {
  building: 'E2E-BELLBILL',
  atakPrefix: '999721',
  expense: 'E2E-BELLBILL ΔΕΗ κοινοχρήστων',
  supply: '9 99972001-016',
  unpaid: 'E2E-BELLBILL-Unpaid',
  paid: 'E2E-BELLBILL-Paid',
  left: 'E2E-BELLBILL-Left',
  properties: ['E2E-BELLBILL-AptU', 'E2E-BELLBILL-AptP', 'E2E-BELLBILL-AptL']
};
const FIXTURES = {
  tenants: [F.unpaid, F.paid, F.left],
  buildings: [F.building],
  properties: F.properties
};
// A marker no real item carries, so the cleanup can never remove another bill.
const MARK = 'E2E-BELLBILL';

const WORK = path.resolve(__dirname, '../_bell_bill');
const supplyBody = (printed: string) => printed.replace(/\D/g, '').slice(0, 9);
const euro = (amount: number) => `${amount.toFixed(2).replace('.', ',')} €`;
// Month names standing on their own — the nominative (utils/greekMonths.js).
const EL_NOMINATIVE = [
  'Ιανουάριος',
  'Φεβρουάριος',
  'Μάρτιος',
  'Απρίλιος',
  'Μάιος',
  'Ιούνιος',
  'Ιούλιος',
  'Αύγουστος',
  'Σεπτέμβριος',
  'Οκτώβριος',
  'Νοέμβριος',
  'Δεκέμβριος'
];
const onMonth = (m: { month: number; year: number }) =>
  `✓ ${EL_NOMINATIVE[m.month - 1]} ${m.year}`;
// DD/MM/YYYY → an ISO day, for the item's dates.
const iso = (ddmmyyyy: string) => ddmmyyyy.split('/').reverse().join('-');

test.describe.configure({ timeout: 5 * 60_000 });

let seed: LeaseSeed;
let building: BillBuilding;
let unpaid: LedgerTenant;
let paid: LedgerTenant;
let left: LedgerTenant;
let itemId = '';

function removeItems(): void {
  mongoExec(
    `var r = db.inboxitems.remove({ sourceFileName: '${MARK}.jpg' }); print('removed ' + r.nRemoved);`
  );
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
  test.skip(
    mongoExec('print(1)') === null,
    'No way to reach the database (no Portainer token, no E2E_MONGO_SHELL): the bill cannot be put in the bell.'
  );
  fs.mkdirSync(WORK, { recursive: true });

  const api = await request.newContext();
  seed = await ensureSeedLease(api);
  removeItems();
  await removeLedgerFixtures(api, seed, FIXTURES);

  const tenant = (
    tenantName: string,
    propertyName: string,
    afmFirst8: string,
    end: typeof CURRENT
  ) =>
    createDatedTenant(api, seed, {
      tenantName,
      propertyName,
      afmFirst8,
      rent: RENT,
      begin: monthRef(-3),
      end,
      markPastPaid: true
    });
  unpaid = await tenant(F.unpaid, F.properties[0], '99900021', monthRef(9));
  paid = await tenant(F.paid, F.properties[1], '99900022', monthRef(9));
  left = await tenant(F.left, F.properties[2], '99900023', LAST_MONTH);
  // «Paid» settles this month: it is closed for them from now on.
  await payByApi(api, seed, paid.tenantId, CURRENT, RENT);

  building = await createBillBuilding(api, seed, {
    name: F.building,
    atakPrefix: F.atakPrefix,
    propertyIds: [unpaid.propertyId, paid.propertyId, left.propertyId],
    expenseName: F.expense,
    billingId: supplyBody(F.supply),
    startTerm: monthRef(-3).term
  });
  await api.dispose();

  // The bill, as the Telegram scanner leaves it in the bell: read, matched to the
  // building's expense, waiting to be recorded. Dated LAST month.
  const id = mongoExec(`
    var d = {
      _id: ObjectId(),
      realmId: '${seed.realmId}',
      source: 'telegram',
      status: 'pending',
      kind: 'bill',
      sourceFileName: '${MARK}.jpg',
      telegramMessageId: NumberInt(Math.floor(90000 + Math.random() * 9000)),
      parsed: {
        provider: 'deh',
        billingId: '${supplyBody(F.supply)}',
        billingIdNormalized: '${supplyBody(F.supply)}',
        totalAmount: ${AMOUNT},
        periodStart: new Date('${iso(monthRef(-2).day(9))}T00:00:00Z'),
        periodEnd: new Date('${iso(LAST_MONTH.day(9))}T00:00:00Z'),
        issueDate: new Date('${iso(LAST_MONTH.day(12))}T00:00:00Z'),
        proposedTerm: NumberInt(${LAST_MONTH.term})
      },
      suggestedMatch: {
        buildingId: '${building.buildingId}',
        buildingName: '${F.building}',
        expenseId: '${building.expenseId}',
        expenseName: '${F.expense}'
      },
      warnings: [],
      createdDate: new Date(),
      updatedDate: new Date()
    };
    db.inboxitems.insert(d);
    print(d._id.valueOf());
  `);
  itemId =
    String(id || '')
      .trim()
      .split('\n')
      .pop() || '';
  expect(itemId, 'the bill is in the bell').toMatch(/^[a-f0-9]{24}$/);
});

test.afterAll(async () => {
  if (!seed) return;
  removeItems();
  const api = await request.newContext();
  await removeLedgerFixtures(api, seed, FIXTURES);
  await api.dispose();
});

test('a bill recorded from the bell: the switch names its month, and the card says where each share went', async ({
  page
}) => {
  const api = await request.newContext();
  const totals = async (t: LedgerTenant) =>
    Object.fromEntries(
      (await ledgerOf(api, seed, t.tenantId)).months.map((m) => [
        m.term,
        m.totalToPay
      ])
    );
  const before = {
    unpaid: await totals(unpaid),
    paid: await totals(paid),
    left: await totals(left)
  };

  await signIn(page);
  await page.goto(`el/${encodeURIComponent(seed.realmName)}/dashboard`);
  const bell = page.getByRole('button', { name: 'Ειδοποιήσεις' });
  await expect(bell).toBeVisible({ timeout: 30_000 });
  await bell.click();

  // ── before «Καταχώρηση» ────────────────────────────────────────────────────────
  const pending = page
    .locator('[data-cy=inboxBillCard]')
    .filter({ hasText: `${F.building} · ${F.expense}` });
  await expect(pending, 'the bill’s card').toHaveCount(1);
  const chargeLabel = pending
    .locator('label')
    .filter({ hasText: 'Χρέωση ενοικιαστών' });
  await expect(
    chargeLabel,
    'the switch names the month it will charge — the bill’s, not «this month»'
  ).toHaveText(chargeSwitchLabel(LAST_MONTH));
  const chargeSwitch = chargeLabel.locator('button[role=switch]');
  await chargeSwitch.click();
  await expect(chargeSwitch).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: path.join(WORK, 'bell-before.png') });

  // ── «Καταχώρηση» ───────────────────────────────────────────────────────────────
  // From here until the gate opens, every request of the page for the list of pending
  // items is HELD. So what the bell shows in between is what it shows while that list
  // is slow: the last list the page was given still names the item, as it does for a
  // moment after every confirm — and nothing below may depend on a fresher one.
  let openGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let heldRequests = 0;
  await page.route(/\/api\/v2\/inbox(\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') {
      heldRequests += 1;
      await gate;
    }
    await route.continue().catch(() => {});
  });
  // (the number on the bell: the items that wait for the landlord — this bill is one)
  const countedAsPending = async () =>
    Number((await bell.innerText()).trim() || 0);
  const pendingBefore = await countedAsPending();
  expect(pendingBefore, 'the bell counts the bill as pending').toBeGreaterThan(
    0
  );
  const confirmed = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/v2/inbox/${itemId}/confirm`) &&
      r.request().method() === 'POST',
    { timeout: 110_000 }
  );
  await pending
    .getByRole('button', { name: 'Καταχώρηση', exact: true })
    .click();
  const response = await confirmed;
  expect(response.status(), 'the bill is recorded').toBe(200);
  const row = await response.json();
  expect(
    {
      term: Number(row.term),
      chargeRequested: row.chargeRequested,
      charged: row.charged,
      chargeError: row.chargeError ?? null
    },
    'what the app answered'
  ).toEqual({
    term: LAST_MONTH.term,
    chargeRequested: true,
    charged: true,
    chargeError: null
  });
  // Read back from the tenants' rents after saving — not assumed.
  expect(
    (row.chargeOutcome || []).map(
      (o: {
        tenantName: string;
        status: string;
        billedTerm: number | null;
        billedAmount: number | null;
        reason?: string;
      }) =>
        `${o.tenantName}: ${o.status} → ${o.billedTerm ?? 'no rent'} (${o.billedAmount ?? '-'})${o.reason ? ` ${o.reason}` : ''}`
    ),
    'where the app says each share went'
  ).toEqual([
    `${F.unpaid}: moved → ${CURRENT.term} (${SHARE}) monthClosed`,
    `${F.paid}: moved → ${NEXT.term} (${SHARE}) monthPaid`,
    `${F.left}: notCharged → no rent (-) leaseEnded`
  ]);

  // ── the card, after ────────────────────────────────────────────────────────────
  const recorded = page.locator('[data-cy=inboxConfirmedCard]');
  const asRead = (text: string) =>
    text
      .split('\n')
      .map((line) => line.replace(/[\s\u00a0]+/g, ' ').trim())
      .filter(Boolean);
  const said = async () => ({
    head: asRead(await recorded.locator('div').first().innerText()),
    shares: (
      await recorded.locator('[data-cy=chargeOutcomeRow]').allInnerTexts()
    ).map(asRead)
  });
  const expected = {
    head: ['ΔΕΗ', 'Telegram', '✓ Καταχωρήθηκε'],
    shares: [
      [`${F.properties[0]} · ${F.unpaid}`, euro(SHARE), onMonth(CURRENT)],
      [`${F.properties[1]} · ${F.paid}`, euro(SHARE), onMonth(NEXT)],
      [`${F.properties[2]} · ${F.left}`, euro(SHARE), '⚠ δεν χρεώθηκε']
    ]
  };
  await expect(recorded, 'the card turns into what was recorded').toHaveCount(
    1
  );
  expect(await said(), 'what the card says').toEqual(expected);
  // The item is out of the bell's list — the card to record is gone — and the recorded
  // card did not go with it. No fresher list has reached the page: the one it asked for
  // after the confirm is being held.
  await expect(pending, 'the card to record is gone').toHaveCount(0);
  await expect
    .poll(() => heldRequests, {
      message: 'the page asked for the list again, and the spec is holding it'
    })
    .toBeGreaterThan(0);
  await expect(recorded, 'the recorded card is still there').toHaveCount(1);
  await page.screenshot({ path: path.join(WORK, 'bell-recorded.png') });
  // Closing the bell and opening it again does not lose it either.
  await page.keyboard.press('Escape');
  await expect(recorded, 'the bell is closed').toHaveCount(0);
  await bell.click();
  await expect(
    recorded,
    'the recorded card is there when the bell is opened again'
  ).toHaveCount(1);
  expect(
    await said(),
    'what the card says, after the bell was closed and opened'
  ).toEqual(expected);
  await expect(
    recorded.getByRole('button', { name: 'Εντάξει', exact: true })
  ).toBeVisible();

  // ── the ledgers hold what the card says ────────────────────────────────────────
  const after = {
    unpaid: await totals(unpaid),
    paid: await totals(paid),
    left: await totals(left)
  };
  const delta = (
    a: Record<string, number>,
    b: Record<string, number>,
    term: number
  ) => Math.round(((b[term] ?? 0) - (a[term] ?? 0)) * 100) / 100;
  expect(
    {
      unpaidThisMonth: delta(before.unpaid, after.unpaid, CURRENT.term),
      paidThisMonth: delta(before.paid, after.paid, CURRENT.term),
      paidNextMonth: delta(before.paid, after.paid, NEXT.term),
      leftLastMonth: delta(before.left, after.left, LAST_MONTH.term),
      leftHasNoLaterMonth: after.left[CURRENT.term] === undefined
    },
    'each share is on the rent the card names, and nowhere else'
  ).toEqual({
    unpaidThisMonth: SHARE,
    paidThisMonth: 0,
    paidNextMonth: SHARE,
    leftLastMonth: 0,
    leftHasNoLaterMonth: true
  });
  expect(
    mongoExec(
      `var i = db.inboxitems.findOne({ _id: ObjectId('${itemId}') }); print(i ? i.status : 'gone');`
    ),
    'the item in the database'
  ).toBe('confirmed');

  // ── «Εντάξει», while the list the page asked for is still on its way ────────────
  await recorded.getByRole('button', { name: 'Εντάξει', exact: true }).click();
  await expect(recorded, '«Εντάξει» takes the card away').toHaveCount(0);
  // The bill must not come back as a card to record. Going by the last list the page
  // had — which still named the item — brought it back, «Καταχώρηση» live and counted
  // as pending, until a fresher list arrived (found by review). The bell is closed and
  // opened first, so that what is read is the bell as it now stands («Εντάξει» on the
  // only card closes it).
  const bellHeader = page.getByText('Ειδοποιήσεις', { exact: true });
  await page.keyboard.press('Escape');
  await expect(bellHeader, 'the bell is closed').toBeHidden();
  await bell.click();
  await expect(bellHeader, 'the bell is open').toBeVisible();
  await expect(pending, 'the recorded bill is not offered again').toHaveCount(
    0
  );
  await expect
    .poll(countedAsPending, {
      message: 'the bell no longer counts the bill as pending'
    })
    .toBe(pendingBefore - 1);

  // ── the list arrives ───────────────────────────────────────────────────────────
  // The first list the page is GIVEN that no longer names the item: only a list the
  // server answered after it recorded the item can be that one.
  const listedWithoutIt = page.waitForResponse(
    async (r) => {
      if (
        !/\/api\/v2\/inbox(\?.*)?$/.test(r.url()) ||
        r.request().method() !== 'GET' ||
        r.status() !== 200
      ) {
        return false;
      }
      const items = await r.json().catch(() => null);
      return (
        Array.isArray(items) &&
        !items.some((i: { _id?: string }) => String(i?._id) === itemId)
      );
    },
    { timeout: 60_000 }
  );
  openGate();
  // (without such a list — the server still naming the item as pending — the test
  // ends here)
  await listedWithoutIt;
  // …for good: a fresh page has neither card.
  await page.reload();
  await expect(bell).toBeVisible({ timeout: 30_000 });
  await bell.click();
  await expect(page.getByText('Ειδοποιήσεις', { exact: true })).toBeVisible();
  await expect(page.locator('[data-cy=inboxConfirmedCard]')).toHaveCount(0);
  await expect(
    page
      .locator('[data-cy=inboxBillCard]')
      .filter({ hasText: `${F.building} · ${F.expense}` })
  ).toHaveCount(0);
  await api.dispose();
});
