/**
 * The BROWSER copy of the bill-term rule, against the SAME shared case table the
 * server copy runs (`services/common/src/utils/billterm.cases.json`).
 *
 * The frontend cannot import the server lib — its package index pulls in mongoose —
 * so the rule exists twice. Pinning both to one table is what stops them drifting:
 * change the rule and you must change the table, and then BOTH suites tell you.
 * Same arrangement as `variableExpense`.
 */
import CASES from '../../../../services/common/src/utils/billterm.cases.json';
import { billTermFitsExpense } from '../utils/billTerm';

describe('billTermFitsExpense — browser copy', () => {
  for (const c of CASES) {
    it(c.name, () => {
      // The whole object, not just the boolean: the REASON decides which sentence
      // the landlord reads, and «the expense ended before this month» is different
      // advice from «the expense has no start month».
      expect(billTermFitsExpense(c.expense, c.term)).toEqual(c.expected);
    });
  }

  it('reads a non-empty table (a broken import must not pass vacuously)', () => {
    expect(CASES.length).toBeGreaterThan(10);
  });
});
