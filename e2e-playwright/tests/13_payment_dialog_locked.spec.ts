import { expect, request, test } from '@playwright/test';
import { ensureSeedLeasedTenantWithPayment } from './lib/api';

/**
 * Wave-26 round-3f (Approach A): payment dialog renders existing
 * payments as LOCKED tiles instead of dropping them into editable form
 * fields. Re-opening the dialog on an already-paid rent must show:
 *   - one read-only tile per saved payment (no inputs)
 *   - "+ Add another payment" button (not "+ Add a payment")
 *   - per-tile ✏️ edit and 🗑 delete affordances
 *
 * The spec drives all three flows the user will reach for after the
 * first save: ADD-ANOTHER, EDIT, and DELETE. Each leg asserts:
 *   - the PATCH /rents/payment/{id}/{term} round-trip returns 200
 *   - the server-side `payment` total reflects the staged change
 *   - the rent-table Payment cell reflects the new total after the
 *     react-query invalidation cycle (i.e. the UI doesn't lie)
 */

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD.');
  }
});

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
    .toMatch(/\/(firstaccess|dashboard)/);
}

async function openTenantPaymentDialog(
  page: import('@playwright/test').Page,
  realmName: string,
  tenantName: string
) {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}`;
  await page.goto(`${encodeURIComponent(realmName)}/rents/${yearMonth}`);

  const nameSpan = page
    .locator('span.text-lg.font-medium', { hasText: tenantName })
    .first();
  await expect(nameSpan).toBeVisible({ timeout: 20_000 });
  const tenantRow = nameSpan.locator(
    'xpath=ancestor::div[contains(@class, "flex") and .//*[contains(@class, "text-right")]][1]'
  );
  // Cash-register icon is the first svg.size-6 button in the row (history
  // is the second). Identifying by svg class avoids depending on the
  // tenant having no email (which would hide the checkbox).
  const cashBtn = tenantRow
    .locator('button')
    .filter({ has: page.locator('svg.size-6') })
    .first();
  await cashBtn.click();
  await expect(page.locator('[role=dialog]')).toBeVisible({ timeout: 10_000 });
  return tenantRow;
}

/**
 * Read the visible "Payment" column for the tenant's row. RentAmount
 * renders a flex column where the label sits above the numeric value;
 * we find the label "Payment" (or its Greek translation "Καταβολή")
 * inside the row, then read its sibling NumberFormat. We strip
 * non-digit characters so this stays locale-agnostic ("3.000,50 €" or
 * "3,000.50 €" or "€ 3000.50" all parse).
 */
async function readPaymentCell(
  tenantRow: import('@playwright/test').Locator
): Promise<number> {
  // RentAmount is a flex column; the label is `text-label text-ink-muted`
  // with the literal "Payment" or "Καταβολή", and the numeric value is in
  // the sibling NumberFormat span. Locate the cell by its label.
  const labelDiv = tenantRow
    .locator('div')
    .filter({ hasText: /^(Payment|Καταβολή)$/ })
    .first();
  // The cell is the parent of the label div. Read its full text; that
  // includes the label + the value + currency symbol.
  const cell = labelDiv.locator('xpath=..');
  const raw = (await cell.textContent()) || '';
  // Strip the label, any letters, and currency symbols; keep digits +
  // separators + minus.
  const stripped = raw
    .replace(/Payment|Καταβολή/g, '')
    .replace(/[^\d,.\-]/g, '');
  // Locale handling: many European locales use "." as thousands separator
  // and "," as decimal. If the string has both, the LAST separator is the
  // decimal one. If only "." or only "," is present, treat it as decimal.
  let normalized = stripped;
  if (stripped.includes(',') && stripped.includes('.')) {
    if (stripped.lastIndexOf(',') > stripped.lastIndexOf('.')) {
      normalized = stripped.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = stripped.replace(/,/g, '');
    }
  } else if (stripped.includes(',')) {
    normalized = stripped.replace(',', '.');
  }
  const n = Number(normalized);
  if (isNaN(n)) {
    throw new Error(
      `Cannot parse Payment cell text: raw=${JSON.stringify(raw)} stripped=${stripped}`
    );
  }
  return n;
}

test('Wave-26 round-3f · saved payment renders as locked tile, dialog re-open does not edit in place', async ({
  page
}) => {
  const apiCtx = await request.newContext();
  const seed = await ensureSeedLeasedTenantWithPayment(apiCtx, 100);
  await apiCtx.dispose();

  await signIn(page);
  const tenantRow = await openTenantPaymentDialog(
    page,
    seed.realmName,
    seed.tenantName
  );

  // ASSERT: locked tile present.
  const tile0 = page.locator('[data-cy="savedPayment-0"]');
  await expect(tile0).toBeVisible();
  // No editable inputs inside the saved tile — only the two ghost icon
  // buttons (✏️ + 🗑).
  expect(await tile0.locator('input').count()).toBe(0);
  await expect(page.locator('[data-cy="editSavedPayment-0"]')).toBeVisible();
  await expect(page.locator('[data-cy="deleteSavedPayment-0"]')).toBeVisible();

  // ASSERT: button label is "Add another" since we already have a saved.
  const addBtn = page.locator('[data-cy="addNewPayment"]');
  const addText = (await addBtn.textContent()) || '';
  expect(/Add another|Προσθήκη/i.test(addText)).toBe(true);

  // ASSERT: no editable form is visible by default (no entry rows).
  expect(await page.locator('input[name="payments.0.amount"]').count()).toBe(0);

  // Cancel out — leg-1 doesn't exercise a save.
  await page
    .locator('[role=dialog] button')
    .filter({ hasText: /Cancel|Άκυρο/i })
    .first()
    .click();
  await expect(page.locator('[role=dialog][vaul-drawer]')).not.toBeVisible({
    timeout: 10_000
  });

  // Tenant row's Payment cell should still show the seeded 100.
  await expect.poll(() => readPaymentCell(tenantRow), { timeout: 10_000 }).toBeCloseTo(100, 1);
});

test('Wave-26 round-3f · ADD ANOTHER payment merges with saved tile (server total propagates to UI)', async ({
  page
}) => {
  const apiCtx = await request.newContext();
  const seed = await ensureSeedLeasedTenantWithPayment(apiCtx, 100);
  await apiCtx.dispose();

  await signIn(page);
  const tenantRow = await openTenantPaymentDialog(
    page,
    seed.realmName,
    seed.tenantName
  );

  // Click "+ Add another payment".
  await page.locator('[data-cy="addNewPayment"]').click();

  // Fill amount = 50, date = today.
  await page.locator('input[name="payments.0.amount"]').fill('50');
  await page.locator('#payments\\.0\\.date').click();
  await expect(page.locator('.rdp')).toBeVisible({ timeout: 5_000 });
  const today = String(new Date().getDate());
  await page
    .locator('.rdp button')
    .filter({ hasText: new RegExp(`^${today}$`) })
    .first()
    .click();

  // Press Record.
  const patchPromise = page.waitForResponse(
    (r) =>
      r.url().includes('/api/v2/rents/payment/') &&
      r.request().method() === 'PATCH'
  );
  await page
    .locator('[role=dialog] button')
    .filter({ hasText: /Record|Εκτέλεση/i })
    .first()
    .click();
  const resp = await patchPromise;
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(Number(body.payment), 'server payment = 100 + 50').toBeCloseTo(150, 1);

  // Drawer closes.
  await expect(page.locator('[role=dialog][vaul-drawer]')).not.toBeVisible({
    timeout: 10_000
  });

  // Rent table reflects the new total.
  await expect
    .poll(() => readPaymentCell(tenantRow), { timeout: 15_000 })
    .toBeCloseTo(150, 1);
});

test('Wave-26 round-3f · EDIT a saved payment via the inline form (server total reflects edit)', async ({
  page
}) => {
  // Reseed: reset to a single saved payment of 100€.
  const apiCtx = await request.newContext();
  const seed = await ensureSeedLeasedTenantWithPayment(apiCtx, 100);
  await apiCtx.dispose();

  await signIn(page);
  const tenantRow = await openTenantPaymentDialog(
    page,
    seed.realmName,
    seed.tenantName
  );

  // Click ✏️ on tile 0 — inline edit form opens inside the tile.
  await page.locator('[data-cy="editSavedPayment-0"]').click();

  // The edit form's amount input is the first numeric input inside the
  // tile. Change 100 → 175.
  const tile0 = page.locator('[data-cy="savedPayment-0"]');
  const editAmount = tile0.locator('input[type="number"]').first();
  await editAmount.fill('175');

  // Click "Apply edit" inside the tile.
  await tile0
    .locator('button')
    .filter({ hasText: /Apply edit|Εφαρμογή/i })
    .click();

  // Tile collapses back; amount text now shows 175.
  await expect(tile0).toContainText(/175/);

  // Press Record.
  const patchPromise = page.waitForResponse(
    (r) =>
      r.url().includes('/api/v2/rents/payment/') &&
      r.request().method() === 'PATCH'
  );
  await page
    .locator('[role=dialog] button')
    .filter({ hasText: /Record|Εκτέλεση/i })
    .first()
    .click();
  const resp = await patchPromise;
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(Number(body.payment), 'server payment = 175 (was 100)').toBeCloseTo(175, 1);

  await expect(page.locator('[role=dialog][vaul-drawer]')).not.toBeVisible({
    timeout: 10_000
  });
  await expect
    .poll(() => readPaymentCell(tenantRow), { timeout: 15_000 })
    .toBeCloseTo(175, 1);
});

test('Wave-26 round-3f · DELETE a saved payment via 🗑 + confirm (Record persists empty ledger)', async ({
  page
}) => {
  const apiCtx = await request.newContext();
  const seed = await ensureSeedLeasedTenantWithPayment(apiCtx, 100);
  await apiCtx.dispose();

  await signIn(page);
  const tenantRow = await openTenantPaymentDialog(
    page,
    seed.realmName,
    seed.tenantName
  );

  // Click 🗑 on tile 0.
  await page.locator('[data-cy="deleteSavedPayment-0"]').click();

  // ConfirmDialog footer button: "Continue" (Greek: "Συνέχεια"). Match
  // the button anchored on its exact text so we do not pick up the
  // outer dialog's Record button.
  const confirmBtn = page
    .locator('button')
    .filter({ hasText: /^\s*(Continue|Συνέχεια)\s*$/i })
    .last();
  await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
  await confirmBtn.click();

  // Tile disappears.
  await expect(page.locator('[data-cy="savedPayment-0"]')).not.toBeVisible();

  // Press Record — empty drafts AND empty saved → server replaces with [].
  const patchPromise = page.waitForResponse(
    (r) =>
      r.url().includes('/api/v2/rents/payment/') &&
      r.request().method() === 'PATCH'
  );
  await page
    .locator('[role=dialog] button')
    .filter({ hasText: /Record|Εκτέλεση/i })
    .first()
    .click();
  const resp = await patchPromise;
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(Number(body.payment), 'server payment = 0 after delete').toBeCloseTo(0, 1);

  await expect(page.locator('[role=dialog][vaul-drawer]')).not.toBeVisible({
    timeout: 10_000
  });
  await expect
    .poll(() => readPaymentCell(tenantRow), { timeout: 15_000 })
    .toBeCloseTo(0, 1);
});
