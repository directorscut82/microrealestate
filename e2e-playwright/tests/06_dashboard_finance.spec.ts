import { test, expect, request } from '@playwright/test';
import { ensureSeedLeasedTenant, ensureSeedWithUnit } from './lib/api';

/**
 * Wave-24 bug 10: building dashboard renders an "Income vs expenses" card
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
  const card = page.locator('div', { hasText: 'Income vs expenses' }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });

  // Read the three figures by their stable label text. NumberFormat outputs
  // locale-aware money — for el-GR EUR realm it's like "6.000,00 €". We
  // extract digits to compare numerically rather than textually.
  const numberFromText = (s: string) => {
    // Normalise both ASCII '-' and Unicode '−' (U+2212) before stripping.
    // Strip everything but digits, dots, commas, minus.
    const withAsciiMinus = s.replace(/−/g, '-');
    const cleaned = withAsciiMinus.replace(/[^\d.,-]/g, '');
    // Greek/EU format: thousand=., decimal=, → drop dots, swap comma to dot.
    const normalized = cleaned.replace(/\./g, '').replace(',', '.');
    return Number(normalized);
  };

  // The card renders three labelled rows (Income / Expenses / Net) as
  // sibling divs with label + amount. The whole card's innerText
  // contains them in order separated by newlines/whitespace. Walk the
  // text and pull the amount that immediately follows each label.
  // Permissive regex: any whitespace between label and the EUR amount,
  // accept both ASCII '-' and Unicode '−' (U+2212) for negatives.
  const cardText = await card.innerText();
  const matchAfter = (label: string): string => {
    const re = new RegExp(
      label + '[^0-9\\-−]*([\\-−]?[\\d.,\\u00a0\\s]+\\s*€)',
      'u'
    );
    const m = cardText.match(re);
    return m ? m[1].trim() : '';
  };
  const incomeText = matchAfter('Income');
  const expensesText = matchAfter('Expenses');
  const netText = matchAfter('Net');

  const income = numberFromText(incomeText.replace(/^Income/i, ''));
  const expenses = numberFromText(expensesText.replace(/^Expenses/i, ''));
  const net = numberFromText(netText.replace(/^Net/i, ''));

  expect(income, `annual income must be > 0 (got "${incomeText}")`).toBeGreaterThan(0);
  expect(expenses, `annual expenses must be > 0 (got "${expensesText}")`).toBeGreaterThan(0);
  // Net should equal income - expenses within a 0.5 tolerance for any
  // rounding the locale formatter applies.
  expect(
    Math.abs(net - (income - expenses)),
    `net=${net} must equal income(${income}) - expenses(${expenses})`
  ).toBeLessThan(1);
});
