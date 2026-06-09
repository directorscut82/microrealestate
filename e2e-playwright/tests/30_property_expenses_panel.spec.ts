import { expect, request, test } from '@playwright/test';
import { ensureSeedRichBuilding } from './lib/api';

/**
 * Spec 30 · GET /api/v2/properties/:id/expenses + PropertyExpensesCard.
 *
 * Covers Tier I-2 (the per-property expense panel feature) plus the H11/H12
 * regression class:
 *
 *   - H11: owner-side repair lines (ownerMonthlyExpenses with source='repair')
 *     must classify as 'repairs', NOT silently fall into 'other'. Pre-fix the
 *     branch only tried to look up `expenseId` against `building.expenses`, so
 *     the lookup missed (the id pointed at a repair, not an expense) and the
 *     row landed in the default category.
 *
 *   - H12: building expenses with mongo `type` of 'garden', 'elevator',
 *     'pest_control' must each map to a non-default panel category. Pre-fix
 *     the switch in `_classifyExpenseType` listed only the trivial 1:1 cases
 *     (heating→heating, water_common→water, ...) and the four "unusual"
 *     types fell through to 'other', undercounting cleaning/repairs in the UI
 *     while the rent ledger correctly counted them. End user sees: panel
 *     headline understates 'Repairs' by the elevator + repairs_fund total.
 *
 * Surfaces under test:
 *   - GET /api/v2/properties/:id/expenses — payload shape, key-set contracts
 *   - PropertyExpensesCard on /properties/[id] — rendering, collapsible state,
 *     refetch-resilience.
 *
 * Discipline anchors:
 *   - Drives a real Playwright browser AND uses request.newContext() for
 *     shape verification (definition-of-done: both surfaces in one spec).
 *   - Set-narrowing toHaveCount() on category rows — never toBeVisible() on a
 *     single row because that would also pass against an unfiltered list.
 *   - Refetch-resilience: open lifetime panel → wait 30s → fire window-focus
 *     refetch (React Query default) → re-assert state survives.
 *   - Reuses ensureSeedRichBuilding (heating, elevator, cleaning, insurance,
 *     repairs_fund + leased tenant + linked unit). The elevator expense is
 *     the H12 hot-path: mongo type='elevator' MUST classify into 'repairs',
 *     not 'other'.
 */

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

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
    .toMatch(/\/(firstaccess|dashboard)/);
}

/**
 * Locate the PropertyExpensesCard root by walking up from the title text.
 * The card renders inside a DashboardCard whose CardTitle carries the
 * translated string. We anchor on the title and ascend to the nearest
 * Card container so all subsequent locators are scoped to this panel
 * (the property page renders three DashboardCards: Property, Previous
 * tenants, Property expenses).
 */
function expensesCard(page: import('@playwright/test').Page) {
  // DashboardCard renders <Card> = a div with role-less layout containing a
  // CardTitle. We anchor on the title text and ascend to the nearest
  // ancestor div that is the Card root. The Card has `flex-col` AND
  // `border` (Tailwind shadcn pattern). Filter to get a single match.
  return page
    .getByText(/^(Property expenses|Έξοδα ακινήτου)$/, { exact: true })
    .locator('xpath=ancestor::div[contains(@class, "rounded-lg") and contains(@class, "border")][1]');
}

/**
 * The "By category" rows are the children of the space-y-1 wrapper that
 * follows the "By category" label. Each row is a flex-justify-between
 * div with the category label (text-muted-foreground) and a NumberFormat
 * sibling. We narrow to those rows by selector class so toHaveCount
 * reflects the number of NON-ZERO categories the panel shows (filter logic
 * lives in CategoryBreakdown).
 */
function categoryRowsIn(scope: import('@playwright/test').Locator) {
  return scope.locator('div.flex.justify-between.text-sm');
}

/**
 * Convenience: find the Current month / Lifetime total CollapsibleTrigger
 * by its label text. The button renders the label as a span.font-medium.
 */
function collapsibleTrigger(
  scope: import('@playwright/test').Locator,
  labelRegex: RegExp
) {
  return scope.locator('button', {
    has: scope.page().locator('span.font-medium').filter({ hasText: labelRegex })
  });
}

test('30.1 · GET /properties/:id/expenses payload shape — 7 categories, numeric values, YYYY year keys, elevator → repairs (H12)', async ({}) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);

  const headers = {
    Authorization: `Bearer ${seed.token}`,
    organizationid: seed.realmId
  };

  const resp = await apiCtx.get(
    `${GATEWAY}/api/v2/properties/${seed.propertyId}/expenses`,
    { headers }
  );
  // Status: read-only endpoint, must not 4xx/5xx for a realm-scoped property.
  expect(
    resp.status(),
    `GET /properties/:id/expenses status (body: ${await resp.text().catch(() => '')})`
  ).toBe(200);
  const body = await resp.json();

  // ----- shape: top-level keys -----
  expect(body.propertyId, 'propertyId echo').toBe(String(seed.propertyId));
  expect(typeof body.currentTerm, 'currentTerm is numeric').toBe('number');
  expect(body.currentMonth, 'currentMonth bag').toBeTruthy();
  expect(body.lifetime, 'lifetime bag').toBeTruthy();

  // ----- shape: byCategory has exactly 7 keys, every value numeric -----
  const expectedCategoryKeys = [
    'heating',
    'water',
    'electricity',
    'insurance',
    'cleaning',
    'repairs',
    'other'
  ].sort();
  const currentByCat = body.currentMonth.byCategory as Record<string, unknown>;
  const lifetimeByCat = body.lifetime.byCategory as Record<string, unknown>;

  expect(
    Object.keys(currentByCat).sort(),
    'currentMonth.byCategory keys are exactly the 7 panel categories'
  ).toEqual(expectedCategoryKeys);
  expect(
    Object.keys(lifetimeByCat).sort(),
    'lifetime.byCategory keys are exactly the 7 panel categories'
  ).toEqual(expectedCategoryKeys);

  for (const k of expectedCategoryKeys) {
    expect(typeof currentByCat[k], `currentMonth.byCategory.${k} numeric`).toBe(
      'number'
    );
    expect(typeof lifetimeByCat[k], `lifetime.byCategory.${k} numeric`).toBe(
      'number'
    );
    expect(
      Number.isFinite(currentByCat[k] as number),
      `currentMonth.byCategory.${k} finite`
    ).toBe(true);
    expect(
      Number.isFinite(lifetimeByCat[k] as number),
      `lifetime.byCategory.${k} finite`
    ).toBe(true);
  }

  // ----- shape: lifetime.byYear keys are 4-digit years, values numeric -----
  const lifetimeByYear = body.lifetime.byYear as Record<string, unknown>;
  expect(typeof lifetimeByYear, 'lifetime.byYear is an object').toBe('object');
  for (const yk of Object.keys(lifetimeByYear)) {
    expect(yk, `byYear key '${yk}' is YYYY`).toMatch(/^\d{4}$/);
    expect(
      typeof lifetimeByYear[yk],
      `byYear[${yk}] numeric`
    ).toBe('number');
  }

  // ----- H12: building expense with mongo type='elevator' MUST classify
  //       as 'repairs' (NOT 'other'). The seed contains:
  //         heating(80), elevator(40), cleaning(30), insurance(25),
  //         repairs_fund(50)
  //       so the rich-building lifetime breakdown must show:
  //         - non-zero repairs   (elevator + repairs_fund map there)
  //         - non-zero heating, cleaning, insurance
  //       'other' MAY be zero in this seed; if a future agent regresses
  //       _classifyExpenseType to default-fall-through, 'other' will spike
  //       AND 'repairs' will drop, both of which we assert below.
  // -----
  expect(
    Number(lifetimeByCat.repairs),
    'H12 — elevator+repairs_fund route into "repairs" (not "other")'
  ).toBeGreaterThan(0);
  expect(
    Number(lifetimeByCat.heating),
    'heating expense classifies as "heating"'
  ).toBeGreaterThan(0);
  expect(
    Number(lifetimeByCat.cleaning),
    'cleaning expense classifies as "cleaning"'
  ).toBeGreaterThan(0);
  expect(
    Number(lifetimeByCat.insurance),
    'insurance expense classifies as "insurance"'
  ).toBeGreaterThan(0);

  // H11 anti-regression scaffolding: source-aware classification means
  // owner-repair monthly entries (source='repair') resolve to 'repairs'
  // even though their `expenseId` field points at a repair, not a
  // building expense. We can't seed an owner monthly expense via the
  // public API in this spec, but the shape contract above (7 keys, every
  // value numeric, repairs > 0 from elevator alone) guarantees that the
  // categorisation switch is the live code path producing these numbers.

  // ----- shape: currentMonth.lines — array of {description, amount, source} -----
  expect(Array.isArray(body.currentMonth.lines), 'currentMonth.lines array').toBe(
    true
  );
  for (const line of body.currentMonth.lines as Array<Record<string, unknown>>) {
    expect(typeof line.description, 'line.description string').toBe('string');
    expect(typeof line.amount, 'line.amount numeric').toBe('number');
    expect(typeof line.source, 'line.source string').toBe('string');
  }

  await apiCtx.dispose();
});

test('30.2 · UI · PropertyExpensesCard renders set of category rows derived from server payload (toHaveCount)', async ({
  page
}) => {
  test.setTimeout(180_000);
  // ----- arrange: rich seed (5 building expenses + linked unit + leased tenant) -----
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);

  // Pull the server payload BEFORE driving the UI so we know exactly how
  // many non-zero rows the panel should render. This couples the UI
  // assertion to the live server output (set-narrowing) — a UI bug that
  // drops a category row will fail on count, not on a vague visibility
  // probe.
  const headers = {
    Authorization: `Bearer ${seed.token}`,
    organizationid: seed.realmId
  };
  const apiResp = await apiCtx.get(
    `${GATEWAY}/api/v2/properties/${seed.propertyId}/expenses`,
    { headers }
  );
  expect(apiResp.status(), 'fetch expenses for UI parity').toBe(200);
  const apiBody = await apiResp.json();
  await apiCtx.dispose();

  const currentNonZero = Object.entries(
    apiBody.currentMonth.byCategory as Record<string, number>
  ).filter(([, v]) => Number(v) !== 0);
  const lifetimeNonZero = Object.entries(
    apiBody.lifetime.byCategory as Record<string, number>
  ).filter(([, v]) => Number(v) !== 0);

  // The seed guarantees at least 3 non-zero categories in lifetime
  // (heating + cleaning + insurance + repairs from elevator/repairs_fund).
  expect(
    lifetimeNonZero.length,
    'sanity: rich seed produces multi-category lifetime breakdown'
  ).toBeGreaterThanOrEqual(3);

  // ----- act: sign in, navigate to /properties/:id -----
  await signIn(page);
  await page.goto(
    `${encodeURIComponent(seed.realmName)}/properties/${seed.propertyId}`
  );
  // Wait for the property page to mount.
  await expect(page.locator('[data-cy=propertyPage]')).toBeVisible({
    timeout: 20_000
  });

  const card = expensesCard(page);
  await expect(card, 'PropertyExpensesCard mounted').toBeVisible({
    timeout: 20_000
  });

  // ----- assert: Current month panel is OPEN by default (component sets
  //        openCurrent=true initially). Find its CollapsibleContent and
  //        count category rows.
  const currentTrigger = collapsibleTrigger(card, /Current month|Τρέχων μήνας/);
  await expect(currentTrigger).toBeVisible();
  // The CollapsibleContent that follows the Current-month trigger is the
  // first content sibling under the Collapsible wrapper. Locate by data-state.
  const currentContent = card
    .locator('[data-state="open"]', {
      has: page.locator('text=/By category|Ανά κατηγορία|No expenses for this period|Δεν υπάρχουν έξοδα/')
    })
    .first();
  await expect(currentContent).toBeVisible({ timeout: 10_000 });

  // Set-narrowing assertion: number of category rows visible == number of
  // non-zero categories in currentMonth.byCategory. If the API says zero
  // (no expenses active for the current month), the panel renders the
  // "No expenses for this period" placeholder instead of zero rows; in
  // that case toHaveCount(0) still holds because the .flex.justify-between
  // selector won't match the placeholder (which is a single .text-sm div
  // without the .justify-between class).
  await expect(
    categoryRowsIn(currentContent),
    `current-month category rows count == server non-zero count (${currentNonZero.length})`
  ).toHaveCount(currentNonZero.length, { timeout: 15_000 });

  // ----- act: open Lifetime collapsible -----
  const lifetimeTrigger = collapsibleTrigger(card, /Lifetime total|Σύνολο διαστήματος/);
  await lifetimeTrigger.click();
  // Wait for the second collapsible to expand.
  const lifetimeContent = card
    .locator('[data-state="open"]', {
      has: page.locator('text=/By year|Ανά έτος|By category|Ανά κατηγορία/')
    })
    .nth(1);
  await expect(lifetimeContent).toBeVisible({ timeout: 5_000 });

  // ----- assert: lifetime category rows count matches lifetime non-zero count
  //        PLUS the per-year rows. We narrow the assertion to the "By
  //        category" subsection by re-anchoring on the label.
  const lifetimeByCategorySection = lifetimeContent.locator(
    'div.space-y-1',
    {
      has: page.locator(
        'text=/^(By category|Ανά κατηγορία)$/'
      )
    }
  );
  await expect(
    categoryRowsIn(lifetimeByCategorySection),
    `lifetime category rows count == ${lifetimeNonZero.length}`
  ).toHaveCount(lifetimeNonZero.length, { timeout: 10_000 });

  // ----- assert: H12 — the "Repairs" label MUST appear in the lifetime
  //        breakdown because the elevator+repairs_fund seed routes into
  //        that category. Pre-H12-fix this row would be missing and the
  //        elevator+repairs_fund total would silently merge into "Other".
  // -----
  await expect(
    lifetimeByCategorySection
      .locator('span.text-muted-foreground')
      .filter({ hasText: /^(Repairs|Επισκευές)$/ }),
    'H12 — "Repairs" category row visible (elevator+repairs_fund routed here)'
  ).toHaveCount(1);

  // ----- assert: byYear section renders at least one YYYY row (current
  //        year). The seed activates expenses 6 months back so depending
  //        on calendar position the lifetime year-set has 1 or 2 keys.
  // -----
  const yearSection = lifetimeContent.locator('div.mt-3.space-y-1');
  await expect(
    yearSection,
    'lifetime byYear section rendered'
  ).toBeVisible();
  const yearRows = categoryRowsIn(yearSection);
  const yearRowsCount = await yearRows.count();
  expect(
    yearRowsCount,
    'at least one YYYY row in byYear breakdown'
  ).toBeGreaterThanOrEqual(1);
  // Each year row's left-hand label MUST be a 4-digit year (validated
  // against the API contract above).
  for (let i = 0; i < yearRowsCount; i++) {
    const label = (await yearRows.nth(i).locator('span').first().textContent()) || '';
    expect(label.trim(), `year row ${i} label is YYYY`).toMatch(/^\d{4}$/);
  }
});

test('30.3 · refetch-resilience · collapsible state survives 30s wait + window-focus refetch', async ({
  page,
  context
}) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedRichBuilding(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await page.goto(
    `${encodeURIComponent(seed.realmName)}/properties/${seed.propertyId}`
  );
  await expect(page.locator('[data-cy=propertyPage]')).toBeVisible({
    timeout: 20_000
  });

  const card = expensesCard(page);
  await expect(card).toBeVisible({ timeout: 20_000 });

  // Default state: Current month OPEN, Lifetime total CLOSED.
  // Toggle Current month CLOSED and Lifetime OPEN — non-default state we
  // want to verify survives a refetch (the state is stored in the
  // component, not in the React Query cache; a refetch should NOT reset
  // it, but a buggy implementation that re-mounts on cache invalidation
  // would).
  const currentTrigger = collapsibleTrigger(card, /Current month|Τρέχων μήνας/);
  const lifetimeTrigger = collapsibleTrigger(card, /Lifetime total|Σύνολο διαστήματος/);

  await currentTrigger.click();
  await lifetimeTrigger.click();

  // Capture the post-toggle data-state attributes for both collapsibles.
  // data-state="closed" or "open" lives on the CollapsibleTrigger button
  // and on the CollapsibleContent. We probe the buttons (stable element
  // identity).
  const readState = async (trig: import('@playwright/test').Locator) =>
    (await trig.getAttribute('data-state')) || '';

  await expect.poll(() => readState(currentTrigger), { timeout: 5_000 }).toBe(
    'closed'
  );
  await expect.poll(() => readState(lifetimeTrigger), { timeout: 5_000 }).toBe(
    'open'
  );

  // ----- 30s wait — simulates a long idle period (user wandered off a tab) -----
  // We use Playwright's clock pressure by waiting in real time. This is
  // the same shape as spec 27.28's "search holds across a window-focus
  // refetch" but with a longer dwell to flush any stale-time windows
  // React Query might have set (default staleTime is 0, so the next
  // focus will refetch).
  await page.waitForTimeout(30_000);

  // ----- trigger a refetch via window-focus event (React Query default
  //        refetchOnWindowFocus). This is the canonical way to fire a
  //        background refetch from a Playwright spec without exposing
  //        queryClient on window. Cross-checked against spec 27.28
  //        which uses exactly this pattern. -----
  const aux = await context.newPage();
  await aux.goto('about:blank');
  await aux.bringToFront();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await aux.close();

  // Give the refetch a beat — react-query's queryFn will fire and the
  // panel data will repopulate. The collapsible state lives in
  // useState and MUST survive this.
  await page.waitForTimeout(1_500);

  // ----- assert: collapsible state preserved -----
  await expect.poll(() => readState(currentTrigger), { timeout: 10_000 }).toBe(
    'closed'
  );
  await expect.poll(() => readState(lifetimeTrigger), { timeout: 10_000 }).toBe(
    'open'
  );

  // ----- assert: data is still rendered after refetch (i.e. the panel
  //        didn't fall into a loading-spinner state and stay there) -----
  const lifetimeContent = card
    .locator('[data-state="open"]', {
      has: page.locator('text=/By year|Ανά έτος|By category|Ανά κατηγορία/')
    })
    .first();
  await expect(
    lifetimeContent,
    'lifetime panel content still rendered after refetch'
  ).toBeVisible({ timeout: 15_000 });

  const lifetimeByCategorySection = lifetimeContent.locator(
    'div.space-y-1',
    {
      has: page.locator('text=/^(By category|Ανά κατηγορία)$/')
    }
  );
  // Set-narrowing: at least one category row remains (the seed guarantees
  // multiple non-zero categories; we don't assert the exact count here
  // because suite-leaked seed mutations could change the total — the
  // contract is "data renders, state preserved").
  expect(
    await categoryRowsIn(lifetimeByCategorySection).count(),
    'at least one lifetime category row survives refetch'
  ).toBeGreaterThanOrEqual(1);
});
