/**
 * Wave-25: Per-category breakdown of what a tenant owes for a given rent.
 * Used by the PaymentTabs allocation UI to:
 *   - render the "owed before / owed after" preview
 *   - feed the default values when the user switches to Custom split
 *   - guide auto-spread allocation order (oldest categories first)
 *
 * The category set is fixed and matches the server-side PAYMENT_CATEGORIES
 * enum in services/api/src/managers/rentmanager.ts. Keep them in sync.
 *
 * Mapping from rent-pipeline fields to UI categories:
 *   rent              -> sum(rent.preTaxAmounts)
 *   expenses          -> sum(rent.charges) + sum(rent.buildingCharges where type !== 'repair')
 *   repairs           -> sum(rent.buildingCharges where type === 'repair')
 *   vat               -> rent.total.vat (or sum(rent.vats))
 *   previousBalance   -> Math.max(0, rent.balance)   // carry-in from prior term, debit only
 *   extracharge       -> sum(rent.debts)             // settlement-only debts; legacy debts treated same
 *
 * Note: the rent object the dialog sees is the frontdata-shaped rent
 * (services/api/src/managers/frontdata.ts). It exposes `balance`,
 * `totalAmount`, `discount`, `extracharge`, plus the raw arrays
 * `preTaxAmounts`, `charges`, `buildingCharges`, `debts`.
 */

export const PAYMENT_CATEGORIES = [
  'rent',
  'expenses',
  'repairs',
  'vat',
  'previousBalance',
  'extracharge'
];

/**
 * The order in which Auto-spread fills owed categories. Oldest debt classes
 * first so a partial payment closes the most-overdue obligations first.
 */
export const AUTO_SPREAD_ORDER = [
  'previousBalance',
  'rent',
  'expenses',
  'repairs',
  'vat',
  'extracharge'
];

const _round = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Compute owed amounts per category for a single rent.
 *
 * Returns an object keyed by category, plus a `total` field that should
 * equal rent.totalAmount within rounding tolerance.
 */
export function computeCategoryOwed(rent) {
  if (!rent) {
    return PAYMENT_CATEGORIES.reduce(
      (acc, k) => ({ ...acc, [k]: 0 }),
      { total: 0 }
    );
  }

  const sumAmounts = (arr) =>
    Array.isArray(arr)
      ? arr.reduce((s, x) => s + (Number(x?.amount) || 0), 0)
      : 0;

  const preTaxRent = sumAmounts(rent.preTaxAmounts);
  const propertyCharges = sumAmounts(rent.charges);
  const buildingChargesAll = Array.isArray(rent.buildingCharges)
    ? rent.buildingCharges
    : [];
  const repairCharges = buildingChargesAll
    .filter((c) => c?.type === 'repair')
    .reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const expenseBuildingCharges = buildingChargesAll
    .filter((c) => c?.type !== 'repair')
    .reduce((s, c) => s + (Number(c.amount) || 0), 0);

  const owed = {
    rent: _round(preTaxRent),
    expenses: _round(propertyCharges + expenseBuildingCharges),
    repairs: _round(repairCharges),
    vat: _round(Number(rent?.vat) || sumAmounts(rent?.vats)),
    previousBalance: _round(Math.max(0, Number(rent?.balance) || 0)),
    extracharge: _round(Number(rent?.extracharge) || sumAmounts(rent?.debts))
  };

  return {
    ...owed,
    total: _round(
      owed.rent +
        owed.expenses +
        owed.repairs +
        owed.vat +
        owed.previousBalance +
        owed.extracharge
    )
  };
}

/**
 * Auto-spread a payment amount across owed categories oldest-first.
 * Returns an allocation array suitable for Custom-split mode, useful as
 * the seed when the user switches modes.
 */
export function autoSpreadAllocation(amount, owed) {
  let remaining = _round(amount);
  const out = [];
  for (const cat of AUTO_SPREAD_ORDER) {
    if (remaining <= 0) break;
    const due = Number(owed?.[cat]) || 0;
    if (due <= 0) continue;
    const apply = _round(Math.min(remaining, due));
    if (apply > 0) {
      out.push({ category: cat, amount: apply });
      remaining = _round(remaining - apply);
    }
  }
  return out;
}

/**
 * Apply an allocation array to an owed map. Returns the per-category owed
 * AFTER applying the allocation (clamped at 0; surplus per-category is
 * silently ignored — the dialog's preview should call this with a
 * validated allocation that doesn't over-pay any single category).
 *
 * Also returns:
 *   - `creditToNextMonth`: the surplus when the payment exceeds total owed.
 *     (sum of (allocation amount - owed) clamped at 0; OR
 *      sum(allocation) - sum(owed) clamped at 0, whichever applies).
 */
export function applyAllocation(owed, allocation) {
  const remaining = { ...owed };
  delete remaining.total;
  let allocSum = 0;
  for (const entry of allocation || []) {
    if (!entry || !PAYMENT_CATEGORIES.includes(entry.category)) continue;
    const amt = Number(entry.amount) || 0;
    allocSum += amt;
    const cur = Number(remaining[entry.category]) || 0;
    remaining[entry.category] = _round(Math.max(0, cur - amt));
  }
  const owedTotal = PAYMENT_CATEGORIES.reduce(
    (s, k) => s + (Number(owed?.[k]) || 0),
    0
  );
  const creditToNextMonth = _round(Math.max(0, allocSum - owedTotal));
  const remainingTotal = _round(
    PAYMENT_CATEGORIES.reduce(
      (s, k) => s + (Number(remaining[k]) || 0),
      0
    )
  );
  return { remaining, creditToNextMonth, remainingTotal };
}
