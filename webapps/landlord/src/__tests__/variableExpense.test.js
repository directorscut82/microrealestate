/**
 * The κυμαινόμενο predicate — BROWSER side, driven by the SAME shared table the
 * server suite reads (services/common/src/utils/variableexpense.cases.json).
 *
 * Why two implementations exist at all: the landlord app cannot import
 * `@microrealestate/common` (it reaches mongoose through the package index and is
 * not browser-safe). So the rule is written twice and pinned once — change it here
 * without changing the table and this suite fails; change the table without
 * changing the server and THAT suite fails.
 */
import fs from 'fs';
import path from 'path';
import {
  isRecurringExpense,
  isVariableExpense
} from '../utils/variableExpense';

const TABLE = JSON.parse(
  fs.readFileSync(
    path.resolve(
      __dirname,
      '../../../../services/common/src/utils/variableexpense.cases.json'
    ),
    'utf8'
  )
);

describe('isVariableExpense (browser) — the shared truth table', () => {
  it('reads the SAME table the server suite reads, and it is non-trivial', () => {
    expect(Array.isArray(TABLE.cases)).toBe(true);
    expect(TABLE.cases.length).toBeGreaterThanOrEqual(15);
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

describe('isVariableExpense (browser) — the distinction the flag exists for', () => {
  it('separates «κυμαινόμενο» from «amount not typed yet» at €0', () => {
    expect(
      isVariableExpense({ isVariable: true, isRecurring: true, amount: 0 })
    ).toBe(true);
    expect(
      isVariableExpense({ isVariable: false, isRecurring: true, amount: 0 })
    ).toBe(false);
  });

  it('keeps legacy rows behaving as before', () => {
    expect(isVariableExpense({ isRecurring: true, amount: 0 })).toBe(true);
    expect(isVariableExpense({ isRecurring: true, amount: 100 })).toBe(false);
  });

  it('is safe on junk input', () => {
    for (const junk of [null, undefined, {}, { amount: 'abc' }]) {
      expect(typeof isVariableExpense(junk)).toBe('boolean');
    }
  });
});

describe('isRecurringExpense (browser)', () => {
  it('accepts either spelling, isRecurring winning', () => {
    expect(isRecurringExpense({ isRecurring: true })).toBe(true);
    expect(isRecurringExpense({ recurring: true })).toBe(true);
    expect(isRecurringExpense({ isRecurring: false, recurring: true })).toBe(
      false
    );
    expect(isRecurringExpense(null)).toBe(false);
  });
});
