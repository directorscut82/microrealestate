/**
 * ENDING A LEASE WITH «ΛΟΓΙΣΤΙΚΗ ΔΙΑΓΡΑΦΗ» WHEN THE TENANT HAS PAID PART OF WHAT WAS OWED.
 *
 * The «Τερματισμός» window shows what is still unpaid up to the termination date and
 * offers to write it off as a recorded discount. It used to work that out month by
 * month, each row on its own — and a row cannot tell that it was settled through a
 * payment recorded on ANOTHER month's page. Three tenants, rent 400 €, a lease that
 * began three months ago (four months billed = 1.600 €), each having paid differently:
 *
 *   · «catch-up»   800 € on the second month's page: the first two months are settled.
 *                  Really owed: 800 €. The window used to offer 1.200 €.
 *   · «part»       300 € on the second month's page.
 *                  Really owed: 1.300 €. The window used to offer 1.600 €.
 *   · «ahead»      1.200 € on the first month's page: three months are settled.
 *                  Really owed: 400 €. The window used to offer 1.200 €.
 *
 * Writing off more than is owed is not a rounding matter: since 2026-11 a write-off on
 * an older month reaches the months after it (spec 68), so the surplus came out the far
 * end as a credit the tenant had never paid — or the third write-off was refused and the
 * lease was left half written off and not terminated (both watched on the campaign
 * harness before this spec was written).
 *
 * What this spec pins, through the real window:
 *   · the amount offered is exactly what is really owed, and the months it names are
 *     the ones still unpaid when every payment settles the oldest month first;
 *   · after «Τερματισμός» the recorded discounts add up to that amount;
 *   · the last month of the lease owes NOTHING and is owed nothing: no debt, no credit.
 *
 * The tenant who paid nothing is spec 51 (T2).
 *
 * And one more, for what happens when the server says no AFTER the write-offs have
 * landed (they are sent first, the termination last):
 *
 *   · «refused»    nothing paid, 1.600 € owed, and a deposit refund typed although no
 *                  deposit is held. The write-offs land, the termination is refused. The
 *                  window must then show the ledger as it now stands (nothing left to
 *                  write off), and once the refund is corrected the SAME window must
 *                  terminate the lease — without writing any month off a second time.
 *
 * Self-cleaning: the tenants and the apartments are removed before and after the run.
 */
import { expect, Page, request, test } from '@playwright/test';
import { ensureSeedLease, LeaseSeed } from './lib/api';
import {
  createLedgerTenant,
  LedgerMonth,
  ledgerOf,
  monthRef,
  parseEuro,
  payByApi,
  removeLedgerFixtures,
  serverAndBrowserAgreeOnTheMonth,
  signIn
} from './lib/ledger';

const RENT = 400;
const MONTHS_BACK = 3;
const CURRENT = monthRef(0);

interface Shape {
  key: string;
  tenant: string;
  apartment: string;
  /** The one payment the tenant has made: on which month's page, and how much. */
  paidOn: number;
  paid: number;
  /** What is really owed up to today, and on how many months it sits (oldest paid first). */
  owed: number;
  unpaidMonths: number;
}

const SHAPES: Shape[] = [
  {
    key: 'catch-up',
    tenant: 'E2E-TERMPAY-CatchUp',
    apartment: 'E2E-TERMPAY-Apt1',
    paidOn: -2,
    paid: 800,
    owed: 800,
    unpaidMonths: 2
  },
  {
    key: 'part',
    tenant: 'E2E-TERMPAY-Part',
    apartment: 'E2E-TERMPAY-Apt2',
    paidOn: -2,
    paid: 300,
    owed: 1300,
    unpaidMonths: 4
  },
  {
    key: 'ahead',
    tenant: 'E2E-TERMPAY-Ahead',
    apartment: 'E2E-TERMPAY-Apt3',
    paidOn: -3,
    paid: 1200,
    owed: 400,
    unpaidMonths: 1
  }
];
const REFUSED = {
  tenant: 'E2E-TERMPAY-Refused',
  apartment: 'E2E-TERMPAY-Apt4',
  owed: RENT * (MONTHS_BACK + 1)
};
const FIXTURES = {
  tenants: [...SHAPES.map((s) => s.tenant), REFUSED.tenant],
  properties: [...SHAPES.map((s) => s.apartment), REFUSED.apartment]
};

test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 });

let seed: LeaseSeed;
const tenantIds: Record<string, string> = {};

// `+ 0` only turns a rounded -0 into 0, which `toBe(0)` would otherwise refuse.
const cents = (n: number) => Math.round(n * 100) / 100 + 0;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** Everything billed up to this month minus everything paid: what the tenant really owes. */
function reallyOwed(months: LedgerMonth[]): number {
  const kept = months.filter((m) => m.term <= CURRENT.term);
  return cents(
    kept.reduce((sum, m) => sum + (m.totalToPay - m.balance) - m.payment, 0)
  );
}

async function openTerminateWindow(page: Page, tenantId: string) {
  await page.goto(
    `el/${encodeURIComponent(seed.realmName)}/tenants/${tenantId}`
  );
  await page.getByRole('button', { name: 'Τερματισμός' }).first().click();
  const dialog = page.locator('[role=dialog]');
  await expect(dialog).toBeVisible();
  const today = new Date();
  await dialog
    .locator('#terminationDate')
    .fill(
      `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`
    );
  return dialog;
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
  for (const [i, shape] of SHAPES.entries()) {
    const created = await createLedgerTenant(api, seed, {
      tenantName: shape.tenant,
      propertyName: shape.apartment,
      afmFirst8: `9990000${i + 4}`,
      rent: RENT,
      monthsBack: MONTHS_BACK
    });
    tenantIds[shape.key] = created.tenantId;
    await payByApi(
      api,
      seed,
      created.tenantId,
      monthRef(shape.paidOn),
      shape.paid
    );
  }
  const refused = await createLedgerTenant(api, seed, {
    tenantName: REFUSED.tenant,
    propertyName: REFUSED.apartment,
    afmFirst8: '99900000',
    rent: RENT,
    monthsBack: MONTHS_BACK
  });
  tenantIds.refused = refused.tenantId;
  await api.dispose();
});

test.afterAll(async () => {
  if (!seed) return;
  const api = await request.newContext();
  await removeLedgerFixtures(api, seed, FIXTURES);
  await api.dispose();
});

for (const shape of SHAPES) {
  test(`«${shape.key}»: the window offers ${shape.owed} €, writes off exactly that, and the lease ends owing nothing`, async ({
    page
  }) => {
    const tenantId = tenantIds[shape.key];
    const api = await request.newContext();

    // The starting point, from the server: four months billed, one payment.
    const before = await ledgerOf(api, seed, tenantId);
    expect(
      reallyOwed(before.months),
      'really owed before, from the ledger'
    ).toBe(shape.owed);
    expect(before.terminated, 'the lease is running').toBe(false);

    await signIn(page);
    const dialog = await openTerminateWindow(page, tenantId);

    // What the window says is still unpaid up to the termination, and what it offers.
    const keptLine = dialog.getByText(/μέχρι τον τερματισμό —/);
    await expect(
      keptLine,
      'the «unpaid up to the termination» line'
    ).toHaveCount(1, { timeout: 30_000 });
    const keptText = (await keptLine.innerText()).replace(/\s+/g, ' ');
    const offer = dialog
      .locator('label')
      .filter({ hasText: 'Διαγράψτε λογιστικά τα' });
    await expect(offer, 'the write-off offer').toHaveCount(1);
    const offerText = (await offer.innerText()).replace(/\s+/g, ' ');
    console.log(`[70] «${shape.key}» window: ${keptText} | ${offerText}`);

    const kept = keptText.match(
      /^(\d+) μήν(?:ες μένουν ανεξόφλητοι|ας μένει ανεξόφλητος) μέχρι τον τερματισμό — ([\d.]+,\d{2})\s*€/
    );
    expect(
      kept,
      `the line reads as a count and an amount: «${keptText}»`
    ).toBeTruthy();
    expect(
      { months: Number(kept![1]), amount: parseEuro(kept![2]) },
      'unpaid up to the termination, as the window states it'
    ).toEqual({ months: shape.unpaidMonths, amount: shape.owed });
    const offered = offerText.match(
      /Διαγράψτε λογιστικά τα ([\d.]+,\d{2})\s*€/
    );
    expect(offered, `the offer names an amount: «${offerText}»`).toBeTruthy();
    expect(parseEuro(offered![1]), 'the amount offered for write-off').toBe(
      shape.owed
    );

    // Accept the write-off and end the lease.
    await offer.locator('input[type=checkbox]').check();
    const terminated = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/v2/tenants/${tenantId}`) &&
        r.request().method() === 'PATCH',
      { timeout: 120_000 }
    );
    await dialog
      .getByRole('button', { name: 'Τερματισμός', exact: true })
      .click();
    const response = await terminated;
    expect(
      response.status(),
      `the termination is saved: ${await response.text().catch(() => '')}`
    ).toBe(200);
    await expect(dialog).toBeHidden({ timeout: 60_000 });

    // The ledger the server now holds.
    const after = await ledgerOf(api, seed, tenantId);
    await api.dispose();
    console.log(
      `[70] «${shape.key}» ledger after: ${JSON.stringify(after.months)}`
    );
    expect(after.terminated, 'the lease is ended').toBe(true);
    expect(
      after.months.filter((m) => m.term > CURRENT.term),
      'months after the termination are gone'
    ).toEqual([]);
    expect(
      cents(after.months.reduce((sum, m) => sum + m.discount, 0)),
      'the recorded write-offs add up to what was really owed'
    ).toBe(shape.owed);
    expect(
      after.months.filter((m) => m.discount > 0).length,
      'months that carry a write-off'
    ).toBe(shape.unpaidMonths);
    expect(
      cents(after.months.reduce((sum, m) => sum + m.payment, 0)),
      'what the tenant paid is untouched'
    ).toBe(shape.paid);
    // No clamp: a credit here would be money the tenant never paid.
    expect(
      cents(after.months[after.months.length - 1].newBalance),
      'the last month of the lease: nothing owed, nothing in credit'
    ).toBe(0);
    expect(reallyOwed(after.months), 'really owed after').toBe(0);
  });
}

test('«refused»: the write-offs land, the termination is refused, and the same window then finishes the job', async ({
  page
}) => {
  const tenantId = tenantIds.refused;
  const api = await request.newContext();
  const before = await ledgerOf(api, seed, tenantId);
  expect(reallyOwed(before.months), 'really owed before').toBe(REFUSED.owed);

  await signIn(page);
  const dialog = await openTerminateWindow(page, tenantId);
  const keptLine = dialog.getByText(/μέχρι τον τερματισμό —/);
  const offer = dialog
    .locator('label')
    .filter({ hasText: 'Διαγράψτε λογιστικά τα' });
  await expect(offer, 'the write-off offer').toHaveCount(1, {
    timeout: 30_000
  });
  await offer.locator('input[type=checkbox]').check();
  // No deposit is held on this lease, so any refund is more than the deposit.
  await dialog.locator('#guarantyPayback').fill('100');

  const terminateRequest = () =>
    page.waitForResponse(
      (r) =>
        r.url().includes(`/api/v2/tenants/${tenantId}`) &&
        r.request().method() === 'PATCH',
      { timeout: 120_000 }
    );
  const submit = dialog.getByRole('button', {
    name: 'Τερματισμός',
    exact: true
  });

  // First press: every month is written off, then the server refuses the termination.
  let answered = terminateRequest();
  await submit.click();
  expect((await answered).status(), 'the termination is refused').toBe(422);

  const between = await ledgerOf(api, seed, tenantId);
  expect(between.terminated, 'the lease is still running').toBe(false);
  expect(
    cents(between.months.reduce((sum, m) => sum + m.discount, 0)),
    'the write-offs are on the ledger'
  ).toBe(REFUSED.owed);

  // The window shows the ledger as it now stands: nothing left up to the termination,
  // nothing left to offer.
  await expect(dialog, 'the window stays open').toBeVisible();
  await expect(
    keptLine,
    'the «unpaid up to the termination» line after the refusal'
  ).toHaveCount(0, { timeout: 30_000 });
  await expect(offer, 'the write-off offer after the refusal').toHaveCount(0);

  // The landlord corrects the refund and presses again.
  await dialog.locator('#guarantyPayback').fill('0');
  await expect(submit, 'the button is back').toBeVisible({ timeout: 30_000 });
  answered = terminateRequest();
  await submit.click();
  const second = await answered;
  expect(
    second.status(),
    `the second press ends the lease: ${await second.text().catch(() => '')}`
  ).toBe(200);
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  const after = await ledgerOf(api, seed, tenantId);
  await api.dispose();
  console.log(`[70] «refused» ledger after: ${JSON.stringify(after.months)}`);
  expect(after.terminated, 'the lease is ended').toBe(true);
  // Each month written off once: four months of exactly its rent.
  expect(
    after.months.map((m) => m.discount),
    'what each month carries as a write-off'
  ).toEqual(after.months.map(() => RENT));
  expect(
    cents(after.months[after.months.length - 1].newBalance),
    'the last month of the lease: nothing owed, nothing in credit'
  ).toBe(0);
});
