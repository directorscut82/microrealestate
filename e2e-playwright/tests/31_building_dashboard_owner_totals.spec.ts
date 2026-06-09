/**
 * Spec 31 — BuildingDashboard owner-totals card.
 *
 * Surface: BuildingDashboard renders the "Income vs expenses" annual-projection
 * card on /buildings/[id] (the default Overview tab in
 * webapps/landlord/src/pages/[organization]/buildings/[id].js). The expenses
 * row breaks out four streams; the right-most cell ("Owner expenses") is the
 * subject of this spec.
 *
 * Coverage targets (from the I-cluster owner-expense audit):
 *   - I-4.a: ownerEksoda projection must be
 *       fixedOwnerMonthly * 12 + Σ(currentYear ownerMonthlyExpenses)
 *     where fixedOwnerMonthly is Σ(BuildingExpense.ownerAmount) for expenses
 *     with trackOwnerExpense + isRecurring + window-active for currentTerm.
 *   - H5: ownerMonthlyExpenses entries from prior calendar years MUST be
 *     EXCLUDED from the displayed annual figure. Pre-fix the dashboard
 *     summed every entry across the lifetime of the building, so a building
 *     entering its second year would suddenly inflate "Owner expenses" by
 *     the entirety of last year's ledger — masked the current-year burden.
 *
 * Anti-pattern guarded against: existence-only assertions (`toBeVisible()`)
 * are tautologies here — the row is rendered unconditionally whenever
 * annualEksoda > 0. We assert the displayed VALUE matches a precomputed
 * expected number and that PRIOR-YEAR amounts do NOT contribute. The
 * tooltip and refetch-resilience checks complete the surface.
 *
 * Definition-of-done items addressed:
 *   - Real Playwright browser drive (signin → navigate → assert).
 *   - Set-narrowing/value-delta — exact figure equality within a 1¢
 *     tolerance for locale rounding.
 *   - Tooltip renders on hover.
 *   - Refetch resilience — invalidate the building cache (navigate away and
 *     back) and confirm the value is stable, not a one-shot render artefact.
 *
 * Cleanup discipline: the seeded owner-expense entries (current-year and
 * prior-year) live on the canonical E2E-Building. A later run would still
 * produce a correct headline because saveMonthlyStatement is term-scoped
 * (each term replaces its own slice). To keep the realm tidy across runs
 * we issue a saveMonthlyStatement with `ownerExpenses: []` for both terms
 * in afterAll, restoring the baseline.
 */
import { APIRequestContext, expect, request, test } from '@playwright/test';
import { ensureSeedWithUnit } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

// Marker amounts chosen to be sums that no other E2E seed can produce by
// coincidence — keeps the read-back unambiguous if specs run in the wrong
// order. fixedOwner = 73, currentYearEntry = 137, priorYearEntry = 911.
// Expected ownerEksoda = 73 * 12 + 137 = 1013. The prior-year 911 must NOT
// appear; if it does, displayed = 1013 + 911 = 1924, which the assert
// catches with a clear delta.
const FIXED_OWNER_AMOUNT = 73;
const CURRENT_YEAR_ENTRY_AMOUNT = 137;
const PRIOR_YEAR_ENTRY_AMOUNT = 911;
const EXPECTED_OWNER_EKSODA =
  FIXED_OWNER_AMOUNT * 12 + CURRENT_YEAR_ENTRY_AMOUNT;
const POISONED_OWNER_EKSODA =
  EXPECTED_OWNER_EKSODA + PRIOR_YEAR_ENTRY_AMOUNT;

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error(
      'Missing TEST_EMAIL/TEST_PASSWORD. Expected .secrets/cypress-test-account.'
    );
  }
});

interface SeededState {
  token: string;
  realmId: string;
  realmName: string;
  buildingId: string;
  ownerExpenseId: string;
  currentTerm: number;
  priorYearTerm: number;
}

let seededState: SeededState | null = null;

const yyyymmddhh = (year: number, month: number) =>
  Number(`${year}${String(month).padStart(2, '0')}0100`);

async function authHeaders(token: string, realmId: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    organizationid: realmId
  };
}

/**
 * Build the seed: one fixed owner-tracked recurring expense + two
 * ownerMonthlyExpenses entries (current year + prior year). Idempotent —
 * runs as many times as needed without compounding totals, because:
 *   - the expense is found-or-created by the marker name "E2E-OwnerExp"
 *     and PATCH-updated to enforce the canonical ownerAmount/startTerm;
 *   - saveMonthlyStatement replaces the per-term slice of
 *     ownerMonthlyExpenses wholesale, so re-seeding overwrites instead of
 *     accreting.
 */
async function seedOwnerExpenseFixture(
  api: APIRequestContext
): Promise<SeededState> {
  const seed = await ensureSeedWithUnit(api);
  const headers = await authHeaders(seed.token, seed.realmId);

  // Compute terms relative to NOW. currentTerm = first of THIS month;
  // priorYearTerm = first of THIS month one year ago. We deliberately
  // anchor both to the same calendar month so the dashboard's
  // currentTerm-startOfMonth check is the only thing distinguishing them.
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  const currentTerm = yyyymmddhh(currentYear, currentMonth);
  const priorYearTerm = yyyymmddhh(currentYear - 1, currentMonth);

  // Build's startTerm for the fixed recurring owner expense — anchor far
  // enough in the past that isExpenseActiveForTerm(currentTerm) is true.
  // We pick 1st of January of the prior year — that way the same anchor
  // would also have been active for the prior-year ownerMonthlyExpense
  // entry, ruling out "fixedOwner inactive last year" as a confound.
  const fixedStartTerm = yyyymmddhh(currentYear - 1, 1);

  // Look up an existing E2E-OwnerExp on the building before creating a
  // new one. Without this, repeated runs would push duplicate fixed
  // expenses and the displayed total would be N * 73 * 12.
  const buildingResp = await api.get(
    `${GATEWAY}/api/v2/buildings/${seed.buildingId}`,
    { headers }
  );
  expect(buildingResp.status(), 'fetch building').toBe(200);
  const fullBuilding = (await buildingResp.json()) as {
    expenses?: Array<{
      _id: string;
      name: string;
      ownerAmount?: number;
      trackOwnerExpense?: boolean;
      isRecurring?: boolean;
    }>;
  };
  let ownerExpense = fullBuilding.expenses?.find(
    (e) => e.name === 'E2E-OwnerExp'
  );

  if (!ownerExpense) {
    const created = await api.post(
      `${GATEWAY}/api/v2/buildings/${seed.buildingId}/expenses`,
      {
        headers,
        data: {
          name: 'E2E-OwnerExp',
          type: 'other',
          amount: 0,
          ownerAmount: FIXED_OWNER_AMOUNT,
          trackOwnerExpense: true,
          allocationMethod: 'general_thousandths',
          isRecurring: true,
          startTerm: fixedStartTerm
        }
      }
    );
    expect(
      [200, 201],
      `create owner expense (status=${created.status()}, body=${await created
        .text()
        .catch(() => '')})`
    ).toContain(created.status());
    const updatedBuilding = (await created.json()) as {
      expenses: Array<{ _id: string; name: string }>;
    };
    ownerExpense = updatedBuilding.expenses.find(
      (e) => e.name === 'E2E-OwnerExp'
    );
    if (!ownerExpense) {
      throw new Error('Created E2E-OwnerExp not present in response');
    }
  } else {
    // PATCH to canonicalize. A previous failed run might have left
    // ownerAmount=0 or trackOwnerExpense=false on this expense, which
    // would silently change the displayed total.
    const patched = await api.patch(
      `${GATEWAY}/api/v2/buildings/${seed.buildingId}/expenses/${ownerExpense._id}`,
      {
        headers,
        data: {
          name: 'E2E-OwnerExp',
          type: 'other',
          amount: 0,
          ownerAmount: FIXED_OWNER_AMOUNT,
          trackOwnerExpense: true,
          allocationMethod: 'general_thousandths',
          isRecurring: true,
          startTerm: fixedStartTerm
        }
      }
    );
    if (patched.status() >= 400) {
      throw new Error(
        `failed to PATCH E2E-OwnerExp: HTTP ${patched.status()} ${await patched
          .text()
          .catch(() => '')}`
      );
    }
  }

  // Stamp ownerMonthlyExpenses for both terms via saveMonthlyStatement.
  // The handler replaces all ownerMonthlyExpenses entries for the
  // requested term, so we get exactly one entry per term per call.
  // We send `expenses: []` to avoid touching unit.monthlyCharges (no
  // tenant-side allocation needed for this spec).
  const stampOwnerEntry = async (term: number, amount: number) => {
    const r = await api.post(
      `${GATEWAY}/api/v2/buildings/${seed.buildingId}/monthly-statement`,
      {
        headers,
        data: {
          term: String(term),
          expenses: [],
          ownerExpenses: [
            {
              expenseId: ownerExpense!._id,
              amount,
              description: `E2E-OwnerEntry-${term}`
            }
          ]
        }
      }
    );
    expect(
      [200, 201],
      `monthly-statement term=${term} (status=${r.status()}, body=${await r
        .text()
        .catch(() => '')})`
    ).toContain(r.status());
  };

  await stampOwnerEntry(currentTerm, CURRENT_YEAR_ENTRY_AMOUNT);
  await stampOwnerEntry(priorYearTerm, PRIOR_YEAR_ENTRY_AMOUNT);

  return {
    token: seed.token,
    realmId: seed.realmId,
    realmName: seed.realmName,
    buildingId: seed.buildingId,
    ownerExpenseId: ownerExpense._id,
    currentTerm,
    priorYearTerm
  };
}

test.beforeAll(async () => {
  const api = await request.newContext();
  try {
    seededState = await seedOwnerExpenseFixture(api);
  } finally {
    await api.dispose();
  }
});

test.afterAll(async () => {
  if (!seededState) return;
  const api = await request.newContext();
  try {
    const headers = await authHeaders(seededState.token, seededState.realmId);
    // Empty ownerExpenses arrays clear the per-term slices; do this for
    // both terms we touched. Best-effort — failures here should not mask
    // the test result.
    for (const term of [seededState.currentTerm, seededState.priorYearTerm]) {
      try {
        await api.post(
          `${GATEWAY}/api/v2/buildings/${seededState.buildingId}/monthly-statement`,
          {
            headers,
            data: {
              term: String(term),
              expenses: [],
              ownerExpenses: []
            }
          }
        );
      } catch {
        // swallow — cleanup is non-fatal
      }
    }
  } finally {
    await api.dispose();
  }
});

/**
 * Locale-aware money parser. The realm runs el-GR EUR by default
 * ("1.234,56 €" with U+2212 minus and U+00A0 NBSP separators). Strip
 * everything that is not a digit / comma / period / minus, swap the
 * thousands and decimal separators, and parse. Mirrors spec 06's helper.
 */
function numberFromText(s: string): number {
  const withAsciiMinus = s.replace(/−/g, '-');
  const cleaned = withAsciiMinus.replace(/[^\d.,-]/g, '');
  const normalized = cleaned.replace(/\./g, '').replace(',', '.');
  return Number(normalized);
}

test('owner-expenses headline = fixedOwner*12 + currentYear, prior-year EXCLUDED, tooltip on hover, refetch-stable', async ({
  page
}) => {
  test.setTimeout(120_000);
  if (!seededState) {
    throw new Error('seededState not initialized — beforeAll bailed');
  }
  const { realmName, buildingId } = seededState;

  // ----- arrange: sign in via UI -----
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname)
    .toMatch(/\/(firstaccess|dashboard)/);

  // ----- act: navigate to building Overview -----
  // BuildingDashboard mounts in the default Overview tab; no click needed.
  await page.goto(
    `${encodeURIComponent(realmName)}/buildings/${buildingId}`
  );
  await expect(page.locator('[data-cy=overviewTab]')).toBeVisible({
    timeout: 20_000
  });

  // ----- assert: card visible with the breakdown row -----
  // Find the "Owner expenses" label by its translated text. Default test
  // realm locale is 'el' → "Έξοδα ιδιοκτήτη"; en-fallback is "Owner
  // expenses". Match either so the spec is locale-tolerant.
  const ownerLabel = page
    .locator('span', { hasText: /^(Owner expenses|Έξοδα ιδιοκτήτη)$/ })
    .first();
  await expect(
    ownerLabel,
    'Owner expenses label must be rendered (annualEksoda must be > 0 in the seeded fixture)'
  ).toBeVisible({ timeout: 20_000 });

  // The label sits inside a wrapping <div> that also contains the amount
  // node (NumberFormat <span>). Read the amount by walking up to the
  // wrapper, then taking the trailing numeric text.
  const ownerWrapper = ownerLabel.locator(
    'xpath=ancestor::div[1]'
  );
  // The wrapper renders as: <div><TooltipProvider><Tooltip><TooltipTrigger
  // asChild><span ...>{label}</span></TooltipTrigger>...</Tooltip>
  // </TooltipProvider>:&nbsp;<NumberFormat /></div>
  // → innerText holds "<label>: 1.013,00 €" (or el equivalent).
  const wrapperText = (await ownerWrapper.innerText()).trim();
  const ownerEksodaDisplayed = numberFromText(wrapperText);

  // ----- core assertion: I-4.a + H5 -----
  // displayed must be EXACTLY (fixedOwner*12 + currentYearEntry).
  // Tolerance 1¢ for any locale-rounding quirks; our seed values are
  // integer cents so no rounding is actually expected.
  expect(
    Math.abs(ownerEksodaDisplayed - EXPECTED_OWNER_EKSODA),
    `Owner expenses displayed=${ownerEksodaDisplayed} must equal ` +
      `fixedOwner(${FIXED_OWNER_AMOUNT})*12 + currentYearEntry(${CURRENT_YEAR_ENTRY_AMOUNT}) = ${EXPECTED_OWNER_EKSODA}. ` +
      `If you see ${POISONED_OWNER_EKSODA}, the H5 current-year filter has regressed and ` +
      `prior-year entries (${PRIOR_YEAR_ENTRY_AMOUNT}) are leaking into the headline. ` +
      `If the figure is ${CURRENT_YEAR_ENTRY_AMOUNT}, the I-4.a fixed-owner-monthly *12 projection has regressed. ` +
      `Wrapper text was: ${JSON.stringify(wrapperText)}`
  ).toBeLessThan(1);

  // Defensive negative assertion — display strictly must NOT match the
  // poisoned value. This catches the specific regression where prior-year
  // entries leak in even when the headline still happens to be > 0.
  expect(
    Math.abs(ownerEksodaDisplayed - POISONED_OWNER_EKSODA),
    `Owner expenses must NOT include prior-year ${PRIOR_YEAR_ENTRY_AMOUNT}; ` +
      `displayed=${ownerEksodaDisplayed} matches the prior-year-leak value of ${POISONED_OWNER_EKSODA}.`
  ).toBeGreaterThan(0.5);

  // ----- assert: tooltip renders on hover -----
  // The Owner expenses label is wrapped in a Tooltip with a 200ms delay
  // (see BuildingDashboard.js — `delayDuration={200}`). Hover the dotted-
  // underline label and poll for the tooltip body text. Use the el or en
  // tooltip text (same line of code, two locales).
  await ownerLabel.hover();
  await expect
    .poll(
      async () => {
        const html = await page.content();
        return /Includes fixed owner-only expenses|Περιλαμβάνει σταθερά έξοδα ιδιοκτήτη/i.test(
          html
        );
      },
      {
        timeout: 5_000,
        message:
          'Tooltip body text must appear after hover. The Tooltip wrapper around the ' +
          '"Owner expenses" label is the surface that explains the breakdown to the user.'
      }
    )
    .toBe(true);

  // ----- assert: refetch resilience -----
  // Re-render the dashboard from a fresh fetch and confirm the same
  // figure. Without this, a one-shot render that happens to match could
  // pass while a subsequent invalidation produces the broken value.
  // Move the mouse out of tooltip range first so it doesn't intercept
  // the next interaction.
  await page.mouse.move(0, 0);
  // Navigate elsewhere then back — invalidates the in-memory query
  // result and forces useQuery to refetch.
  await page.goto(`${encodeURIComponent(realmName)}/dashboard`);
  await page.goto(
    `${encodeURIComponent(realmName)}/buildings/${buildingId}`
  );
  await expect(page.locator('[data-cy=overviewTab]')).toBeVisible({
    timeout: 20_000
  });
  const ownerLabelAgain = page
    .locator('span', { hasText: /^(Owner expenses|Έξοδα ιδιοκτήτη)$/ })
    .first();
  await expect(ownerLabelAgain).toBeVisible({ timeout: 20_000 });
  const wrapperText2 = (
    await ownerLabelAgain.locator('xpath=ancestor::div[1]').innerText()
  ).trim();
  const ownerEksodaAfterRefetch = numberFromText(wrapperText2);
  expect(
    Math.abs(ownerEksodaAfterRefetch - EXPECTED_OWNER_EKSODA),
    `After refetch, Owner expenses must still be ${EXPECTED_OWNER_EKSODA} (got ${ownerEksodaAfterRefetch}). ` +
      `If this drifts from the first read, the dashboard's owner-eksoda computation is non-deterministic ` +
      `(e.g. depends on query result-order or moment().now() timing).`
  ).toBeLessThan(1);
});
