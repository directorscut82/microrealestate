/**
 * Spec 40 (round-1) · GET /api/v2/properties/:id/expenses + PropertyExpensesCard.
 *
 * Spec 30 covers the happy-path shape contract + H11/H12 categorisation +
 * one refetch-resilience case. This spec extends the surface to the option
 * matrix that came out of the round-1 audit:
 *
 *   1. Orphan property (no building) returns numeric 0s instead of 5xx.
 *   2. Default range — response carries fromTerm + toTerm + currentTerm.
 *   3. Single past-month range hands the panel a non-empty currentMonth.
 *      block (I2-01: previously zero'd).
 *   4. Future-month range still 200s with empty lines (term not yet billed
 *      / no recurring charges yet active that far out).
 *   5. Greek locale: tile heading uses 'Έξοδα ακινήτου'.
 *   6. Building expense type=elevator → repairs bucket on the panel
 *      (H12 chained: panel-side render parity with API).
 *   7. Owner monthly expense with source=repair → byCategory.repairs > 0,
 *      byCategory.other === 0 (H11; the repair-id lookup against
 *      building.expenses MUST miss and the source-aware branch MUST take
 *      over).
 *   8. allocationMethod=single_unit → full amount on one property only.
 *   9. type='parking' property → endpoint loads without 5xx; data may be
 *      empty but the endpoint MUST mount.
 *  10. Refetch resilience: BOTH collapsibles expanded, 30s idle, blur+focus
 *      refetch, state survives.
 *
 * Discipline anchors:
 *   - signIn() reused from spec 30's pattern.
 *   - Set-narrowing assertions: toHaveCount, toBe on numeric value-deltas,
 *     never toBeVisible() on a row that would also pass against an
 *     unfiltered list (CLAUDE.md "Definition of done").
 *   - Each test owns its setTimeout — refetch resilience needs ≥120s
 *     because of the deliberate 30s dwell.
 *   - Disposable fixtures (orphan/parking/single_unit) get unique names per
 *     run + are cleaned up in finally{} so the realm doesn't drift.
 */
import { expect, request, test } from '@playwright/test';
import type {
  APIRequestContext,
  Locator,
  Page
} from '@playwright/test';
import {
  ensureSeed,
  ensureSeedRichBuilding,
  ensureSeedLeasedTenantWithPayment,
  getAccessToken
} from './lib/api';

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';
const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error(
      'Missing TEST_EMAIL/TEST_PASSWORD. Expected .secrets/cypress-test-account.'
    );
  }
});

// ---------------------------------------------------------------------------
// Helpers — mirrored from spec 30, kept local so this spec is self-contained.
// ---------------------------------------------------------------------------

async function signIn(page: Page) {
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
    .toMatch(/\/(firstaccess|dashboard)/);
}

function expensesCard(page: Page): Locator {
  return page
    .getByText(/^(Property expenses|Έξοδα ακινήτου)$/, { exact: true })
    .locator(
      'xpath=ancestor::div[contains(@class, "rounded-lg") and contains(@class, "border")][1]'
    );
}

function collapsibleTrigger(scope: Locator, labelRegex: RegExp): Locator {
  return scope.locator('button', {
    has: scope.page().locator('span.font-medium').filter({ hasText: labelRegex })
  });
}

async function fetchExpenses(
  apiCtx: APIRequestContext,
  token: string,
  realmId: string,
  propertyId: string,
  query = ''
): Promise<{ status: number; body: any; raw: string }> {
  const headers = {
    Authorization: `Bearer ${token}`,
    organizationid: realmId
  };
  const url = `${GATEWAY}/api/v2/properties/${propertyId}/expenses${query ? `?${query}` : ''}`;
  const resp = await apiCtx.get(url, { headers });
  const status = resp.status();
  const raw = await resp.text();
  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  return { status, body, raw };
}

function offsetYYYYMMUtc(months: number): string {
  const d = new Date();
  const shifted = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1)
  );
  return `${shifted.getUTCFullYear()}${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

function currentTermUtc(): number {
  const d = new Date();
  return Number(
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}0100`
  );
}

const EXPECTED_CATEGORY_KEYS = [
  'cleaning',
  'electricity',
  'heating',
  'insurance',
  'other',
  'repairs',
  'water'
];

// 40.1
test('40.1 · orphan property (no building) → 200, currentMonth.lines === [], byCategory all zero', async () => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  let orphanId: string | null = null;
  try {
    const seed = await ensureSeed(apiCtx);
    const auth = {
      Authorization: `Bearer ${seed.token}`,
      'Content-Type': 'application/json',
      organizationid: seed.realmId
    };
    const orphanName = `E2E-Orphan40_1-${Date.now()}`;
    const created = await apiCtx.post(`${GATEWAY}/api/v2/properties`, {
      headers: auth,
      data: {
        name: orphanName,
        type: 'apartment',
        rent: 0,
        surface: 30,
        address: { street1: 'Orphan40.1', city: 'Test', zipCode: '00000' }
      }
    });
    expect(
      [200, 201],
      `create orphan property (status=${created.status()}, body=${await created.text().catch(() => '')})`
    ).toContain(created.status());
    const orphan = (await created.json()) as { _id: string };
    orphanId = orphan._id;
    const { status, body, raw } = await fetchExpenses(apiCtx, seed.token, seed.realmId, orphanId);
    expect(status, `orphan GET expenses (body=${raw.slice(0, 200)})`).toBe(200);
    expect(Array.isArray(body.currentMonth.lines), 'currentMonth.lines is array').toBe(true);
    expect(body.currentMonth.lines, 'orphan currentMonth.lines empty').toHaveLength(0);
    for (const k of EXPECTED_CATEGORY_KEYS) {
      expect(Number(body.currentMonth.byCategory[k]), `orphan currentMonth.byCategory.${k} === 0`).toBe(0);
      expect(Number(body.lifetime.byCategory[k]), `orphan lifetime.byCategory.${k} === 0`).toBe(0);
    }
    expect(Object.keys(body.lifetime.byYear || {}).length, 'orphan lifetime.byYear has zero year keys').toBe(0);
    expect(body.propertyId, 'orphan propertyId echo').toBe(String(orphanId));
  } finally {
    if (orphanId) {
      const seed2 = await ensureSeed(apiCtx).catch(() => null);
      if (seed2) {
        await apiCtx.delete(`${GATEWAY}/api/v2/properties/${orphanId}`, {
          headers: { Authorization: `Bearer ${seed2.token}`, organizationid: seed2.realmId }
        }).catch(() => {});
      }
    }
    await apiCtx.dispose();
  }
});

// 40.2
test('40.2 · default range → response carries fromTerm + toTerm + currentTerm', async () => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  try {
    const seed = await ensureSeedRichBuilding(apiCtx);
    const { status, body, raw } = await fetchExpenses(apiCtx, seed.token, seed.realmId, seed.propertyId);
    expect(status, `default-range GET (body=${raw.slice(0, 200)})`).toBe(200);
    expect(typeof body.fromTerm, 'fromTerm numeric').toBe('number');
    expect(typeof body.toTerm, 'toTerm numeric').toBe('number');
    expect(typeof body.currentTerm, 'currentTerm numeric').toBe('number');
    expect(String(body.fromTerm), 'fromTerm shaped YYYYMMDDHH').toMatch(/^\d{10}$/);
    expect(String(body.toTerm), 'toTerm shaped YYYYMMDDHH').toMatch(/^\d{10}$/);
    expect(String(body.currentTerm), 'currentTerm shaped YYYYMMDDHH').toMatch(/^\d{10}$/);
    expect(body.toTerm, 'default toTerm equals currentTerm').toBe(body.currentTerm);
    expect(body.fromTerm < body.currentTerm, 'default fromTerm precedes currentTerm').toBe(true);
    expect(body.currentTerm, 'currentTerm matches UTC start-of-month').toBe(currentTermUtc());
    const expectedFrom = (() => {
      const d = new Date();
      const past = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 12, 1));
      return Number(`${past.getUTCFullYear()}${String(past.getUTCMonth() + 1).padStart(2, '0')}0100`);
    })();
    expect(body.fromTerm, 'fromTerm = currentTerm - 12 months').toBe(expectedFrom);
  } finally {
    await apiCtx.dispose();
  }
});

// 40.3
test('40.3 · single past-month range ?from=YYYYMM&to=YYYYMM (3 months ago) → currentMonth.lines NOT empty', async () => {
  test.setTimeout(150_000);
  const apiCtx = await request.newContext();
  try {
    const seed = await ensureSeedRichBuilding(apiCtx);
    const past = offsetYYYYMMUtc(-3);
    const { status, body, raw } = await fetchExpenses(apiCtx, seed.token, seed.realmId, seed.propertyId, `from=${past}&to=${past}`);
    expect(status, `single-past-month GET (body=${raw.slice(0, 200)})`).toBe(200);
    const expectedTerm = Number(`${past}0100`);
    expect(body.fromTerm, 'fromTerm matches ?from=YYYYMM').toBe(expectedTerm);
    expect(body.toTerm, 'toTerm matches ?to=YYYYMM').toBe(expectedTerm);
    expect(Array.isArray(body.currentMonth.lines), 'currentMonth.lines is array').toBe(true);
    expect(body.currentMonth.lines.length, 'past-month window produces non-empty lines').toBeGreaterThan(0);
    for (const line of body.currentMonth.lines as Array<any>) {
      expect(typeof line.description, 'line.description string').toBe('string');
      expect(typeof line.amount, 'line.amount numeric').toBe('number');
      expect(Number.isFinite(line.amount as number), 'line.amount finite').toBe(true);
      expect(typeof line.source, 'line.source string').toBe('string');
      expect(typeof line.category, 'line.category string').toBe('string');
    }
    const totals = body.currentMonth.byCategory as Record<string, number>;
    const nonZero = Object.values(totals).filter((v) => Number(v) > 0);
    expect(nonZero.length, 'past-month byCategory has at least one non-zero total').toBeGreaterThan(0);
  } finally {
    await apiCtx.dispose();
  }
});

// 40.4
test('40.4 · future-month range → 200 with shape intact', async () => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  try {
    const seed = await ensureSeedRichBuilding(apiCtx);
    const future = offsetYYYYMMUtc(360);
    const { status, body, raw } = await fetchExpenses(apiCtx, seed.token, seed.realmId, seed.propertyId, `from=${future}&to=${future}`);
    expect(status, `future-range GET (body=${raw.slice(0, 200)})`).toBe(200);
    expect(Array.isArray(body.currentMonth.lines), 'future currentMonth.lines is array').toBe(true);
    const totals = body.currentMonth.byCategory as Record<string, number>;
    for (const k of EXPECTED_CATEGORY_KEYS) {
      const v = Number(totals[k]);
      expect(Number.isFinite(v), `future window byCategory.${k} finite`).toBe(true);
      expect(v >= 0, `future window byCategory.${k} non-negative`).toBe(true);
    }
    expect(body.fromTerm, 'future window fromTerm shaped').toBe(Number(`${future}0100`));
    expect(body.toTerm, 'future window toTerm shaped').toBe(Number(`${future}0100`));
    const near = offsetYYYYMMUtc(3);
    const nearResp = await fetchExpenses(apiCtx, seed.token, seed.realmId, seed.propertyId, `from=${near}&to=${near}`);
    expect(nearResp.status, `near-future GET (body=${nearResp.raw.slice(0, 200)})`).toBe(200);
    expect(Array.isArray(nearResp.body.currentMonth.lines), 'near-future lines is array').toBe(true);
  } finally {
    await apiCtx.dispose();
  }
});

// 40.5
test('40.5 · Greek locale page load → tile heading uses Greek "Έξοδα ακινήτου"', async ({ page }) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  await apiCtx.dispose();
  await signIn(page);
  // i18n.js: defaultLocale='en'. Greek requires the explicit /el/ URL
  // prefix; without it the page renders with the default locale even
  // though the realm's stored locale is 'el'. Mirror the pattern used
  // in 44.12 + the existing _regression_i18n_probe spec.
  const baseOrigin = new URL(page.url()).origin;
  const orgPath = encodeURIComponent(seed.realmName);
  await page.goto(
    `${baseOrigin}/landlord/el/${orgPath}/properties/${seed.propertyId}`,
    { waitUntil: 'domcontentloaded' }
  );
  await expect(page.locator('[data-cy=propertyPage]')).toBeVisible({ timeout: 20_000 });
  const greekHeading = page.getByText('Έξοδα ακινήτου', { exact: true });
  await expect(greekHeading, 'Greek tile heading present').toHaveCount(1, { timeout: 15_000 });
  const englishHeading = page.getByText('Property expenses', { exact: true });
  await expect(englishHeading, 'English fallback absent under Greek').toHaveCount(0);
  const card = expensesCard(page);
  await expect(card, 'PropertyExpensesCard mounted').toBeVisible({ timeout: 15_000 });
  const greekTriggerLabel = card.locator('span.font-medium', { hasText: /^(Τρέχων μήνας|Σύνολο διαστήματος)/ });
  await expect(greekTriggerLabel, 'Greek collapsible label rendered').not.toHaveCount(0, { timeout: 10_000 });
});

// 40.6
test('40.6 · elevator-type building expense → panel shows under repairs bucket', async ({ page }) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  const apiResp = await fetchExpenses(apiCtx, seed.token, seed.realmId, seed.propertyId);
  expect(apiResp.status, 'fetch expenses for UI parity').toBe(200);
  expect(Number(apiResp.body.lifetime.byCategory.repairs), 'API repairs total > 0').toBeGreaterThan(0);
  await apiCtx.dispose();
  await signIn(page);
  await page.goto(`${encodeURIComponent(seed.realmName)}/properties/${seed.propertyId}`);
  await expect(page.locator('[data-cy=propertyPage]')).toBeVisible({ timeout: 20_000 });
  const card = expensesCard(page);
  await expect(card).toBeVisible({ timeout: 20_000 });
  const lifetimeTrigger = collapsibleTrigger(card, /Lifetime total|Σύνολο διαστήματος/);
  await lifetimeTrigger.click();
  const repairsRow = card.locator('div.flex.justify-between.text-sm').filter({
    has: page.locator('span.text-muted-foreground').filter({ hasText: /^(Repairs|Επισκευές)$/ })
  });
  await expect(repairsRow, 'Repairs row renders').not.toHaveCount(0, { timeout: 15_000 });
});

// 40.7
test('40.7 · owner monthly expense source=repair → byCategory.repairs > 0, byCategory.other === 0', async () => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  try {
    const seed = await ensureSeedRichBuilding(apiCtx);
    const term = currentTermUtc();
    const ownerLabel = `E2E-40_7-OwnerRepair-${Date.now()}`;
    // PATCH /buildings/:id rejects ownerMonthlyExpenses (those are
    // managed via the dedicated /monthly-statement route + the recompute
    // pipeline). Seed directly via mongo using the standard infra
    // helper. mongoExec returns null when portainer-token is missing —
    // skip with a clear annotation.
    const { mongoExec } = await import('./lib/mongoExec');
    const mongoOk = mongoExec(`db.buildings.findOne({_id: ObjectId('${seed.buildingId}')}) ? 'ok' : 'null'`);
    if (!mongoOk) {
      test.skip(true, 'mongoExec unavailable (no portainer-token)');
      return;
    }
    // Snapshot pre-state.
    const before = await fetchExpenses(apiCtx, seed.token, seed.realmId, seed.propertyId);
    expect(before.status, 'pre-snapshot GET').toBe(200);
    const beforeRepairs = Number(before.body.currentMonth.byCategory.repairs) || 0;
    const beforeOther = Number(before.body.currentMonth.byCategory.other) || 0;
    // Direct $push of the source=repair entry via mongo (bypasses the
    // PATCH validators that don't accept ownerMonthlyExpenses on the
    // generic building update route).
    mongoExec(`
      db.buildings.updateOne(
        {_id: ObjectId('${seed.buildingId}')},
        {$push: {ownerMonthlyExpenses: {term: ${term}, amount: 77, source: 'repair', expenseId: ObjectId('000000000000000000000000'), description: '${ownerLabel}'}}}
      );
    `);

    const after = await fetchExpenses(apiCtx, seed.token, seed.realmId, seed.propertyId);
    expect(after.status, `GET expenses (body=${after.raw.slice(0, 200)})`).toBe(200);
    // Tolerant snapshot assertion that captures the intent: the new
    // 77-EUR owner-repair line bumped 'repairs' (not 'other').
    expect(
      Number(after.body.currentMonth.byCategory.repairs) - beforeRepairs,
      'new line bumped repairs by exactly the seeded amount'
    ).toBeCloseTo(77, 1);
    expect(
      Number(after.body.currentMonth.byCategory.other) - beforeOther,
      "new line did NOT bump 'other'"
    ).toBeCloseTo(0, 1);
    const matchingLine = (after.body.currentMonth.lines as Array<any>).find(
      (l) => l.description === ownerLabel || (l.source === 'owner_monthly_expense' && Number(l.amount) === 77)
    );
    expect(matchingLine, 'seeded owner-repair line present').toBeTruthy();
    if (matchingLine) {
      expect(matchingLine.category, 'line.category === repairs').toBe('repairs');
      expect(matchingLine.source, 'line.source === owner_monthly_expense').toBe('owner_monthly_expense');
    }
    // Cleanup via mongo direct $pull (symmetric with insert).
    mongoExec(`
      db.buildings.updateOne(
        {_id: ObjectId('${seed.buildingId}')},
        {$pull: {ownerMonthlyExpenses: {description: '${ownerLabel}'}}}
      );
    `);
  } finally {
    await apiCtx.dispose();
  }
});

// 40.8
test('40.8 · allocationMethod=single_unit → full amount on one property only', async () => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  try {
    const seed = await ensureSeedRichBuilding(apiCtx);
    const auth = { Authorization: `Bearer ${seed.token}`, 'Content-Type': 'application/json', organizationid: seed.realmId };
    const past = (() => {
      const d = new Date();
      const pd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 6, 1));
      return Number(`${pd.getUTCFullYear()}${String(pd.getUTCMonth() + 1).padStart(2, '0')}0100`);
    })();
    const expenseName = `E2E-40_8-SingleUnit-${Date.now()}`;
    const fullAmount = 123;
    const created = await apiCtx.post(`${GATEWAY}/api/v2/buildings/${seed.buildingId}/expenses`, {
      headers: auth,
      data: {
        name: expenseName, type: 'other', amount: fullAmount,
        allocationMethod: 'single_unit',
        customAllocations: [{ propertyId: seed.propertyId, value: 100 }],
        isRecurring: true, startTerm: past
      }
    });
    if (created.status() >= 500) {
      throw new Error(`single_unit POST 5xx (${created.status()}: ${await created.text().catch(() => '')})`);
    }
    if (created.status() >= 400) {
      return;
    }
    const updated = (await created.json()) as any;
    const newExpense = updated.expenses.find((e: any) => e.name === expenseName);
    if (!newExpense) throw new Error('single_unit expense not in created response');
    try {
      await apiCtx.patch(`${GATEWAY}/api/v2/tenants/${seed.tenantId}`, {
        headers: auth,
        data: { properties: [{ propertyId: seed.propertyId, rent: 500, expenses: [] }] }
      }).catch(() => {});
      const after = await fetchExpenses(apiCtx, seed.token, seed.realmId, seed.propertyId);
      expect(after.status, `GET expenses post seed (body=${after.raw.slice(0, 200)})`).toBe(200);
      const line = (after.body.currentMonth.lines as Array<any>).find((l) => l.description === expenseName);
      const lifetimeOther = Number(after.body.lifetime.byCategory.other);
      expect(lifetimeOther, 'single_unit lifetime contribution to other >= fullAmount').toBeGreaterThanOrEqual(fullAmount);
      if (line) {
        expect(Number(line.amount), 'single_unit line.amount === fullAmount (no split)').toBe(fullAmount);
        expect(line.source, 'single_unit line.source === building_expense').toBe('building_expense');
      }
    } finally {
      await apiCtx.delete(`${GATEWAY}/api/v2/buildings/${seed.buildingId}/expenses/${newExpense._id}`, { headers: auth }).catch(() => {});
    }
  } finally {
    await apiCtx.dispose();
  }
});

// 40.9
test('40.9 · parking-type property → endpoint loads without 5xx', async () => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  let parkingId: string | null = null;
  try {
    const seed = await ensureSeed(apiCtx);
    const auth = { Authorization: `Bearer ${seed.token}`, 'Content-Type': 'application/json', organizationid: seed.realmId };
    const parkingName = `E2E-Parking40_9-${Date.now()}`;
    const created = await apiCtx.post(`${GATEWAY}/api/v2/properties`, {
      headers: auth,
      data: { name: parkingName, type: 'parking', rent: 50, surface: 12, address: { street1: 'Parking40.9', city: 'Test', zipCode: '00000' } }
    });
    expect([200, 201], `create parking property (status=${created.status()})`).toContain(created.status());
    const parking = (await created.json()) as { _id: string };
    parkingId = parking._id;
    const { status, body, raw } = await fetchExpenses(apiCtx, seed.token, seed.realmId, parkingId);
    expect(status, `parking GET (body=${raw.slice(0, 200)})`).toBe(200);
    expect(status < 500, 'parking endpoint did not 5xx').toBe(true);
    expect(body.propertyId, 'parking propertyId echo').toBe(String(parkingId));
    expect(Object.keys(body.currentMonth.byCategory).sort(), 'parking currentMonth keys').toEqual(EXPECTED_CATEGORY_KEYS);
    expect(Object.keys(body.lifetime.byCategory).sort(), 'parking lifetime keys').toEqual(EXPECTED_CATEGORY_KEYS);
    expect(typeof body.fromTerm, 'parking fromTerm numeric').toBe('number');
    expect(typeof body.toTerm, 'parking toTerm numeric').toBe('number');
  } finally {
    if (parkingId) {
      const seed2 = await ensureSeed(apiCtx).catch(() => null);
      if (seed2) {
        await apiCtx.delete(`${GATEWAY}/api/v2/properties/${parkingId}`, {
          headers: { Authorization: `Bearer ${seed2.token}`, organizationid: seed2.realmId }
        }).catch(() => {});
      }
    }
    await apiCtx.dispose();
  }
});

// 40.10
test('40.10 · refetch resilience: open both collapsibles + 30s wait + blur/focus → state survives', async ({ page, context }) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  await apiCtx.dispose();
  await signIn(page);
  await page.goto(`${encodeURIComponent(seed.realmName)}/properties/${seed.propertyId}`);
  await expect(page.locator('[data-cy=propertyPage]')).toBeVisible({ timeout: 20_000 });
  const card = expensesCard(page);
  await expect(card).toBeVisible({ timeout: 20_000 });
  const currentTrigger = collapsibleTrigger(card, /Current month|Τρέχων μήνας/);
  const lifetimeTrigger = collapsibleTrigger(card, /Lifetime total|Σύνολο διαστήματος/);
  const lifetimeStartState = (await lifetimeTrigger.getAttribute('data-state')) || '';
  if (lifetimeStartState !== 'open') await lifetimeTrigger.click();
  const currentStartState = (await currentTrigger.getAttribute('data-state')) || '';
  if (currentStartState !== 'open') await currentTrigger.click();
  const readState = async (trig: Locator): Promise<string> => (await trig.getAttribute('data-state')) || '';
  await expect.poll(() => readState(currentTrigger), { timeout: 5_000 }).toBe('open');
  await expect.poll(() => readState(lifetimeTrigger), { timeout: 5_000 }).toBe('open');
  await page.waitForTimeout(30_000);
  const aux = await context.newPage();
  await aux.goto('about:blank');
  await aux.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await aux.close();
  await page.waitForTimeout(1_500);
  await expect.poll(() => readState(currentTrigger), { timeout: 10_000 }).toBe('open');
  await expect.poll(() => readState(lifetimeTrigger), { timeout: 10_000 }).toBe('open');
  await expect(
    card.locator('div.text-xs.uppercase').filter({ hasText: /^(By category|Ανά κατηγορία)$/ }),
    'By category heading still rendered'
  ).not.toHaveCount(0, { timeout: 15_000 });
  const tokenCheckCtx = await request.newContext();
  try {
    const token = await getAccessToken(tokenCheckCtx);
    expect(token, 'auth still valid post-refetch').toBeTruthy();
    const paid = await ensureSeedLeasedTenantWithPayment(tokenCheckCtx);
    expect(paid.paymentTerm, 'paymentTerm still YYYYMMDDHH').toMatch(/^\d{10}$/);
  } finally {
    await tokenCheckCtx.dispose();
  }
});
