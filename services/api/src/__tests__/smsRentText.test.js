/* eslint-env node, jest */
/**
 * The amounts in brackets of the rent SMS.
 *
 * A share of a building charge billed on a LATER month than the one it is for
 * (DEFERRED_DECISIONS D-10) is shown on its own, with its month — owner's decision of
 * 24/11/2026, his example: «Ενοίκιο: 400€, Κοινόχρ: 40€, Κοινόχρ 10/2026: 30€».
 * Until then it was folded into «Κοινόχρ» (70€): the total was right, but the SMS was
 * the one place a tenant could not see why this month's common charges were higher.
 *
 * Everything else about the text is as it was: the second half of this file compares
 * the new function with the code it replaced, character for character, on rents that
 * carry no such share.
 */
import { rentSmsAmounts } from '../managers/smstext.js';

const NOV = 2026110100;
const line = (amount, over = {}) => ({
  description: 'Common power',
  amount,
  buildingName: 'Building 1',
  type: 'electricity_common',
  propertyId: 'A',
  expenseId: 'power',
  ...over
});
const rent = (over = {}) => ({
  term: NOV,
  total: { preTaxAmount: 400, grandTotal: 400, balance: 0 },
  buildingCharges: [],
  ...over
});

/** The code this function replaced (emailmanager.ts `_sendSms` on 61d3dccf), kept verbatim. */
function asItWas(rentRecord) {
  const grandTotal = rentRecord?.total?.grandTotal ?? 0;
  const fmt = (n) =>
    n.toLocaleString('el-GR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }) + '€';
  let amountPart = '';
  if (rentRecord) {
    const parts = [];
    const rentAmount = rentRecord.total?.preTaxAmount ?? 0;
    const buildingCharges = rentRecord.buildingCharges || [];
    const repairs = buildingCharges.filter((c) => c.type === 'repair');
    const koinoxrhsta = buildingCharges.filter((c) => c.type !== 'repair');
    const koinoSum = koinoxrhsta.reduce((s, c) => s + (c.amount || 0), 0);
    const repairSum = repairs.reduce((s, c) => s + (c.amount || 0), 0);
    const balance = rentRecord.total?.balance ?? 0;
    if (rentAmount) parts.push(`Ενοίκιο: ${fmt(rentAmount)}`);
    if (koinoSum) parts.push(`Κοινόχρ: ${fmt(koinoSum)}`);
    if (repairSum) parts.push(`Επισκευή: ${fmt(repairSum)}`);
    if (balance > 0) parts.push(`Υπόλοιπο: ${fmt(balance)}`);
    const shownSum =
      rentAmount + koinoSum + repairSum + (balance > 0 ? balance : 0);
    const other = Math.round((grandTotal - shownSum) * 100) / 100;
    if (Math.abs(other) > 0.005) parts.push(`Άλλα: ${fmt(other)}`);
    if (parts.length > 1) {
      amountPart = ` (${parts.join(', ')}, ΣΥΝΟΛΟ: ${fmt(grandTotal)})`;
    } else {
      amountPart = ` (${fmt(grandTotal)})`;
    }
  }
  return amountPart;
}

/** Every amount the brackets list before ΣΥΝΟΛΟ, added up, and ΣΥΝΟΛΟ itself. */
function addedUp(text) {
  const euros = (s) => Number(s.replace(/\./g, '').replace(',', '.'));
  const items = [...text.matchAll(/([^,(]+): (-?[\d.,]+)€/g)].map((m) => [
    m[1].trim(),
    euros(m[2])
  ]);
  const total = items.find(([name]) => name === 'ΣΥΝΟΛΟ');
  const rest = items.filter(([name]) => name !== 'ΣΥΝΟΛΟ');
  return {
    sum: Math.round(rest.reduce((s, [, v]) => s + v, 0) * 100) / 100,
    total: total ? total[1] : null
  };
}

describe('a share carried in from an older month', () => {
  it('is shown on its own, with its month — the owner’s example', () => {
    const r = rent({
      total: { preTaxAmount: 400, grandTotal: 470, balance: 0 },
      buildingCharges: [line(40), line(30, { forTerm: 2026100100 })]
    });
    expect(rentSmsAmounts(r)).toBe(
      ' (Ενοίκιο: 400€, Κοινόχρ: 40€, Κοινόχρ 10/2026: 30€, ΣΥΝΟΛΟ: 470€)'
    );
    // it used to say 70€ of common charges
    expect(asItWas(r)).toBe(' (Ενοίκιο: 400€, Κοινόχρ: 70€, ΣΥΝΟΛΟ: 470€)');
  });

  it('two lines for the same older month are one item', () => {
    const r = rent({
      total: { preTaxAmount: 400, grandTotal: 485, balance: 0 },
      buildingCharges: [
        line(40),
        line(30, { forTerm: 2026100100 }),
        line(15, { forTerm: 2026100100, type: 'water_common', expenseId: 'w' })
      ]
    });
    expect(rentSmsAmounts(r)).toBe(
      ' (Ενοίκιο: 400€, Κοινόχρ: 40€, Κοινόχρ 10/2026: 45€, ΣΥΝΟΛΟ: 485€)'
    );
  });

  it('several older months are listed oldest first, whatever order the lines are in', () => {
    // six months of heating typed late, as on the real ledgers of 24/11/2026
    const months = [
      [2026030100, 80],
      [2026010100, 100],
      [2026060100, 16],
      [2026020100, 90],
      [2026050100, 30],
      [2026040100, 50]
    ];
    const r = rent({
      total: { preTaxAmount: 200, grandTotal: 1366, balance: 764 },
      buildingCharges: [
        line(36),
        ...months.map(([forTerm, amount]) =>
          line(amount, { type: 'heating', expenseId: 'oil', forTerm })
        )
      ]
    });
    expect(rentSmsAmounts(r)).toBe(
      ' (Ενοίκιο: 200€, Κοινόχρ: 36€, Κοινόχρ 01/2026: 100€, Κοινόχρ 02/2026: 90€, ' +
        'Κοινόχρ 03/2026: 80€, Κοινόχρ 04/2026: 50€, Κοινόχρ 05/2026: 30€, ' +
        'Κοινόχρ 06/2026: 16€, Υπόλοιπο: 764€, ΣΥΝΟΛΟ: 1.366€)'
    );
  });

  it('a share from last year sorts before this year’s', () => {
    const r = rent({
      total: { preTaxAmount: 400, grandTotal: 450, balance: 0 },
      buildingCharges: [
        line(20, { forTerm: 2026010100 }),
        line(30, { forTerm: 2025120100 })
      ]
    });
    expect(rentSmsAmounts(r)).toBe(
      ' (Ενοίκιο: 400€, Κοινόχρ 12/2025: 30€, Κοινόχρ 01/2026: 20€, ΣΥΝΟΛΟ: 450€)'
    );
  });

  it('a month that bills nothing but common charges lists them too once one is from an older month', () => {
    const r = rent({
      total: { preTaxAmount: 0, grandTotal: 70, balance: 0 },
      buildingCharges: [line(40), line(30, { forTerm: 2026100100 })]
    });
    expect(asItWas(r)).toBe(' (70€)');
    expect(rentSmsAmounts(r)).toBe(
      ' (Κοινόχρ: 40€, Κοινόχρ 10/2026: 30€, ΣΥΝΟΛΟ: 70€)'
    );
  });

  it('a late share that is the only amount still names its month', () => {
    const r = {
      term: 2026110100,
      total: { preTaxAmount: 0, balance: 0, grandTotal: 30 },
      buildingCharges: [
        { amount: 30, type: 'electricity_private', forTerm: 2026100100 }
      ]
    };
    expect(rentSmsAmounts(r)).toBe(' (Κοινόχρ 10/2026: 30€, ΣΥΝΟΛΟ: 30€)');
  });

  it('a single amount that is not a late share stays bare', () => {
    const r = {
      term: 2026110100,
      total: { preTaxAmount: 0, balance: 0, grandTotal: 30 },
      buildingCharges: [{ amount: 30, type: 'electricity_private' }]
    };
    expect(rentSmsAmounts(r)).toBe(' (30€)');
  });

  it('with no charges of the month itself there is no bare «Κοινόχρ» item', () => {
    const r = rent({
      total: { preTaxAmount: 400, grandTotal: 430, balance: 0 },
      buildingCharges: [line(30, { forTerm: 2026100100 })]
    });
    expect(rentSmsAmounts(r)).toBe(
      ' (Ενοίκιο: 400€, Κοινόχρ 10/2026: 30€, ΣΥΝΟΛΟ: 430€)'
    );
  });

  it('cents are kept, and the items still add up to ΣΥΝΟΛΟ', () => {
    const r = rent({
      total: { preTaxAmount: 412.5, grandTotal: 482.86, balance: 0 },
      buildingCharges: [
        line(33.33),
        line(18.52, { forTerm: 2026100100 }),
        line(18.51, { forTerm: 2026100100 })
      ]
    });
    const text = rentSmsAmounts(r);
    expect(text).toBe(
      ' (Ενοίκιο: 412,5€, Κοινόχρ: 33,33€, Κοινόχρ 10/2026: 37,03€, ΣΥΝΟΛΟ: 482,86€)'
    );
    expect(addedUp(text)).toEqual({ sum: 482.86, total: 482.86 });
  });

  it('a repair stays «Επισκευή», and what is not itemised stays «Άλλα»', () => {
    const r = rent({
      // 400 rent + 40 + 30 + 120 repair + 96 VAT + 50 owed from before
      total: { preTaxAmount: 400, grandTotal: 736, balance: 50 },
      buildingCharges: [
        line(40),
        line(30, { forTerm: 2026100100 }),
        line(120, { type: 'repair', repairId: 'roof', expenseId: undefined })
      ]
    });
    const text = rentSmsAmounts(r);
    expect(text).toBe(
      ' (Ενοίκιο: 400€, Κοινόχρ: 40€, Κοινόχρ 10/2026: 30€, Επισκευή: 120€, ' +
        'Υπόλοιπο: 50€, Άλλα: 96€, ΣΥΝΟΛΟ: 736€)'
    );
    expect(addedUp(text)).toEqual({ sum: 736, total: 736 });
  });

  it.each([
    ['is the rent’s own month', NOV, 'Κοινόχρ 11/2026'],
    ['is a later month', 2026120100, 'Κοινόχρ 12/2026']
  ])(
    'a line whose «for» month %s is a carried share, as on the printed notice and in the e-mail',
    (_, forTerm, item) => {
      const r = rent({
        total: { preTaxAmount: 400, grandTotal: 470, balance: 0 },
        buildingCharges: [line(40), line(30, { forTerm })]
      });
      expect(rentSmsAmounts(r)).toBe(
        ` (Ενοίκιο: 400€, Κοινόχρ: 40€, ${item}: 30€, ΣΥΝΟΛΟ: 470€)`
      );
    }
  );

  it.each([
    ['is six digits long', 202610],
    ['has odd trailing digits', 2026109900],
    ['is eight digits long', 20261001],
    ['has month 13', 2026130100],
    ['is 99', 99],
    ['is 0', 0],
    ['is null', null],
    ['is text that is no month', 'October'],
    ['is a month kept as text', '2026100100']
  ])(
    'a line whose «for» month %s counts with the month’s own charges — no unreadable date in an SMS',
    (_, forTerm) => {
      const r = rent({
        total: { preTaxAmount: 400, grandTotal: 470, balance: 0 },
        buildingCharges: [line(40), line(30, { forTerm })]
      });
      expect(rentSmsAmounts(r)).toBe(
        ' (Ενοίκιο: 400€, Κοινόχρ: 70€, ΣΥΝΟΛΟ: 470€)'
      );
    }
  );

  it('a repair stays «Επισκευή» whatever month it says it is for', () => {
    const r = rent({
      total: { preTaxAmount: 400, grandTotal: 470, balance: 0 },
      buildingCharges: [
        line(40),
        line(30, { type: 'repair', repairId: 'roof', forTerm: 2026100100 })
      ]
    });
    expect(rentSmsAmounts(r)).toBe(
      ' (Ενοίκιο: 400€, Κοινόχρ: 40€, Επισκευή: 30€, ΣΥΝΟΛΟ: 470€)'
    );
  });

  it('a «for» month stored as text is not a carried share — the printed notice and the e-mail do not name a month for it either', () => {
    const r = rent({
      total: { preTaxAmount: 400, grandTotal: 470, balance: 0 },
      buildingCharges: [line(40), line(30, { forTerm: '2026100100' })]
    });
    expect(rentSmsAmounts(r)).toBe(
      ' (Ενοίκιο: 400€, Κοινόχρ: 70€, ΣΥΝΟΛΟ: 470€)'
    );
  });
});

describe('everything else is as it was', () => {
  it.each([
    ['no rent for the month', undefined],
    ['no rent for the month (null)', null],
    ['a rent with nothing on it', { term: NOV }],
    ['rent only', rent()],
    [
      'rent and common charges',
      rent({
        total: { preTaxAmount: 400, grandTotal: 440, balance: 0 },
        buildingCharges: [line(40)]
      })
    ],
    [
      'a credit carried in (negative balance)',
      rent({ total: { preTaxAmount: 400, grandTotal: 350, balance: -50 } })
    ],
    [
      'only a debt from before',
      rent({ total: { preTaxAmount: 0, grandTotal: 120, balance: 120 } })
    ],
    [
      'a line with no amount',
      rent({
        total: { preTaxAmount: 400, grandTotal: 400, balance: 0 },
        buildingCharges: [line(undefined)]
      })
    ]
  ])('%s', (_, r) => {
    expect(rentSmsAmounts(r)).toBe(asItWas(r));
  });

  it('5,000 random rents that carry no older share read exactly as before', () => {
    let seed = 20261124;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const money = (max) => Math.round(rnd() * max * 100) / 100;
    const types = [
      'electricity_common',
      'water_common',
      'heating',
      'repair',
      'insurance',
      undefined
    ];
    let different = 0;
    let withCharges = 0;
    for (let i = 0; i < 5000; i++) {
      const charges = Array.from({ length: Math.floor(rnd() * 6) }, () =>
        line(rnd() < 0.1 ? 0 : money(200), {
          type: types[Math.floor(rnd() * types.length)]
        })
      );
      const pre = rnd() < 0.15 ? 0 : money(900);
      const balance = rnd() < 0.3 ? 0 : money(600) - 200;
      const sum = charges.reduce((s, c) => s + c.amount, 0);
      const extra = rnd() < 0.4 ? money(150) - 40 : 0; // VAT, debts, discounts
      const r = rent({
        total: {
          preTaxAmount: pre,
          balance,
          grandTotal: Math.round((pre + sum + balance + extra) * 100) / 100
        },
        buildingCharges: charges
      });
      if (charges.length) withCharges++;
      if (rentSmsAmounts(r) !== asItWas(r)) different++;
    }
    expect(withCharges).toBeGreaterThan(3000);
    expect(different).toBe(0);
  });

  it('2,000 random rents WITH older shares: same ΣΥΝΟΛΟ, same items but for «Κοινόχρ», and the items add up as before', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const euros = (max) => Math.round(rnd() * max); // whole euros: sums are exact
    const older = [2026100100, 2026090100, 2026010100, 2025120100];
    for (let i = 0; i < 2000; i++) {
      const charges = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () =>
        line(1 + euros(200), {
          type: rnd() < 0.2 ? 'repair' : 'heating',
          ...(rnd() < 0.6
            ? { forTerm: older[Math.floor(rnd() * older.length)] }
            : {})
        })
      );
      const pre = 1 + euros(900); // always a rent item: the brackets list items both before and now
      const balance = euros(600) - 200;
      const sum = charges.reduce((s, c) => s + c.amount, 0);
      const r = rent({
        total: {
          preTaxAmount: pre,
          balance,
          grandTotal: pre + sum + balance + euros(100)
        },
        buildingCharges: charges
      });
      const now = rentSmsAmounts(r);
      const was = asItWas(r);
      const strip = (t) => t.replace(/Κοινόχρ[^,]*: [^,]+, /g, '');
      expect(strip(now)).toBe(strip(was));
      expect(addedUp(now)).toEqual(addedUp(was));
    }
  });
});

// The helpers that decide, on the printed notice and in the e-mail, whether a line is
// dated (`Number.isInteger(forTerm)` and a non-empty `formatTermFor`) — the real ones,
// loaded as carriedShareOnPaper.test.js loads them.
describe('the SMS names a month exactly where the printed notice and the e-mail do', () => {
  let pdf;
  let mail;
  beforeAll(async () => {
    const open = async (file) => {
      const mod = await import(file);
      return (mod.default?.default ?? mod.default)({
        locale: 'el',
        currency: 'EUR'
      });
    };
    pdf = await open('../../../pdfgenerator/src/utils/templatefunctions.js');
    mail = await open('../../../emailer/src/utils/templatefunctions.js');
  });

  it('for every shape of «for» month', () => {
    const forTerms = [
      2026100100, 2026110100, 2026120100, 202610, 2026109900, 2026130100, 99, 0
    ];
    const namedBySms = forTerms.filter((forTerm) => {
      const r = rent({
        total: { preTaxAmount: 400, grandTotal: 470, balance: 0 },
        buildingCharges: [line(40), line(30, { forTerm })]
      });
      return /Κοινόχρ \d\d\/\d{4}: 30€/.test(rentSmsAmounts(r));
    });
    expect(forTerms.filter((t) => pdf.formatTermFor(t) !== '')).toEqual(
      namedBySms
    );
    expect(forTerms.filter((t) => mail.formatTermFor(t) !== '')).toEqual(
      namedBySms
    );
    // and the comparison is not an empty one
    expect(namedBySms).toEqual([2026100100, 2026110100, 2026120100]);
  });
});

describe('the SMS lists no zero item, a carried share included', () => {
  const OCT = 2026100100;

  it('a carried share of 0 that is the only line leaves the bare total', () => {
    const r = rent({
      total: { preTaxAmount: 0, grandTotal: 0, balance: 0 },
      buildingCharges: [line(0, { forTerm: OCT })]
    });
    expect(rentSmsAmounts(r)).toBe(' (0€)');
  });

  it('two carried lines of one month that cancel out leave what the rent alone gives', () => {
    const r = rent({
      total: { preTaxAmount: 400, grandTotal: 400, balance: 0 },
      buildingCharges: [line(30, { forTerm: OCT }), line(-30, { forTerm: OCT })]
    });
    expect(rentSmsAmounts(r)).toBe(' (400€)');
    expect(rentSmsAmounts(r)).toBe(rentSmsAmounts(rent()));
  });

  it('a carried share of 0 beside the month’s own charges is left out', () => {
    const r = rent({
      total: { preTaxAmount: 400, grandTotal: 440, balance: 0 },
      buildingCharges: [line(40), line(0, { forTerm: OCT })]
    });
    expect(rentSmsAmounts(r)).toBe(
      ' (Ενοίκιο: 400€, Κοινόχρ: 40€, ΣΥΝΟΛΟ: 440€)'
    );
  });
});
