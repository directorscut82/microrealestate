/**
 * Is this expense κυμαινόμενο (variable amount)? — the BROWSER copy of the rule.
 *
 * The canonical implementation is `services/common/src/utils/variableexpense.ts`.
 * This file exists only because the landlord app cannot import that package: it
 * reaches mongoose through the package index and is not browser-safe. It is a
 * deliberate second implementation of ONE rule, so it is pinned to the same
 * shared truth table — `services/common/src/utils/variableexpense.cases.json` —
 * which both jest suites read. If you change the rule here and not there, the
 * other suite fails.
 *
 * WHAT THIS REPLACES: `const isVariable = isRecurring && (Number(amount)||0) === 0`
 * inlined in ExpenseFormDialog, one of three independent copies of that inference.
 * Because "variable" was inferred from a €0 amount, a κυμαινόμενο expense and an
 * expense whose amount had not been typed yet were the same state everywhere.
 */

/** True when the expense repeats month to month, under either field spelling. */
export function isRecurringExpense(expense) {
  return !!(expense?.isRecurring ?? expense?.recurring);
}

/**
 * @param {object} expense       the expense row (or form values)
 * @param {number=} monthlyCost  its resolved monthly cost, when the caller has one
 */
export function isVariableExpense(expense, monthlyCost) {
  if (!expense) return false;
  // The explicit flag wins in BOTH directions — including `false` at €0, which is
  // what finally distinguishes "unfinished" from "variable".
  if (typeof expense.isVariable === 'boolean') return expense.isVariable;
  // Legacy row (flag absent): the pre-flag inference, unchanged, so existing data
  // keeps behaving exactly as it did.
  const cost =
    typeof monthlyCost === 'number'
      ? monthlyCost
      : Number(expense.amount ?? 0) || 0;
  return isRecurringExpense(expense) && cost === 0;
}
