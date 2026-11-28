/* eslint-env node, jest */
/**
 * Which stored unit charge belongs to which expense — ONE rule, two implementations
 * (services/common `utils/expenserows.ts` and the landlord app's `utils/expenseRows.js`),
 * held to one case table, plus what the rule is for on the server: an expense's yearly
 * figure takes in its own months only.
 *
 * Found by review on 24/11/2026 with one «ΔΕΗ» per apartment — two expenses of one name,
 * which is what the bill import creates. The readers said
 * `expenseId === id || description === name`: the text matched a row that carried the
 * OTHER expense's id. On the building page that pre-filled the second «ΔΕΗ» with the
 * first's figure, and the next save billed it (webapps/landlord expenseRows.test.js).
 * Here it made each expense's months count for both.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isRowOfExpense } from '@microrealestate/common/dist/utils/expenserows.js';
import { computeBuildingProjection } from '@microrealestate/common/dist/utils/buildingprojection.js';

// The table both suites read (the landlord app's is expenseRows.test.js), from the
// sources: nothing has to be copied into a build folder for this file to run.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(
  fs.readFileSync(
    path.resolve(HERE, '../../../common/src/utils/expenserows.cases.json'),
    'utf8'
  )
);

describe('isRowOfExpense — server implementation', () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(isRowOfExpense(c.row, c.expense, c.expenses)).toBe(c.expected);
    });
  }

  it('the id of an expense of the list is compared as text, as the row’s is', () => {
    // another expense, whose id is an object: it still decides over the row's text
    const other = { _id: { toString: () => 'e3' }, name: 'ΕΥΔΑΠ' };
    const e1 = { _id: 'e1', name: 'ΔΕΗ' };
    const stored = { expenseId: 'e3', description: 'ΔΕΗ', amount: 100 };
    expect(isRowOfExpense(stored, e1, [e1, other])).toBe(false);
  });

  it('the table is not empty and says both yes and no', () => {
    expect(CASES.length).toBeGreaterThan(15);
    expect(CASES.some((c) => c.expected === true)).toBe(true);
    expect(CASES.some((c) => c.expected === false)).toBe(true);
  });
});

describe('the yearly owner figure of one of two expenses with the same name', () => {
  // Two variable expenses called «ΔΕΗ», both followed for the owners (with no fixed
  // amount the projection takes the typed figure as the owners'). January: 100 typed
  // for the first, 60 for the second.
  const YEAR = 2026;
  const expense = (id) => ({
    _id: id,
    name: 'ΔΕΗ',
    type: 'electricity_private',
    amount: 0,
    isVariable: true,
    isRecurring: true,
    startTerm: 2026010100,
    endTerm: 2026010100,
    allocationMethod: 'equal',
    trackOwnerExpense: true,
    ownerAmount: 0
  });
  const row = (expenseId, inputAmount) => ({
    term: 2026010100,
    expenseId,
    description: 'ΔΕΗ',
    amount: inputAmount,
    inputAmount
  });
  const building = (rows1, rows2, expenses) => ({
    _id: 'b1',
    units: [
      { propertyId: 'p1', monthlyCharges: rows1 },
      { propertyId: 'p2', monthlyCharges: rows2 }
    ],
    expenses,
    ownerMonthlyExpenses: [],
    repairs: []
  });
  // No fixed owner amounts and no stored owner charges: the year's owner figure is
  // the typed figures alone, and both expenses run for January only (nothing is
  // estimated for later months).
  const variableOwnerYtd = (b) =>
    computeBuildingProjection(b, new Map(), YEAR, { year: YEAR, month: 11 })
      .annualOwnerExpenses;

  it('each counts its own month: 100 + 60, not the larger one twice', () => {
    const both = building(
      [row('e1', 100)],
      [row('e2', 60)],
      [expense('e1'), expense('e2')]
    );
    const onlyFirst = building([row('e1', 100)], [], [expense('e1')]);
    const onlySecond = building([], [row('e2', 60)], [expense('e2')]);
    expect(variableOwnerYtd(onlyFirst)).toBe(100);
    expect(variableOwnerYtd(onlySecond)).toBe(60);
    expect(variableOwnerYtd(both)).toBe(160);
  });

  it('a figure stored under an id that names no expense counts for the expense of its name', () => {
    const b = building([row('gone', 100)], [], [expense('e1')]);
    expect(variableOwnerYtd(b)).toBe(100);
  });

  it('and for nobody when two expenses have the name', () => {
    const b = building([row('gone', 100)], [], [expense('e1'), expense('e2')]);
    expect(variableOwnerYtd(b)).toBe(0);
  });

  it('a second expense of the name with nothing typed adds nothing', () => {
    const b = building([row('e1', 100)], [], [expense('e1'), expense('e2')]);
    expect(variableOwnerYtd(b)).toBe(100);
  });
});
