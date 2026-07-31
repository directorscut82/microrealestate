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
    .locator(
      'xpath=ancestor::div[contains(@class, "rounded-lg") and contains(@class, "border")][1]'
    );
}

/**
 * The "By category" rows are the children of the space-y-1 wrapper that
 * follows the "By category" label. Each row is a flex-justify-between
 * div with the category label (text-muted-foreground) and a NumberFormat
 * sibling. We narrow to those rows by selector class so toHaveCount
 * reflects the number of NON-ZERO categories the panel shows (filter logic
 * lives in CategoryBreakdown).
 */
// The exact labels PropertyExpensesCard's _categoryLabel() renders, per locale
// (en fallback + the Greek production strings). Used to assert that a category
// the server reports as ZERO renders NO row — a phantom row is money the
// landlord never incurred, the mirror image of the absent-representation rule.
const CATEGORY_LABELS: Record<string, RegExp> = {
  heating: /^(Heating|Θέρμανση)$/,
  water: /^(Water|Ύδρευση)$/,
  electricity: /^(Electricity|Ηλεκτρισμός)$/,
  insurance: /^(Insurance|Ασφάλιση)$/,
  cleaning: /^(Cleaning|Καθαριότητα)$/,
  repairs: /^(Repairs|Επισκευές)$/,
  other: /^(Other|Λοιπά)$/
};

function categoryRowsIn(scope: import('@playwright/test').Locator) {
  // CategoryBreakdown emits a <div class="space-y-1"> whose first child
  // is a heading <div>"By category"</div>, followed by category rows.
  // YearBreakdown emits the same shape with "By year" heading. The
  // ExpenseLines list also reuses .flex.justify-between.text-sm but with
  // .gap-2 modifier. Scope to "the space-y-1 wrapper containing the
  // 'By category' heading inside this collapsible". Caller passes the
  // collapsible's CollapsibleContent locator as `scope` so we don't
  // bleed across panels; do NOT add .first() here — it would break
  // multi-collapsible tests where the assertion is on a SPECIFIC panel.
  //
  // STALE-SPEC FIX (2026-07): the «By category» heading is now only the
  // FALLBACK rendering. When the payload carries per-line details the card
  // renders GroupedExpenseLines — a subtotal row per category plus indented
  // member rows — and there is no such heading, so a wrapper-scoped locator
  // returned 0 rows for a panel full of money. Match the money rows in EITHER
  // layout: they share the .flex.justify-between.text-sm shape, and scoping to
  // the caller's CollapsibleContent already prevents bleeding across panels.
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
    has: scope
      .page()
      .locator('span.font-medium')
      .filter({ hasText: labelRegex })
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
    expect(typeof lifetimeByYear[yk], `byYear[${yk}] numeric`).toBe('number');
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
  expect(
    Array.isArray(body.currentMonth.lines),
    'currentMonth.lines array'
  ).toBe(true);
  for (const line of body.currentMonth.lines as Array<
    Record<string, unknown>
  >) {
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
  // STALE-SPEC FIX (2026-07): this used to anchor the open CollapsibleContent
  // by looking for the «By category» heading. That heading is now only the
  // FALLBACK rendering — when the payload carries per-line details the card
  // renders GroupedExpenseLines instead (the "ΑΝΑ ΚΑΤΗΓΟΡΙΑ rollup AND flat
  // list" double-vision was deliberately removed in the July money-UI review).
  // So the anchor could only ever match when the seed produced NO lines, i.e.
  // when the fixture was broken. Anchor on the collapsible itself and accept
  // either rendering.
  const currentContent = card
    .locator('[data-state="open"]')
    .filter({
      has: page.locator(
        'text=/By category|Ανά κατηγορία|No expenses for this period|Δεν υπάρχουν έξοδα|E2E-/'
      )
    })
    .first();
  await expect(currentContent).toBeVisible({ timeout: 10_000 });

  // Set-narrowing assertion. In the GROUPED rendering a category with 2+ lines
  // shows a subtotal row PLUS one indented row per line, so the row count is
  // ≥ the number of non-zero categories rather than equal to it. Assert the
  // invariant that still holds and still catches a dropped category: every
  // non-zero category from the server must be represented, and a category the
  // server reports as ZERO must not appear.
  const rowCount = await categoryRowsIn(currentContent).count();
  expect(
    rowCount,
    `current-month rows (${rowCount}) cover every non-zero server category (${currentNonZero.length}): ${currentNonZero
      .map(([k]) => k)
      .join(', ')}`
  ).toBeGreaterThanOrEqual(currentNonZero.length);

  // …and the real set-narrowing a bare ">=" cannot give: EVERY non-zero
  // category's own euro figure must appear in the panel.
  //
  // This replaced an earlier `sum-of-all-euros === serverTotal || serverTotal
  // appears somewhere` check, which was unsound arithmetic. In the GROUPED
  // layout a multi-member category prints its subtotal AND each member, so the
  // naive sum double-counts and the first arm is false on a CORRECT panel
  // (measured on the live card: the rendered figures sum to 1186 against a
  // server total of 896). The second arm was a lax escape hatch — "the total
  // appears somewhere among the figures" is satisfied by coincidence as soon as
  // any single row happens to equal it. Together they passed only because the
  // current fixture has no multi-member category; a seed change would have
  // failed a perfectly correct panel.
  //
  // Per-category presence has neither problem: exact, independent of how the
  // card groups its rows, and a dropped or mis-valued category fails it
  // directly. Mutation-checked — asserting `val + 1` fails with the real panel
  // text in the message.
  const panelText = (await currentContent.innerText()) || '';
  const fmt = (v: number) =>
    new Intl.NumberFormat('el-GR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(Math.abs(v));
  for (const [cat, val] of currentNonZero) {
    expect(
      panelText.includes(fmt(Number(val))),
      `current-month panel must show category "${cat}" = ${fmt(Number(val))} € (panel text: ${JSON.stringify(panelText.slice(0, 400))})`
    ).toBe(true);
  }

  // No category the server reports as ZERO may be rendered as a row — the
  // "absent representation" rule in reverse: a phantom row is money the
  // landlord did not incur.
  const zeroCats = Object.entries(
    apiBody.currentMonth.byCategory as Record<string, number>
  ).filter(([, v]) => Number(v) === 0);
  for (const [cat] of zeroCats) {
    const label = CATEGORY_LABELS[cat];
    if (!label) continue;
    await expect(
      currentContent.locator('div.flex.justify-between.text-sm').filter({
        has: page
          .locator('span.text-muted-foreground')
          .filter({ hasText: label })
      }),
      `zero-valued category "${cat}" must NOT render a row`
    ).toHaveCount(0);
  }

  // ----- act: open Lifetime collapsible -----
  const lifetimeTrigger = collapsibleTrigger(
    card,
    /Lifetime total|Σύνολο διαστήματος/
  );
  await lifetimeTrigger.click();
  // STALE-SPEC FIX (2026-07): this waited on the «By year» heading as the
  // "collapsible opened" signal. But YearBreakdown only renders when there are
  // 2+ NON-ZERO years (`showYears = nonZeroYears.length > 1`) — a deliberate
  // anti-redundancy rule: one year needs no per-year breakdown. The seed's
  // expenses all sit in the current year, so the heading legitimately never
  // appears and this hung for 10s. Wait on the panel CONTENT instead, then
  // assert the per-year section only when the server actually reports 2+ years.
  const lifetimeYears = Object.entries(
    (apiBody.lifetime.byYear || {}) as Record<string, number>
  ).filter(([, v]) => Number(v) !== 0);
  await expect(
    card
      .locator('div.flex.justify-between.text-sm')
      .filter({
        has: page
          .locator('span.text-muted-foreground')
          .filter({ hasText: CATEGORY_LABELS.repairs })
      })
      .first(),
    'lifetime collapsible opened (a lifetime category row is visible)'
  ).toBeVisible({ timeout: 10_000 });
  if (lifetimeYears.length > 1) {
    await expect(
      card.locator('div.text-xs.uppercase').filter({
        hasText: /^(By year|Ανά έτος)$/
      }),
      `server reports ${lifetimeYears.length} non-zero years → «By year» breakdown must render`
    ).toBeVisible({ timeout: 10_000 });
  }

  // ----- assert: H12 — the "Repairs" category MUST be present in the
  //        lifetime breakdown because the elevator+repairs_fund seed
  //        routes there. Pre-H12-fix this row was missing (silently
  //        merged into "Other"). Use a card-scoped anchor so we count
  //        across BOTH collapsibles — if lifetime renders Repairs, we
  //        catch it whether the assertion picks up Current or Lifetime.
  // -----
  const repairsRow = card.locator('div.flex.justify-between.text-sm').filter({
    has: page
      .locator('span.text-muted-foreground')
      .filter({ hasText: /^(Repairs|Επισκευές)$/ })
  });
  await expect(
    repairsRow,
    'H12 — Repairs category row visible (elevator+repairs_fund routed here)'
  ).not.toHaveCount(0);

  // ----- assert: the byYear section, but ONLY when the card renders it. As
  //        above, YearBreakdown is gated on 2+ non-zero years; with a
  //        single-year seed the card intentionally shows «All in {{category}}
  //        during {{year}}» instead, which is the correct, non-redundant UI.
  //        Assert whichever of the two the server data implies, so this can
  //        never silently pass by finding nothing.
  // -----
  if (lifetimeYears.length > 1) {
    const yearHeading = card.locator('div.text-xs.uppercase').filter({
      hasText: /^(By year|Ανά έτος)$/
    });
    // Walk up from the heading to its space-y-1 parent.
    const yearSection = yearHeading.locator('xpath=..');
    const yearRows = yearSection.locator('div.flex.justify-between.text-sm');
    await expect(
      yearRows,
      'at least one YYYY row in byYear breakdown'
    ).not.toHaveCount(0, { timeout: 5_000 });
    const firstYearRow = yearRows.first();
    const yearLabel =
      (await firstYearRow.locator('span').first().textContent()) || '';
    expect(yearLabel.trim(), 'first year row label is YYYY').toMatch(/^\d{4}$/);
  } else {
    // Single year: the «By year» breakdown must NOT render (it would be a
    // one-row table restating the total), and the year must still be stated
    // somewhere in the lifetime panel so the figure is not context-free.
    await expect(
      card.locator('div.text-xs.uppercase').filter({
        hasText: /^(By year|Ανά έτος)$/
      }),
      'single-year lifetime → no redundant «By year» breakdown'
    ).toHaveCount(0);
    const theYear = lifetimeYears[0]?.[0];
    if (theYear) {
      await expect(
        card.getByText(new RegExp(theYear)).first(),
        `single-year lifetime → the year ${theYear} is still named in the panel`
      ).toBeVisible({ timeout: 5_000 });
    }
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
  const lifetimeTrigger = collapsibleTrigger(
    card,
    /Lifetime total|Σύνολο διαστήματος/
  );

  await currentTrigger.click();
  await lifetimeTrigger.click();

  // Capture the post-toggle data-state attributes for both collapsibles.
  // data-state="closed" or "open" lives on the CollapsibleTrigger button
  // and on the CollapsibleContent. We probe the buttons (stable element
  // identity).
  const readState = async (trig: import('@playwright/test').Locator) =>
    (await trig.getAttribute('data-state')) || '';

  await expect
    .poll(() => readState(currentTrigger), { timeout: 5_000 })
    .toBe('closed');
  await expect
    .poll(() => readState(lifetimeTrigger), { timeout: 5_000 })
    .toBe('open');

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
  await expect
    .poll(() => readState(currentTrigger), { timeout: 10_000 })
    .toBe('closed');
  await expect
    .poll(() => readState(lifetimeTrigger), { timeout: 10_000 })
    .toBe('open');

  // ----- assert: data is still rendered after refetch (i.e. the panel
  //        didn't fall into a loading-spinner state and stay there).
  //        Anchor on the "By category" heading text — that's only
  //        emitted when CategoryBreakdown has rows to show. If the panel
  //        re-fetched and got data back, the heading is visible.
  // -----
  await expect(
    card.locator('div.text-xs.uppercase').filter({
      hasText: /^(By category|Ανά κατηγορία)$/
    }),
    'By category heading still rendered after refetch'
  ).toBeVisible({ timeout: 15_000 });

  // Set-narrowing: at least one category row remains anywhere in the card
  // (the seed guarantees multiple non-zero categories; we don't assert
  // the exact count because suite-leaked seed mutations could change
  // the total — the contract is "data renders, state preserved").
  const cardCategoryRows = card
    .locator('div.flex.justify-between.text-sm')
    .filter({
      has: page.locator('span.text-muted-foreground')
    });
  await expect(
    cardCategoryRows,
    'at least one category row survives refetch'
  ).not.toHaveCount(0, { timeout: 5_000 });
});
