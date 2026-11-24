/**
 * Which stored unit charge belongs to which expense — and what the month's input of an
 * expense is pre-filled with because of it.
 *
 * Found by review on 24/11/2026, on a building with one «ΔΕΗ» per apartment (what the
 * bill import creates): 100 € typed for the first apartment's «ΔΕΗ» and saved; on
 * reload the second apartment's «ΔΕΗ» showed «100» as well, and since the panel sends
 * every figure of the month, the next save billed the second apartment's tenant 100 €.
 * The reader matched a row to an expense by `expenseId === id || description === name`:
 * the text matched a row that carried the OTHER expense's id.
 */
import { buildRowsForTerm } from '../components/buildings/BuildingExpensePanel';
import CASES from '../../../../services/common/src/utils/expenserows.cases.json';
import { enteredFiguresOfYear, isRowOfExpense } from '../utils/expenseRows';

const TERM = 2026110100;
const variable = (over) => ({
  type: 'electricity_private',
  amount: 0,
  isVariable: true,
  isRecurring: true,
  startTerm: 2026010100,
  allocationMethod: 'single_unit',
  ...over
});
const row = (over) => ({
  _id: `c${Math.round(Math.random() * 1e9)}`,
  term: TERM,
  amount: 100,
  inputAmount: 100,
  description: 'ΔΕΗ',
  ...over
});

describe('isRowOfExpense — the table the server copy runs too', () => {
  // services/common/src/utils/expenserows.cases.json; the api's
  // expenseRowsParity.test.js runs it through services/common's copy of the rule.
  for (const c of CASES) {
    it(c.name, () => {
      expect(isRowOfExpense(c.row, c.expense, c.expenses)).toBe(c.expected);
    });
  }
});

describe('isRowOfExpense', () => {
  const e1 = { _id: 'e1', name: 'ΔΕΗ' };
  const e2 = { _id: 'e2', name: 'ΔΕΗ' };
  const water = { _id: 'e3', name: 'ΕΥΔΑΠ' };

  it('a row is its own expense’s by its id', () => {
    expect(isRowOfExpense(row({ expenseId: 'e1' }), e1, [e1, e2])).toBe(true);
  });

  it('and never another expense’s, though the two are called the same', () => {
    expect(isRowOfExpense(row({ expenseId: 'e1' }), e2, [e1, e2])).toBe(false);
  });

  it('nor another’s when only that other one is left with the name', () => {
    // the first «ΔΕΗ» was removed; its old row still names its id
    expect(isRowOfExpense(row({ expenseId: 'e1' }), e2, [e2])).toBe(false);
  });

  it('an id stored as an object is compared as text', () => {
    const id = { toString: () => 'e1' };
    expect(isRowOfExpense(row({ expenseId: id }), e1, [e1])).toBe(true);
    expect(
      isRowOfExpense(row({ expenseId: 'e1' }), { _id: id, name: 'ΔΕΗ' }, [e1])
    ).toBe(true);
  });

  describe('a row with no id (written before rows carried one)', () => {
    const old = (over) => row({ expenseId: undefined, ...over });

    it('is the expense’s whose name it bears, when no other expense has that name', () => {
      expect(isRowOfExpense(old(), e1, [e1, water])).toBe(true);
      expect(isRowOfExpense(old(), water, [e1, water])).toBe(false);
    });

    it('is nobody’s when two expenses have the name — never a guess', () => {
      expect(isRowOfExpense(old(), e1, [e1, e2])).toBe(false);
      expect(isRowOfExpense(old(), e2, [e1, e2])).toBe(false);
    });

    it('spaces around either text do not matter, as on the server', () => {
      expect(
        isRowOfExpense(
          old({ description: ' ΔΕΗ ' }),
          { _id: 'e1', name: 'ΔΕΗ  ' },
          [{ _id: 'e1', name: 'ΔΕΗ  ' }]
        )
      ).toBe(true);
    });

    it.each([
      ['a repair’s row (it has a repair id)', { repairId: 'r1' }],
      ['a repair’s old row («Repair: …»)', { description: 'Repair: ΔΕΗ' }],
      ['a row with no text', { description: '' }],
      ['a row with no text at all', { description: undefined }],
      [
        'a hand-typed charge called something else',
        { description: 'ΔΕΗ Μαρτίου' }
      ]
    ])('%s is not the expense’s', (_, over) => {
      expect(isRowOfExpense(old(over), e1, [e1])).toBe(false);
    });

    it('an empty id counts as no id', () => {
      expect(isRowOfExpense(old({ expenseId: '' }), e1, [e1])).toBe(true);
      expect(isRowOfExpense(old({ expenseId: null }), e1, [e1])).toBe(true);
    });
  });

  it.each([
    [null, { _id: 'e1', name: 'ΔΕΗ' }],
    [undefined, { _id: 'e1', name: 'ΔΕΗ' }],
    [{ description: 'ΔΕΗ' }, null],
    [{ description: 'ΔΕΗ' }, undefined]
  ])('nothing breaks on a missing row or expense', (r, e) => {
    expect(isRowOfExpense(r, e, [])).toBe(false);
  });

  it('a list of expenses with holes in it breaks nothing', () => {
    expect(
      isRowOfExpense(row({ expenseId: undefined }), e1, [
        null,
        e1,
        undefined,
        {}
      ])
    ).toBe(true);
    expect(isRowOfExpense(row({ expenseId: undefined }), e1, undefined)).toBe(
      false
    );
  });
});

describe('the month’s input of one of two expenses with the same name', () => {
  // one «ΔΕΗ» per apartment, each charged to its own apartment
  const building = (rowsOfUnit1 = [], rowsOfUnit2 = []) => ({
    _id: 'b1',
    name: 'ΟΔΟΣ ΑΛΦΑ 24',
    units: [
      { _id: 'u1', propertyId: 'p1', monthlyCharges: rowsOfUnit1 },
      { _id: 'u2', propertyId: 'p2', monthlyCharges: rowsOfUnit2 }
    ],
    expenses: [
      variable({
        _id: 'e1',
        name: 'ΔΕΗ',
        customAllocations: [{ propertyId: 'p1', value: 100 }]
      }),
      variable({
        _id: 'e2',
        name: 'ΔΕΗ',
        customAllocations: [{ propertyId: 'p2', value: 100 }]
      })
    ],
    ownerMonthlyExpenses: []
  });
  const amounts = (b) =>
    buildRowsForTerm(b, String(TERM), false).map((r) => [
      r.expenseId,
      r.amount
    ]);

  it('100 € typed for the first: the second stays blank', () => {
    expect(amounts(building([row({ expenseId: 'e1' })]))).toEqual([
      ['e1', 100],
      ['e2', '']
    ]);
  });

  it('each shows its own figure when both have one', () => {
    expect(
      amounts(
        building(
          [row({ expenseId: 'e1' })],
          [row({ expenseId: 'e2', amount: 60, inputAmount: 60 })]
        )
      )
    ).toEqual([
      ['e1', 100],
      ['e2', 60]
    ]);
  });

  it('whichever of the two comes first in the list', () => {
    const b = building(
      [],
      [row({ expenseId: 'e2', amount: 60, inputAmount: 60 })]
    );
    expect(amounts(b)).toEqual([
      ['e1', ''],
      ['e2', 60]
    ]);
  });

  it('an old row with no id is neither’s: both stay blank rather than both show it', () => {
    expect(amounts(building([row({ expenseId: undefined })]))).toEqual([
      ['e1', ''],
      ['e2', '']
    ]);
  });

  it('another month’s figure is not this month’s', () => {
    expect(
      amounts(building([row({ expenseId: 'e1', term: 2026100100 })]))
    ).toEqual([
      ['e1', ''],
      ['e2', '']
    ]);
  });
});

describe('one expense of its name reads back as before', () => {
  const building = (rows) => ({
    _id: 'b1',
    name: 'ΟΔΟΣ ΑΛΦΑ 24',
    units: [
      { _id: 'u1', propertyId: 'p1', monthlyCharges: rows },
      { _id: 'u2', propertyId: 'p2', monthlyCharges: [] }
    ],
    expenses: [
      variable({
        _id: 'e1',
        name: 'Πετρέλαιο',
        type: 'heating',
        allocationMethod: 'equal'
      }),
      variable({ _id: 'e2', name: 'ΔΕΗ' })
    ],
    ownerMonthlyExpenses: []
  });
  const amountOf = (b, id) =>
    buildRowsForTerm(b, String(TERM), false).find((r) => r.expenseId === id)
      .amount;

  it('by its id', () => {
    const b = building([
      row({
        expenseId: 'e1',
        description: 'Πετρέλαιο',
        amount: 250,
        inputAmount: 500
      })
    ]);
    expect(amountOf(b, 'e1')).toBe(500);
    expect(amountOf(b, 'e2')).toBe('');
  });

  it('by its name, for a row from before rows carried an id (its shares are added up)', () => {
    const b = building([
      row({
        expenseId: undefined,
        description: 'Πετρέλαιο',
        amount: 250,
        inputAmount: undefined
      }),
      row({
        expenseId: undefined,
        description: 'Πετρέλαιο',
        amount: 250,
        inputAmount: undefined
      })
    ]);
    expect(amountOf(b, 'e1')).toBe(500);
  });

  it('a renamed expense keeps the figures of the rows that name its id', () => {
    const b = building([
      row({
        expenseId: 'e1',
        description: 'Θέρμανση (παλιό όνομα)',
        amount: 250,
        inputAmount: 500
      })
    ]);
    expect(amountOf(b, 'e1')).toBe(500);
  });
});

describe('the figures typed for an expense in a year (the building page’s yearly card)', () => {
  const e1 = variable({ _id: 'e1', name: 'ΔΕΗ' });
  const e2 = variable({ _id: 'e2', name: 'ΔΕΗ' });
  const heating = variable({ _id: 'h', name: 'Πετρέλαιο', type: 'heating' });
  const b = (expenses, ...unitRows) => ({
    _id: 'b1',
    expenses,
    units: unitRows.map((rows, i) => ({ _id: `u${i}`, monthlyCharges: rows }))
  });
  const figures = (building, expense, year) =>
    enteredFiguresOfYear(building?.units, building?.expenses, expense, year);
  const share = (expenseId, term, inputAmount, amount = inputAmount / 2) =>
    row({ expenseId, term, inputAmount, amount });

  it('one figure per month, oldest first, however many apartments share it', () => {
    const building = b(
      [heating],
      [share('h', 2026030100, 400), share('h', 2026010100, 500)],
      [share('h', 2026010100, 500), share('h', 2026030100, 400)]
    );
    expect(figures(building, heating, 2026)).toEqual([500, 400]);
  });

  it('two expenses of one name: each has its own months', () => {
    const building = b(
      [e1, e2],
      [share('e1', 2026010100, 100, 100), share('e1', 2026020100, 110, 110)],
      [share('e2', 2026010100, 60, 60)]
    );
    expect(figures(building, e1, 2026)).toEqual([100, 110]);
    // it used to read [60, 110]: January's last row of EITHER expense, and the
    // other one's February
    expect(figures(building, e2, 2026)).toEqual([60]);
  });

  it('another year’s figures are not this year’s', () => {
    const building = b(
      [heating],
      [share('h', 2025120100, 300), share('h', 2026010100, 500)]
    );
    expect(figures(building, heating, 2026)).toEqual([500]);
    expect(figures(building, heating, 2025)).toEqual([300]);
  });

  it('rows from before the typed figure was stored: the month’s shares are added up', () => {
    const building = b(
      [heating],
      [
        row({
          expenseId: 'h',
          term: 2026010100,
          amount: 250,
          inputAmount: undefined
        })
      ],
      [
        row({
          expenseId: 'h',
          term: 2026010100,
          amount: 250,
          inputAmount: null
        })
      ]
    );
    expect(figures(building, heating, 2026)).toEqual([500]);
  });

  it('a figure typed as 0 is a month with 0, also beside an old row that has only a share', () => {
    const building = b(
      [heating],
      [share('h', 2026010100, 0, 0)],
      [
        row({
          expenseId: 'h',
          term: 2026010100,
          amount: 5,
          inputAmount: undefined
        })
      ]
    );
    expect(figures(building, heating, 2026)).toEqual([0]);
  });

  it.each([
    ['no building', undefined],
    ['a building with no apartments', { expenses: [heating] }],
    ['an apartment with no rows', { expenses: [heating], units: [{}] }],
    [
      'an empty slot among the rows',
      { expenses: [heating], units: [{ monthlyCharges: [null] }] }
    ]
  ])('%s: nothing, and nothing breaks', (_, building) => {
    expect(figures(building, heating, 2026)).toEqual([]);
  });
});
