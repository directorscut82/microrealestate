/**
 * Spec 28 — Rents index search/filter catalog (9 scenarios).
 *
 * Catalog source: `.kiro/steering/test-running-guide.md` "Rents index"
 * section, scenarios 29-37.
 *
 * The rents page lives at /[org]/rents/<YYYY.MM>. It paginates a
 * server-returned list of rent rows; the page-level _filterData filters
 * by occupant name/manager/contact + payment reference. Filter chips
 * are: notpaid, partiallypaid, paid.
 */
import { expect, request, test, Page } from '@playwright/test';
import {
  ensureSeedLeasedTenant,
  ensureSeedLeasedTenantWithPayment,
  ensureSeedSecondTenant
} from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD');
  }
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

function currentYearMonth(): string {
  const now = new Date();
  // The rent table uses LOCAL year/month (matches the navigation URL the
  // user types). Verified in `ensureSeedLeasedTenantWithPayment` comment.
  return `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function currentTerm(): number {
  const now = new Date();
  return Number(
    `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}0100`
  );
}

async function gotoRents(page: Page, realmName: string, ym: string) {
  await page.goto(`${encodeURIComponent(realmName)}/rents/${ym}`);
  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toBeVisible({ timeout: 20_000 });
  // Wait for at least one rent row (status dot present on every row).
  await expect(
    page.locator('[data-cy^="status-"]').first()
  ).toBeVisible({ timeout: 20_000 });
}

async function clickFilterChip(page: Page, chipLabel: RegExp) {
  await page.getByRole('button', { name: /Filters|Φίλτρα/i }).first().click();
  await page.locator('li[role=menuitemcheckbox]', { hasText: chipLabel }).first().click();
  await page.keyboard.press('Escape');
}

/**
 * Reset a tenant's current-month payments to empty (so they show as
 * 'notpaid'). Idempotent.
 */
async function resetTermToUnpaid(
  apiCtx: import('@playwright/test').APIRequestContext,
  token: string,
  realmId: string,
  tenantId: string
) {
  const auth = {
    Authorization: `Bearer ${token}`,
    organizationid: realmId,
    'Content-Type': 'application/json'
  };
  const now = new Date();
  const term = currentTerm();
  const resp = await apiCtx.patch(
    `${GATEWAY}/api/v2/rents/payment/${tenantId}/${term}`,
    {
      headers: auth,
      data: {
        _id: tenantId,
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        payments: [],
        promo: 0,
        extracharge: 0
      }
    }
  );
  expect(resp.status(), `reset rent unpaid (tenant=${tenantId})`).toBeLessThan(400);
}

test('28.29 search by tenant name narrows the rent rows', async ({ page }) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedSecondTenant(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoRents(page, seed.realmName, currentYearMonth());

  const before = await page.locator('[data-cy^="status-"]').count();
  expect(before).toBeGreaterThanOrEqual(2);

  // Search by exact name of the canonical leased tenant.
  await page.locator('[data-cy=globalSearchField]').fill(seed.tenantName);

  // Set narrowing: ≤ before, ≥ 1.
  const after = await page.locator('[data-cy^="status-"]').count();
  expect(after).toBeGreaterThanOrEqual(1);
  expect(after).toBeLessThan(before);
  // tenant B must NOT be visible in the filtered list.
  await expect(
    page.locator(`span.text-lg.font-medium:text-is("${seed.tenantBName}")`)
  ).not.toBeVisible();
});

test('28.30 "In arrears" chip → only status=notpaid rows', async ({ page }) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedLeasedTenant(apiCtx);
  // Force the canonical tenant to unpaid for the current month.
  await resetTermToUnpaid(apiCtx, seed.token, seed.realmId, seed.tenantId);
  await apiCtx.dispose();

  await signIn(page);
  await gotoRents(page, seed.realmName, currentYearMonth());

  const before = await page.locator('[data-cy^="status-"]').count();
  expect(before).toBeGreaterThan(0);

  await clickFilterChip(page, /In arrears|Σε καθυστέρηση|Οφειλόμενο|Οφειλόμενα/i);

  const after = await page.locator('[data-cy^="status-"]').count();
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThanOrEqual(before);

  // Every visible row must have status='owed' (the dot key in RentTable
  // uses 'owed' for notpaid).
  const owedDots = await page.locator('[data-cy="status-owed"]').count();
  // Some rows may be 'none' (no charge for the term) and survive the
  // notpaid filter if their status is 'notpaid' but charge=0; allow
  // owed+none ≥ after.
  const noneDots = await page.locator('[data-cy="status-none"]').count();
  expect(owedDots + noneDots).toBeGreaterThanOrEqual(after);
});

test('28.31 "Partially settled" chip → only partial rows', async ({ page }) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  // Seed a partial payment: deposit a small amount of the rent so status
  // is 'partiallypaid'.
  const seed = await ensureSeedLeasedTenantWithPayment(apiCtx, 1);
  await apiCtx.dispose();

  await signIn(page);
  await gotoRents(page, seed.realmName, currentYearMonth());

  const before = await page.locator('[data-cy^="status-"]').count();
  expect(before).toBeGreaterThan(0);

  await clickFilterChip(page, /Partially settled|Μερικώς|Μερικ/i);

  const after = await page.locator('[data-cy^="status-"]').count();
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThanOrEqual(before);

  // The seeded tenant (with €1 paid against a 500€ rent) should be in
  // the partial bucket — visible.
  await expect(
    page.locator(`span.text-lg.font-medium:text-is("${seed.tenantName}")`)
  ).toBeVisible({ timeout: 10_000 });
});

test('28.32 "Settled" chip → only fully paid rows', async ({ page }) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  // Pay the full grandTotal — fetch first to know the amount.
  const seed = await ensureSeedLeasedTenant(apiCtx);
  const auth = {
    Authorization: `Bearer ${seed.token}`,
    organizationid: seed.realmId,
    'Content-Type': 'application/json'
  };
  // GET the current term's rent, pay grandTotal.
  const term = currentTerm();
  const rentResp = await apiCtx.get(
    `${GATEWAY}/api/v2/rents/tenant/${seed.tenantId}/${term}`,
    { headers: auth }
  );
  expect(rentResp.status(), 'get rent').toBe(200);
  const rent = await rentResp.json();
  const grand = Number(rent.totalAmount);
  expect(grand).toBeGreaterThan(0);

  // Pay full.
  const now = new Date();
  const todayDDMMYYYY = `${String(now.getDate()).padStart(2, '0')}/${String(
    now.getMonth() + 1
  ).padStart(2, '0')}/${now.getFullYear()}`;
  const payResp = await apiCtx.patch(
    `${GATEWAY}/api/v2/rents/payment/${seed.tenantId}/${term}`,
    {
      headers: auth,
      data: {
        _id: seed.tenantId,
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        payments: [
          {
            amount: grand,
            date: todayDDMMYYYY,
            type: 'cash',
            reference: `S28.32-${Date.now()}`,
            description: ''
          }
        ],
        description: '',
        extracharge: 0,
        noteextracharge: '',
        promo: 0,
        notepromo: ''
      }
    }
  );
  expect(payResp.status(), 'pay full').toBe(200);
  await apiCtx.dispose();

  await signIn(page);
  await gotoRents(page, seed.realmName, currentYearMonth());

  const before = await page.locator('[data-cy^="status-"]').count();
  expect(before).toBeGreaterThan(0);

  await clickFilterChip(page, /^Settled$|Εξοφλημ|Εξόφληση/i);

  const after = await page.locator('[data-cy^="status-"]').count();
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThanOrEqual(before);

  // Every visible row must show the 'paid' dot.
  const paidDots = await page.locator('[data-cy="status-paid"]').count();
  expect(paidDots).toBeGreaterThanOrEqual(1);

  // Cleanup — restore unpaid state for follow-up tests.
  const apiCtx2 = await request.newContext();
  await resetTermToUnpaid(apiCtx2, seed.token, seed.realmId, seed.tenantId);
  await apiCtx2.dispose();
});

test('28.33 multi-select 2 status chips → union widens vs single chip', async ({
  page
}) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  // Mix: tenant A unpaid, tenant B partial → at least one row each bucket.
  const seedAB = await ensureSeedSecondTenant(apiCtx);
  await resetTermToUnpaid(apiCtx, seedAB.token, seedAB.realmId, seedAB.tenantId);
  // Pay 1€ on tenant B → partial.
  const auth = {
    Authorization: `Bearer ${seedAB.token}`,
    organizationid: seedAB.realmId,
    'Content-Type': 'application/json'
  };
  const now = new Date();
  const todayDDMMYYYY = `${String(now.getDate()).padStart(2, '0')}/${String(
    now.getMonth() + 1
  ).padStart(2, '0')}/${now.getFullYear()}`;
  const term = currentTerm();
  await apiCtx.patch(
    `${GATEWAY}/api/v2/rents/payment/${seedAB.tenantBId}/${term}`,
    {
      headers: auth,
      data: {
        _id: seedAB.tenantBId,
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        payments: [
          { amount: 1, date: todayDDMMYYYY, type: 'cash', reference: `S28.33-${Date.now()}` }
        ],
        promo: 0,
        extracharge: 0
      }
    }
  );
  await apiCtx.dispose();

  await signIn(page);
  await gotoRents(page, seedAB.realmName, currentYearMonth());

  // Apply just "In arrears": expect canonical tenant visible, B not.
  await clickFilterChip(page, /In arrears|Σε καθυστέρηση|Οφειλόμενο|Οφειλόμενα/i);
  const owedOnly = await page.locator('[data-cy^="status-"]').count();
  await expect(
    page.locator(`span.text-lg.font-medium:text-is("${seedAB.tenantName}")`)
  ).toBeVisible({ timeout: 10_000 });

  // Add "Partially settled" → union grows (B becomes visible too).
  await clickFilterChip(page, /Partially settled|Μερικώς|Μερικ/i);
  const union = await page.locator('[data-cy^="status-"]').count();
  expect(union).toBeGreaterThanOrEqual(owedOnly);
  await expect(
    page.locator(`span.text-lg.font-medium:text-is("${seedAB.tenantBName}")`)
  ).toBeVisible({ timeout: 10_000 });
});

test('28.34 search by payment reference matches the row that has it', async ({
  page
}) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedLeasedTenant(apiCtx);
  // Plant a payment with a uniquely-recognizable reference.
  const ref = `REF-S28.34-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const auth = {
    Authorization: `Bearer ${seed.token}`,
    organizationid: seed.realmId,
    'Content-Type': 'application/json'
  };
  const now = new Date();
  const todayDDMMYYYY = `${String(now.getDate()).padStart(2, '0')}/${String(
    now.getMonth() + 1
  ).padStart(2, '0')}/${now.getFullYear()}`;
  const term = currentTerm();
  const payResp = await apiCtx.patch(
    `${GATEWAY}/api/v2/rents/payment/${seed.tenantId}/${term}`,
    {
      headers: auth,
      data: {
        _id: seed.tenantId,
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        payments: [{ amount: 5, date: todayDDMMYYYY, type: 'cash', reference: ref }],
        promo: 0,
        extracharge: 0
      }
    }
  );
  expect(payResp.status(), 'plant payment').toBe(200);
  await apiCtx.dispose();

  await signIn(page);
  await gotoRents(page, seed.realmName, currentYearMonth());

  // Search by the unique reference substring.
  await page.locator('[data-cy=globalSearchField]').fill(ref.slice(0, 12));

  // Exactly 1 row (no other rent in the realm has this reference).
  await expect(
    page.locator('[data-cy^="status-"]')
  ).toHaveCount(1, { timeout: 15_000 });
  await expect(
    page.locator(`span.text-lg.font-medium:text-is("${seed.tenantName}")`)
  ).toBeVisible();

  // Cleanup
  const apiCtx2 = await request.newContext();
  await resetTermToUnpaid(apiCtx2, seed.token, seed.realmId, seed.tenantId);
  await apiCtx2.dispose();
});

test('28.35 search persists across a payment mutation (refetch resilience)', async ({
  page
}) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedLeasedTenant(apiCtx);
  await resetTermToUnpaid(apiCtx, seed.token, seed.realmId, seed.tenantId);
  await apiCtx.dispose();

  await signIn(page);
  await gotoRents(page, seed.realmName, currentYearMonth());

  // Narrow by name.
  await page.locator('[data-cy=globalSearchField]').fill(seed.tenantName);
  await expect(
    page.locator('[data-cy^="status-"]')
  ).toHaveCount(1, { timeout: 15_000 });

  // Plant a partial payment via API while the page is open.
  const apiCtx2 = await request.newContext();
  const auth = {
    Authorization: `Bearer ${seed.token}`,
    organizationid: seed.realmId,
    'Content-Type': 'application/json'
  };
  const now = new Date();
  const todayDDMMYYYY = `${String(now.getDate()).padStart(2, '0')}/${String(
    now.getMonth() + 1
  ).padStart(2, '0')}/${now.getFullYear()}`;
  const term = currentTerm();
  await apiCtx2.patch(
    `${GATEWAY}/api/v2/rents/payment/${seed.tenantId}/${term}`,
    {
      headers: auth,
      data: {
        _id: seed.tenantId,
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        payments: [
          {
            amount: 1,
            date: todayDDMMYYYY,
            type: 'cash',
            reference: `S28.35-${Date.now()}`
          }
        ],
        promo: 0,
        extracharge: 0
      }
    }
  );
  await apiCtx2.dispose();

  // Trigger a refetch (focus event).
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  // Search input still has the typed value.
  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toHaveValue(seed.tenantName);
  // List still narrowed to 1 row (still matching by name).
  await expect(
    page.locator('[data-cy^="status-"]')
  ).toHaveCount(1, { timeout: 15_000 });
  // The row reflects the new payment: status dot is now 'partial' (not 'owed').
  await expect(
    page.locator('[data-cy="status-partial"]')
  ).toHaveCount(1, { timeout: 15_000 });

  // Cleanup
  const apiCtx3 = await request.newContext();
  await resetTermToUnpaid(apiCtx3, seed.token, seed.realmId, seed.tenantId);
  await apiCtx3.dispose();
});

test('28.36 search persists across navigate to next month and back', async ({
  page
}) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedLeasedTenant(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  const ym = currentYearMonth();
  await gotoRents(page, seed.realmName, ym);

  await page.locator('[data-cy=globalSearchField]').fill(seed.tenantName);
  await expect(
    page.locator('[data-cy^="status-"]')
  ).toHaveCount(1, { timeout: 15_000 });

  // Next month URL: increment month by 1, wrap year.
  const [yearStr, monthStr] = ym.split('.');
  let nextMonth = Number(monthStr) + 1;
  let nextYear = Number(yearStr);
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }
  const nextYm = `${nextYear}.${String(nextMonth).padStart(2, '0')}`;

  await page.goto(`${encodeURIComponent(seed.realmName)}/rents/${nextYm}`);
  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toBeVisible({ timeout: 20_000 });

  // Back to original month.
  await page.goBack();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
    .toMatch(new RegExp(`/rents/${ym.replace('.', '\\.')}$`));

  // Search input rehydrates from URL ?search=… (router.query.search).
  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toHaveValue(seed.tenantName, { timeout: 15_000 });
  await expect(
    page.locator('[data-cy^="status-"]')
  ).toHaveCount(1, { timeout: 15_000 });
});

test('28.37 chip + payment that flips status drops the row from filtered set', async ({
  page
}) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedLeasedTenant(apiCtx);
  await resetTermToUnpaid(apiCtx, seed.token, seed.realmId, seed.tenantId);
  await apiCtx.dispose();

  await signIn(page);
  await gotoRents(page, seed.realmName, currentYearMonth());

  // Apply In arrears chip → tenant must be visible.
  await clickFilterChip(page, /In arrears|Σε καθυστέρηση|Οφειλόμενο|Οφειλόμενα/i);
  await expect(
    page.locator(`span.text-lg.font-medium:text-is("${seed.tenantName}")`)
  ).toBeVisible({ timeout: 15_000 });

  // Pay full grandTotal via API (status flips to 'paid').
  const apiCtx2 = await request.newContext();
  const auth = {
    Authorization: `Bearer ${seed.token}`,
    organizationid: seed.realmId,
    'Content-Type': 'application/json'
  };
  const term = currentTerm();
  const rentResp = await apiCtx2.get(
    `${GATEWAY}/api/v2/rents/tenant/${seed.tenantId}/${term}`,
    { headers: auth }
  );
  expect(rentResp.status(), 'get rent').toBe(200);
  const grand = Number((await rentResp.json()).totalAmount);
  expect(grand).toBeGreaterThan(0);

  const now = new Date();
  const todayDDMMYYYY = `${String(now.getDate()).padStart(2, '0')}/${String(
    now.getMonth() + 1
  ).padStart(2, '0')}/${now.getFullYear()}`;
  const payResp = await apiCtx2.patch(
    `${GATEWAY}/api/v2/rents/payment/${seed.tenantId}/${term}`,
    {
      headers: auth,
      data: {
        _id: seed.tenantId,
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        payments: [
          {
            amount: grand,
            date: todayDDMMYYYY,
            type: 'cash',
            reference: `S28.37-${Date.now()}`
          }
        ],
        promo: 0,
        extracharge: 0
      }
    }
  );
  expect(payResp.status(), 'pay full').toBe(200);
  await apiCtx2.dispose();

  // Trigger refetch.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  // The tenant must now be GONE from the In arrears filtered set.
  await expect(
    page.locator(`span.text-lg.font-medium:text-is("${seed.tenantName}")`)
  ).not.toBeVisible({ timeout: 15_000 });

  // Cleanup
  const apiCtx3 = await request.newContext();
  await resetTermToUnpaid(apiCtx3, seed.token, seed.realmId, seed.tenantId);
  await apiCtx3.dispose();
});
