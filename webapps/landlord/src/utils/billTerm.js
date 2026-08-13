/**
 * Browser copy of `services/common/src/utils/billterm.ts`.
 *
 * The frontend cannot import the server lib (its package index pulls in mongoose),
 * so the rule exists twice — the same arrangement as `variableExpense.js`. Both are
 * pinned by `services/api/src/__tests__/billTermParity.test.js`, which runs the same
 * case table through each. Change the rule and you must change the table, and then
 * both sides tell you.
 *
 * Terms are numeric YYYYMMDDHH, so this is integer comparison only: no dates, hence
 * no timezone question. Every moment.utc-vs-local bug in this repo came from turning
 * a term into a date when it did not need to be one.
 */

function toTerm(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/** @returns {{fits: true} | {fits: false, reason: string, startTerm?: number, endTerm?: number}} */
export function billTermFitsExpense(expense, billTerm) {
  const term = toTerm(billTerm);
  const start = toTerm(expense?.startTerm);
  const end = toTerm(expense?.endTerm);
  // Unknown bill term: say nothing. A false warning on every bill trains the
  // operator to dismiss the real one.
  if (term === null) return { fits: true };
  if (start === null) return { fits: false, reason: 'no-start' };
  if (term < start) return { fits: false, reason: 'before-start', startTerm: start };
  if (end !== null && term > end) {
    return { fits: false, reason: 'after-end', endTerm: end };
  }
  return { fits: true };
}

/** True when the bill's month is one the expense is NOT charged for. */
export function billTermIsOutsideExpense(expense, billTerm) {
  return !billTermFitsExpense(expense, billTerm).fits;
}
