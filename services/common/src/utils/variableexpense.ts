/**
 * Is this expense κυμαινόμενο (a variable amount that differs every month)?
 *
 * WHY THIS FILE EXISTS. Until 2026-08-12 there was no flag: "variable" was
 * INFERRED as `recurring && monthlyCost === 0`, and that inference was written out
 * by hand in three separate places (buildingprojection twice, ExpenseFormDialog
 * once). Two consequences, both reported by the landlord:
 *
 *   1. «κυμαινόμενο» and «I have not typed the amount yet» were the SAME state.
 *      A half-finished expense was indistinguishable from a deliberate variable
 *      one, on every surface, permanently. The landlord had resorted to writing
 *      «(κυμαινόμενο)» into the expense NAME to tell them apart.
 *   2. A money rule re-derived in three files is one edit away from three
 *      different answers — the same defect shape as the duplicated bill matcher.
 *
 * THE RULE NOW:
 *   · `isVariable === true`  → variable, whatever the amount says.
 *   · `isVariable === false` → NOT variable, even at €0 (an unfinished expense).
 *   · `isVariable` absent    → legacy row: fall back to the old inference so
 *                              existing data keeps behaving exactly as before.
 *
 * The legacy fallback is not optional. Every expense created before this flag
 * existed has `isVariable === undefined`, including the landlord's real
 * «Πετρέλαιο (κυμαινόμενο)» rows, and dropping the fallback would silently
 * reclassify them as fixed-€0 and change what the projections report.
 *
 * The FRONTEND cannot import this module (it pulls in mongoose via the package
 * index, and it is not browser-safe), so `webapps/landlord/src/utils/variableExpense.js`
 * carries the same rule. Both are pinned to ONE shared truth table —
 * `variableexpense.cases.json` in this directory — which both test suites read.
 * Change the rule and you must change the table, and then both suites tell you.
 */

export interface VariableExpenseLike {
  isVariable?: boolean | null;
  isRecurring?: boolean | null;
  /** Legacy spelling still present on older rows. */
  recurring?: boolean | null;
  amount?: number | null;
  /** Landlord-typed statement figure, when the caller has already resolved it. */
  inputAmount?: number | null;
}

/** True when the expense repeats month to month, under either field spelling. */
export function isRecurringExpense(expense: VariableExpenseLike): boolean {
  return !!(expense?.isRecurring ?? expense?.recurring);
}

/**
 * @param expense     the expense row
 * @param monthlyCost its resolved monthly cost. Callers that already compute this
 *                    (buildingprojection has `expenseMonthlyCost`) MUST pass it, so
 *                    the fallback agrees with their own arithmetic instead of
 *                    re-deriving it from `amount` alone.
 */
export function isVariableExpense(
  expense: VariableExpenseLike | null | undefined,
  monthlyCost?: number
): boolean {
  if (!expense) return false;
  // Explicit flag wins in BOTH directions — including `false` at €0, which is how
  // an unfinished expense is finally distinguishable from a variable one.
  if (typeof expense.isVariable === 'boolean') return expense.isVariable;
  // Legacy row: the pre-flag inference, unchanged.
  const cost =
    typeof monthlyCost === 'number'
      ? monthlyCost
      : Number(expense.amount ?? 0) || 0;
  return isRecurringExpense(expense) && cost === 0;
}
