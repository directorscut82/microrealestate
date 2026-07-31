import { test, expect, request } from '@playwright/test';
import { ensureSeedLeasedTenant, ensureSeedWithUnit } from './lib/api';

/**
 * Wave-24 bug 10: building dashboard renders an annual-projection card
 * («ΕΤΗΣΙΑ ΠΡΟΒΟΛΗ» / «Annual projection <year>»; the original
 * "Income vs expenses" title no longer exists anywhere in the app)
 * showing annualEsoda (rent × 12), annualEksoda (recurring × 12 + one-time
 * + repairs + owner expenses), and net. Pre-fix the dashboard had no such
 * card; the landlord could not see the financial picture for a building.
 *
 * To make the card show meaningful numbers we need:
 *   - a leased tenant paying rent on a property (already seeded by
 *     ensureSeedLeasedTenant)
 *   - that property linked to a unit on the seed building (we link here)
 *   - a recurring expense on the seed building (already seeded by ensureSeed)
 *
 * After all three are in place the card must show:
 *   - Income > 0 (12 × monthly rent across rented units)
 *   - Expenses > 0 (12 × monthly recurring expense)
 *   - Net = Income - Expenses
 */

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD.');
  }
});

test('building dashboard finance card shows income, expenses, and net', async ({ page }) => {
  // ----- arrange: leased tenant + building with unit linked to the property -----
  const apiCtx = await request.newContext();
  const leased = await ensureSeedLeasedTenant(apiCtx);
  const unitSeed = await ensureSeedWithUnit(apiCtx);

  // Link the unit to the property so dashboard finance lookup matches the
  // tenant's property to a building unit. PATCH /buildings/:id/units/:unitId.
  const auth = {
    Authorization: `Bearer ${leased.token}`,
    'Content-Type': 'application/json',
    organizationid: leased.realmId
  };
  const linkResp = await apiCtx.patch(
    `${GATEWAY}/api/v2/buildings/${unitSeed.buildingId}/units/${unitSeed.unitId}`,
    {
      headers: auth,
      data: {
        propertyId: leased.propertyId,
        occupancyType: 'rented'
      }
    }
  );
  expect(linkResp.status(), 'link unit to property').toBe(200);

  await apiCtx.dispose();

  // ----- act: sign in, navigate to building dashboard -----
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/(firstaccess|dashboard)/);

  await page.goto(`${encodeURIComponent(leased.realmName)}/buildings/${leased.buildingId}`);

  // The Building page has tabs; the Overview/Dashboard tab is the default
  // landing tab and renders the finance card. We don't need to click a tab.
  // ----- assert: card is visible with non-zero income, non-zero expenses,
  //               and net = income - expenses ----------------------------
  // STALE-SPEC FIX (2026-07): this anchored on an "Income vs expenses" card
  // title. That string has ZERO renderers anywhere in the app — the card was
  // rebuilt as the «ΕΤΗΣΙΑ ΠΡΟΒΟΛΗ / Annual projection <year>» table
  // (BuildingProjectionTable) with Income / Owner expenses / Net rows and
  // up-to-month / projected / total columns. The spec had been failing ever
  // since, and the orphaned locale key is removed in this commit.
  const card = page
    .locator('div')
    .filter({ hasText: /Annual projection|ΕΤΗΣΙΑ ΠΡΟΒΟΛΗ/ })
    .first();
  await expect(card).toBeVisible({ timeout: 20_000 });

  // The projection table itself: the one whose header row carries the
  // «Total» / «Σύνολο» column. Anchoring reads to THIS table keeps them off the
  // other Overview tiles (Rent collected, Uncollected expenses, Repairs).
  const projectionTable = page
    .locator('table')
    .filter({ has: page.locator('th').filter({ hasText: /^(Total|Σύνολο)$/ }) })
    .first();
  await expect(projectionTable, 'projection table present').toBeVisible({
    timeout: 20_000
  });

  // Read the three figures by their stable label text. NumberFormat outputs
  // locale-aware money — for el-GR EUR realm it's like "6.000,00 €".
  const numberFromText = (s: string) => {
    const withAsciiMinus = s.replace(/−/g, '-');
    const cleaned = withAsciiMinus.replace(/[^\d.,-]/g, '');
    const normalized = cleaned.replace(/\./g, '').replace(',', '.');
    return Number(normalized);
  };

  // The projection is a <table>: each row is
  //   <tr><td>Label</td><td>up-to-month</td><td>projected</td><td>total</td></tr>
  // so the figure to compare is the LAST cell (Total), not a sibling <div>.
  // Accept the Greek labels too — the realm's locale is el, and reviewing this
  // in English is how the rename went unnoticed.
  const readAmountFor = async (labels: RegExp): Promise<number> => {
    // Scope to the projection table. A page-wide `tr` search also matched rows
    // in the tiles further down the Overview (Rent collected / Uncollected
    // expenses / Repairs), so the first match was not always the projection row
    // and the figure read 0 while the card plainly showed 6.000,00 €.
    const row = projectionTable
      .locator('tr')
      .filter({ has: page.locator('td').filter({ hasText: labels }) })
      .first();
    await expect(row, `row matching ${labels} must exist`).toBeVisible({
      timeout: 10_000
    });
    const cells = row.locator('td');
    const n = await cells.count();
    const text = (await cells.nth(n - 1).innerText()).trim();
    return numberFromText(text);
  };

  // React Query hydrates the projection AFTER first paint, so the table renders
  // once with zeros and then fills in. Reading immediately raced that and got
  // 0 for a card that visibly showed 6.000,00 € in the failure snapshot. Poll
  // until the Income row is populated before reading any figure.
  await expect
    .poll(() => readAmountFor(/^(Income|Έσοδα)$/), { timeout: 30_000 })
    .toBeGreaterThan(0);

  const income = await readAmountFor(/^(Income|Έσοδα)$/);
  // Renamed from a bare "Expenses": the row is the OWNER-borne total
  // («Έξοδα ιδιοκτήτη»), which is what Net subtracts.
  const expenses = await readAmountFor(/^(Owner expenses|Έξοδα ιδιοκτήτη)$/);
  const net = await readAmountFor(/^(Net|Καθαρό)$/);

  expect(income, `annual income must be > 0 (got ${income})`).toBeGreaterThan(0);
  // The Owner-expenses row renders with a leading «−» because it IS a deduction
  // (HeadRow's `neg` prop, added so a cost reads as one). The spec predated
  // that and demanded a positive figure. Assert the magnitude, and assert the
  // sign explicitly so a regression to an unsigned cost still fails.
  expect(
    expenses,
    `annual owner expenses render as a NEGATIVE deduction (got ${expenses})`
  ).toBeLessThan(0);
  const expensesMagnitude = Math.abs(expenses);
  expect(
    expensesMagnitude,
    `annual owner expenses must be non-zero (got ${expenses})`
  ).toBeGreaterThan(0);
  // Net = income − expenses. Since `expenses` is already signed negative here,
  // that is income + expenses. 1-cent tolerance for locale rounding.
  expect(
    Math.abs(net - (income + expenses)),
    `net=${net} must equal income(${income}) − owner expenses(${expensesMagnitude})`
  ).toBeLessThan(1);
});
