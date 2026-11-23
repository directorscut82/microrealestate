import 'moment/locale/el';
import {
  applyAllocation,
  autoSpreadAllocation,
  buildingLineKey,
  buildingLineOf,
  computeOwedLines,
  owedLinesOf
} from '../utils/paymentAllocation';
import { buildingLineLabel, forMonthSuffix } from '../utils/lineLabels';
import moment from 'moment';

// A share of a building charge whose own month was closed for the tenant when the
// bill arrived is billed on the tenant's next open month, as one more line after the
// month's own (services/api …/tasks/1_base.ts `_carriedInto`, DEFERRED_DECISIONS
// D-10). On every screen that line says which month it is for — the owner's wording:
// «… · για Οκτώβριο 2026» — and a payment attributed to it names it by what it is,
// not by its position.

const OCT = 2026100100;
const SEP = 2026090100;

// next-translate's `t`, as far as these labels go: the el strings they use.
const EL = {
  'Electricity Common': 'Κοινόχρηστο Ρεύμα',
  'Water Common': 'Κοινόχρηστο Νερό',
  Other: 'Λοιπά',
  Repair: 'Επισκευή',
  'for {{month}}': 'για {{month}}'
};
const t = (key, values = {}) =>
  (EL[key] ?? key).replace(/\{\{(\w+)\}\}/g, (m, name) => values[name] ?? m);
const tEn = (key, values = {}) =>
  key.replace(/\{\{(\w+)\}\}/g, (m, name) => values[name] ?? m);
// The suffix is held together by no-break spaces (pinned in its own test below);
// everywhere else the labels are compared as they read.
const NBSP = '\u00a0';
const label = (charge, lang, translate = t) =>
  buildingLineLabel(translate, charge, lang).replace(/\u00a0/g, ' ');

const own = {
  description: 'HARNESS ΡΕΥΜΑ',
  amount: 40,
  buildingName: 'HARNESS',
  type: 'electricity_common',
  propertyId: 'pA',
  expenseId: 'ePower'
};
const carried = { ...own, amount: 30, forTerm: OCT };

describe('the label of a building line', () => {
  it('a line of the month itself reads exactly as it always did', () => {
    expect(label(own, 'el')).toBe(
      'Κοινόχρηστο Ρεύμα  (HARNESS - HARNESS ΡΕΥΜΑ)'
    );
    // …with or without the language
    expect(label(own)).toBe('Κοινόχρηστο Ρεύμα  (HARNESS - HARNESS ΡΕΥΜΑ)');
  });

  it('a share carried in says which month it is for, in the accusative', () => {
    expect(label(carried, 'el')).toBe(
      'Κοινόχρηστο Ρεύμα  (HARNESS - HARNESS ΡΕΥΜΑ) · για Οκτώβριο 2026'
    );
    expect(label(carried, 'el')).not.toContain('Οκτώβριος');
  });

  it('the month stays with its «για»: a label can wrap before the suffix, never inside it', () => {
    expect(forMonthSuffix(t, carried, 'el')).toBe(
      ` ·${NBSP}για${NBSP}Οκτώβριο${NBSP}2026`
    );
    // …and the label itself is untouched by it
    expect(buildingLineLabel(t, carried, 'el')).toBe(
      `${buildingLineLabel(t, own, 'el')} ·${NBSP}για${NBSP}Οκτώβριο${NBSP}2026`
    );
  });

  it('in English', () => {
    // other languages do not inflect: the month name is the app's own (moment's)
    moment.locale('en');
    try {
      expect(label(carried, 'en', tEn)).toBe(
        'Electricity Common  (HARNESS - HARNESS ΡΕΥΜΑ) · for October 2026'
      );
    } finally {
      moment.locale('el');
    }
  });

  it('with no name and no building, the month still follows the kind', () => {
    expect(label({ type: 'water_common', forTerm: SEP }, 'el')).toBe(
      'Κοινόχρηστο Νερό · για Σεπτέμβριο 2026'
    );
  });

  it.each([
    ['a text', 'October'],
    ['a fraction', OCT + 0.5],
    ['null', null],
    ['missing', undefined],
    ['a month that does not exist', 2026130100],
    ['zero', 0]
  ])('a line whose month is %s says no month', (_what, forTerm) => {
    expect(forMonthSuffix(t, { forTerm }, 'el')).toBe('');
    expect(label({ ...own, forTerm }, 'el')).toBe(
      'Κοινόχρηστο Ρεύμα  (HARNESS - HARNESS ΡΕΥΜΑ)'
    );
  });

  it('nothing to label: no month, nothing breaks', () => {
    expect(forMonthSuffix(t, undefined, 'el')).toBe('');
    expect(forMonthSuffix(t, null, 'el')).toBe('');
  });
});

describe('the key of a building line', () => {
  it('a line of the month itself is named by its position, a carried one by what it is', () => {
    expect(buildingLineKey(own, 0)).toBe('building:0');
    expect(buildingLineKey(own, 7)).toBe('building:7');
    // the month it is for as «2610»: with database ids the whole key is 63 characters,
    // under the 64 every version of the server accepts
    expect(buildingLineKey(carried, 7)).toBe('building:pA:ePower:2610');
    expect(
      buildingLineKey(
        {
          propertyId: '507f1f77bcf86cd799439011',
          expenseId: '507f191e810c19729de860ea',
          forTerm: OCT
        },
        0
      ).length
    ).toBe(63);
  });

  it.each([
    ['no unit', { expenseId: 'e', forTerm: OCT }],
    ['no expense', { propertyId: 'p', forTerm: OCT }],
    [
      'a month that is a text',
      { propertyId: 'p', expenseId: 'e', forTerm: 'x' }
    ],
    [
      'a month that is a fraction',
      { propertyId: 'p', expenseId: 'e', forTerm: 1.5 }
    ],
    ['nothing at all', undefined]
  ])('a line with %s falls back to its position', (_what, damaged) => {
    expect(buildingLineKey(damaged, 3)).toBe('building:3');
  });

  it('a key finds its line; a position never finds a carried line', () => {
    const rent = {
      buildingCharges: [{ description: 'Water', amount: 25 }, carried]
    };
    expect(buildingLineOf(rent, 'building:0').description).toBe('Water');
    expect(buildingLineOf(rent, 'building:pA:ePower:2610')).toBe(carried);
    expect(buildingLineOf(rent, 'building:1')).toBe(null);
    expect(buildingLineOf(rent, 'building:2')).toBe(null);
    expect(buildingLineOf(rent, 'building:pA:ePower:2609')).toBe(null);
    // a position is read as the number it is, as it always was
    expect(buildingLineOf(rent, 'building:00').description).toBe('Water');
    expect(buildingLineOf(rent, 'building:01')).toBe(null);
    expect(buildingLineOf(rent, undefined)).toBe(null);
    expect(buildingLineOf({}, 'building:0')).toBe(null);
    expect(buildingLineOf(null, 'building:0')).toBe(null);
  });
});

// A row as `/rents/…` returns it (frontdata.ts toRentData), for a 200 € month with
// its own water (25) and October's power (30) carried in: 255 to pay.
const row = (extra = {}) => ({
  term: 2026110100,
  totalToPay: 255,
  balance: 0,
  totalWithoutBalanceAmount: 255,
  payment: 0,
  payments: [],
  promo: 0,
  extracharge: 0,
  vatAmount: 0,
  preTaxAmounts: [{ description: 'Apt A', amount: 200 }],
  charges: [],
  buildingCharges: [
    {
      description: 'Water',
      amount: 25,
      buildingName: 'HARNESS',
      type: 'water_common',
      propertyId: 'pA',
      expenseId: 'eWater'
    },
    carried
  ],
  ...extra
});
const POWER_KEY = 'building:pA:ePower:2610';

describe('the payment window on a month that holds a carried share', () => {
  it('lists it after the month’s own lines, with its own key and its month', () => {
    const lines = computeOwedLines(row());
    expect(lines.map((l) => [l.lineKey, l.amount])).toEqual([
      ['preTax:0', 200],
      ['building:0', 25],
      [POWER_KEY, 30]
    ]);
    expect(lines[1].forTerm).toBeUndefined();
    expect('forTerm' in lines[1]).toBe(false);
    expect(lines[2]).toEqual({
      category: 'buildingCharge',
      lineKey: POWER_KEY,
      description: 'HARNESS ΡΕΥΜΑ',
      amount: 30,
      type: 'electricity_common',
      buildingName: 'HARNESS',
      forTerm: OCT
    });
    // …and its label in the window says the month
    expect(label(lines[2], 'el')).toBe(
      'Κοινόχρηστο Ρεύμα  (HARNESS - HARNESS ΡΕΥΜΑ) · για Οκτώβριο 2026'
    );
  });

  it('a payment with no choice made is spread over it like over any line', () => {
    expect(autoSpreadAllocation(255, computeOwedLines(row()))).toEqual([
      { category: 'rent', lineKey: 'preTax:0', amount: 200 },
      { category: 'buildingCharge', lineKey: 'building:0', amount: 25 },
      { category: 'buildingCharge', lineKey: POWER_KEY, amount: 30 }
    ]);
  });

  it('a saved payment on the carried share is taken off that line', () => {
    const saved = [
      {
        amount: 30,
        allocation: [
          { category: 'buildingCharge', lineKey: POWER_KEY, amount: 30 }
        ]
      }
    ];
    expect(
      owedLinesOf(row({ payment: 30, payments: saved }), saved).map((l) => [
        l.lineKey,
        l.amount
      ])
    ).toEqual([
      ['preTax:0', 200],
      ['building:0', 25],
      [POWER_KEY, 0]
    ]);
  });

  it('another late share arrives and takes the place before it: the saved payment stays on its share', () => {
    const saved = [
      {
        amount: 30,
        allocation: [
          { category: 'buildingCharge', lineKey: POWER_KEY, amount: 30 }
        ]
      }
    ];
    const withSeptember = row({
      totalToPay: 270,
      totalWithoutBalanceAmount: 270,
      payment: 30,
      payments: saved,
      buildingCharges: [
        row().buildingCharges[0],
        {
          description: 'Water',
          amount: 15,
          buildingName: 'HARNESS',
          type: 'water_common',
          propertyId: 'pA',
          expenseId: 'eWater',
          forTerm: SEP
        },
        carried
      ]
    });
    expect(
      owedLinesOf(withSeptember, saved).map((l) => [l.lineKey, l.amount])
    ).toEqual([
      ['preTax:0', 200],
      ['building:0', 25],
      ['building:pA:eWater:2609', 15],
      [POWER_KEY, 0]
    ]);
  });

  it('a saved position that a carried line has slid into does not pay that line', () => {
    // `building:1` named a second line of the month itself, which has gone.
    const lines = computeOwedLines(row());
    const { remainingLines } = applyAllocation(lines, [
      { category: 'buildingCharge', lineKey: 'building:1', amount: 30 }
    ]);
    expect(remainingLines.map((l) => [l.lineKey, l.amount])).toEqual([
      ['preTax:0', 200],
      ['building:0', 25],
      [POWER_KEY, 30]
    ]);
  });
});
