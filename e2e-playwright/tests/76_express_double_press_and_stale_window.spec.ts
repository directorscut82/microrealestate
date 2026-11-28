/**
 * TWO WAYS A SAVE WENT WRONG ON THE RENTS PAGE, found by review on 28/11/2026.
 *
 * 1. «Έξπρες εξόφληση» → «Εκτέλεση» pressed twice in the same instant. The button was
 *    disabled only after the screen had re-rendered, so the second press sent the whole
 *    batch again. The server's version check refused one of the two writes of every
 *    tenant (409), so each payment was stored once — but the screen showed two warnings
 *    «Καταχωρήθηκαν 1 από 2 πληρωμές (1 απέτυχαν)» for a batch that had gone through.
 *    Now: ONE request leaves the page, ONE toast «Καταχωρήθηκαν 2 καταβολές», no warning.
 *
 * 2. A payment saved from a window that is out of date. Two windows on one tenant's month;
 *    a payment is saved in the first; the second (opened before) is refused by the server
 *    with 409 — the decided behaviour — and the payment window toasted the server's
 *    English text. Now: the Greek sentence the terminate window already uses.
 *
 * Self-cleaning: the tenants and their apartments are removed before and after the run,
 * and the run fails if any is left. Every identifier is from the reserved synthetic bands.
 */
import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { ensureSeedLease, LeaseSeed } from './lib/api';
import {
  createLedgerTenant,
  LedgerTenant,
  monthRef,
  openRents,
  readRentRow,
  rentRow,
  removeLedgerFixtures,
  serverAndBrowserAgreeOnTheMonth,
  signIn
} from './lib/ledger';

const GATEWAY = process.env.NAS_GATEWAY_URL as string;
const CURRENT = monthRef(0);
const PREFIX = 'E2E-EXPRESS2';
const F = {
  express: [`${PREFIX}-Alpha`, `${PREFIX}-Beta`],
  expressApartments: [`${PREFIX}-AptAlpha`, `${PREFIX}-AptBeta`],
  stale: `${PREFIX}-Gamma`,
  staleApartment: `${PREFIX}-AptGamma`
};
const FIXTURES = {
  tenants: [...F.express, F.stale],
  properties: [...F.expressApartments, F.staleApartment]
};
const RENT = { alpha: 400, beta: 350, gamma: 300 };
const STALE_WINDOW_IN_GREEK =
  'Ο ενοικιαστής τροποποιήθηκε από άλλο παράθυρο. Φορτώστε ξανά τη σελίδα και δοκιμάστε πάλι.';

test.describe.configure({ timeout: 4 * 60_000 });

let seed: LeaseSeed;
let alpha: LedgerTenant;
let beta: LedgerTenant;
let gamma: LedgerTenant;

const headers = () => ({
  Authorization: `Bearer ${seed.token}`,
  organizationid: seed.realmId
});

/** The amounts of the payments a tenant holds on this month, as the server stores them. */
async function paymentsOf(
  api: APIRequestContext,
  tenant: LedgerTenant
): Promise<number[]> {
  const r = await api.get(`${GATEWAY}/api/v2/rents/tenant/${tenant.tenantId}`, {
    headers: headers()
  });
  expect(r.status(), `rents of ${tenant.tenantName}`).toBe(200);
  const month = ((await r.json()).rents || []).find(
    (m: { term: number }) => Number(m.term) === CURRENT.term
  );
  return ((month?.payments || []) as Array<{ amount: number }>).map((p) =>
    Number(p.amount)
  );
}

/** Names of this spec's tenants and apartments that are still in the realm. */
async function leftovers(api: APIRequestContext): Promise<string[]> {
  const names: string[] = [];
  for (const resource of ['tenants?includeArchived=true', 'properties']) {
    const r = await api.get(`${GATEWAY}/api/v2/${resource}`, {
      headers: headers()
    });
    expect(r.status(), `list ${resource}`).toBe(200);
    const body = await r.json();
    const list = (Array.isArray(body) ? body : body.items || []) as Array<{
      name: string;
    }>;
    names.push(...list.map((x) => x.name).filter((n) => n.startsWith(PREFIX)));
  }
  return names;
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
  const api = await request.newContext();
  seed = await ensureSeedLease(api);
  await removeLedgerFixtures(api, seed, FIXTURES);

  // Leases that begin this month: each owes its rent and nothing before it.
  alpha = await createLedgerTenant(api, seed, {
    tenantName: F.express[0],
    propertyName: F.expressApartments[0],
    afmFirst8: '99900020',
    rent: RENT.alpha,
    monthsBack: 0
  });
  beta = await createLedgerTenant(api, seed, {
    tenantName: F.express[1],
    propertyName: F.expressApartments[1],
    afmFirst8: '99900021',
    rent: RENT.beta,
    monthsBack: 0
  });
  gamma = await createLedgerTenant(api, seed, {
    tenantName: F.stale,
    propertyName: F.staleApartment,
    afmFirst8: '99900022',
    rent: RENT.gamma,
    monthsBack: 0
  });
  await api.dispose();
});

test.afterAll(async () => {
  if (!seed) return;
  const api = await request.newContext();
  await removeLedgerFixtures(api, seed, FIXTURES);
  expect(await leftovers(api), 'no fixture of this spec is left').toEqual([]);
  await api.dispose();
});

test('a double press on «Εκτέλεση» records each payment once and says so', async ({
  page
}) => {
  const api = await request.newContext();
  const batches: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rents/express')) {
      batches.push(r.url());
    }
  });
  await signIn(page);
  await openRents(page, seed.realmName, CURRENT, PREFIX);
  await expect(rentRow(page, alpha.tenantName)).toHaveCount(1);

  await page.locator('[data-cy="expressPaymentBtn"]').click();
  const drawer = page.locator('[role=dialog][vaul-drawer]');
  await expect(drawer).toBeVisible();
  for (const tenant of [alpha, beta]) {
    await drawer
      .locator(`label:has(span.font-medium:text-is("${tenant.tenantName}"))`)
      .locator('[role="checkbox"]')
      .first()
      .click();
  }
  const submit = drawer
    .locator('button')
    .filter({ hasText: /^Εκτέλεση$/ })
    .last();
  await expect(submit, 'both ticked: the button is enabled').toBeEnabled();

  // Two presses in the same task: the screen cannot have reacted to the first.
  await submit.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });

  const toasts = page.locator('[data-sonner-toast]');
  await expect(toasts.first(), 'the batch is answered').toBeVisible({
    timeout: 60_000
  });
  expect(batches, 'requests to /rents/express that left the page').toHaveLength(
    1
  );
  await expect(
    toasts.filter({ hasText: 'Καταχωρήθηκαν 2 καταβολές' }),
    'one toast says both payments were recorded'
  ).toHaveCount(1);
  await expect(
    toasts.filter({ hasText: 'απέτυχαν' }),
    'no toast says a payment failed'
  ).toHaveCount(0);
  await expect(drawer).toBeHidden({ timeout: 30_000 });

  expect(
    await paymentsOf(api, alpha),
    'one payment, of what Alpha owed'
  ).toEqual([RENT.alpha]);
  expect(await paymentsOf(api, beta), 'one payment, of what Beta owed').toEqual(
    [RENT.beta]
  );
  await expect
    .poll(async () => (await readRentRow(page, alpha.tenantName)).payment, {
      message: '«Καταβολή» of Alpha on the rents page'
    })
    .toBe(RENT.alpha);
  await expect
    .poll(async () => (await readRentRow(page, beta.tenantName)).payment, {
      message: '«Καταβολή» of Beta on the rents page'
    })
    .toBe(RENT.beta);
  expect(batches, 'still one request after the screen settled').toHaveLength(1);
  await api.dispose();
});

/** The payment window of a tenant's row, opened. */
async function openPaymentWindow(page: Page, tenantName: string) {
  await rentRow(page, tenantName)
    .getByRole('button', { name: 'Καταχώρηση πληρωμής' })
    .click();
  const dialog = page.locator('[role=dialog]');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Type a new payment in an open window and press «Εκτέλεση»; the answer to the save. */
async function saveNewPayment(page: Page, amount: number) {
  await page.locator('[data-cy="addNewPayment"]').click();
  await page.locator('input[name="payments.0.amount"]').fill(String(amount));
  const saved = page.waitForResponse(
    (r) =>
      r.url().includes('/api/v2/rents/payment/') &&
      r.request().method() === 'PATCH',
    { timeout: 60_000 }
  );
  await page
    .locator('[role=dialog]')
    .locator('button')
    .filter({ hasText: /Εκτέλεση/ })
    .first()
    .click();
  return saved;
}

test('a payment from a window that is out of date is refused in Greek', async ({
  page
}) => {
  const api = await request.newContext();
  const first = page;
  const second = await page.context().newPage();
  try {
    await signIn(first);
    for (const window of [first, second]) {
      await openRents(window, seed.realmName, CURRENT, gamma.tenantName);
      await expect(rentRow(window, gamma.tenantName)).toHaveCount(1);
    }
    // both windows are open on the month before anything is saved
    await openPaymentWindow(first, gamma.tenantName);
    await openPaymentWindow(second, gamma.tenantName);

    const firstAnswer = await saveNewPayment(first, 100);
    expect(firstAnswer.status(), 'the first window saves').toBe(200);
    await expect(first.locator('[role=dialog]')).toBeHidden({
      timeout: 30_000
    });

    const secondAnswer = await saveNewPayment(second, 250);
    expect(secondAnswer.status(), 'the second window is refused').toBe(409);
    await expect(
      second.locator('[data-sonner-toast][data-type="error"]'),
      'one refusal on the screen, in Greek'
    ).toHaveText(STALE_WINDOW_IN_GREEK);

    expect(await paymentsOf(api, gamma), 'the month holds one payment').toEqual(
      [100]
    );
  } finally {
    await second.close();
    await api.dispose();
  }
});
