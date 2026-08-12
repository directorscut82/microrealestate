/**
 * The κυμαινόμενο predicate — SERVER side, driven by the shared truth table.
 *
 * The rule has two implementations, because the browser cannot import this
 * package (it reaches mongoose through the index and is not browser-safe):
 *   · server  — services/common/src/utils/variableexpense.ts   (this suite)
 *   · browser — webapps/landlord/src/utils/variableExpense.js  (its own suite)
 *
 * Both read the SAME table — services/common/src/utils/variableexpense.cases.json
 * — so the rule cannot be changed on one side only. That is the mitigation for a
 * duplication the module boundary forces on us; the alternative was a third
 * hand-written inference, and three copies of one money rule is exactly what this
 * flag was introduced to remove.
 *
 * Imports the built dist directly, the pattern pagination.test.js already uses.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  isRecurringExpense,
  isVariableExpense
} from '@microrealestate/common/dist/utils/variableexpense.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLE = JSON.parse(
  fs.readFileSync(
    path.resolve(
      HERE,
      '../../../common/src/utils/variableexpense.cases.json'
    ),
    'utf8'
  )
);

describe('isVariableExpense — the shared truth table', () => {
  it('the table itself is non-trivial (guards against an emptied fixture)', () => {
    // A test driven by a fixture passes vacuously if the fixture is empty.
    expect(Array.isArray(TABLE.cases)).toBe(true);
    expect(TABLE.cases.length).toBeGreaterThanOrEqual(15);
    // It must contain BOTH outcomes, or the loop below proves nothing.
    expect(TABLE.cases.some((c) => c.expected === true)).toBe(true);
    expect(TABLE.cases.some((c) => c.expected === false)).toBe(true);
  });

  for (const c of TABLE.cases) {
    it(`${c.name}`, () => {
      const actual = isVariableExpense(c.expense, c.monthlyCost);
      expect({ case: c.name, variable: actual }).toEqual({
        case: c.name,
        variable: c.expected
      });
    });
  }
});

describe('isVariableExpense — the distinction the flag exists for', () => {
  it('separates «κυμαινόμενο» from «amount not typed yet» at €0', () => {
    // THE reported problem: before the flag these were the same state, so a
    // half-finished expense and a deliberate variable one were indistinguishable
    // on every surface. The landlord had resorted to «(κυμαινόμενο)» in the NAME.
    const variable = { isVariable: true, isRecurring: true, amount: 0 };
    const unfinished = { isVariable: false, isRecurring: true, amount: 0 };
    expect(isVariableExpense(variable)).toBe(true);
    expect(isVariableExpense(unfinished)).toBe(false);
  });

  it('LEGACY rows keep their old meaning — no silent reclassification', () => {
    // Every expense created before the flag has isVariable undefined, including
    // real «Πετρέλαιο (κυμαινόμενο)» rows. Dropping the fallback would flip them
    // to fixed-€0 and change what the projections report.
    expect(isVariableExpense({ isRecurring: true, amount: 0 })).toBe(true);
    expect(isVariableExpense({ recurring: true, amount: 0 })).toBe(true);
    expect(isVariableExpense({ isRecurring: true, amount: 100 })).toBe(false);
  });

  it('is safe on junk input', () => {
    for (const junk of [null, undefined, {}, { amount: 'abc' }]) {
      expect(typeof isVariableExpense(junk)).toBe('boolean');
    }
  });
});

describe('isRecurringExpense', () => {
  it('accepts either field spelling, isRecurring winning', () => {
    expect(isRecurringExpense({ isRecurring: true })).toBe(true);
    expect(isRecurringExpense({ recurring: true })).toBe(true);
    expect(isRecurringExpense({ isRecurring: false, recurring: true })).toBe(
      false
    );
    expect(isRecurringExpense({})).toBe(false);
    expect(isRecurringExpense(null)).toBe(false);
  });
});
