import {
  billsVat,
  computeOwedLines,
  listsWholeBill,
  owedAfterSavedPayments,
  owedLinesOf
} from '../utils/paymentAllocation';
import { expressOwed } from '../utils/expressOwed';

// The payment window and the express drawer were written when a month's carried
// balance could only be a debt. Two things they could not show:
//   · a CREDIT carried in (an earlier month was overpaid): both listed the full
//     bill as owed on a month the credit already covers — and recording it
//     booked a payment nobody made;
//   · money already saved on the month whose attribution no longer fits: a
//     payment that settled a previous balance which has SINCE been paid on its
//     own month, a payment on a line a credit now covers, a payment with no
//     attribution at all. The window went on listing lines as owed although
//     the row said settled.

// A month row as the API returns it for a lease without VAT: `totalToPay` is the
// month's own bill (its lines less its discounts) plus what it carries in.
const rent = (o = {}) => {
  const row = {
    balance: 0,
    payment: 0,
    preTaxAmounts: [{ description: 'Apt A', amount: 400 }],
    charges: [],
    buildingCharges: [],
    discounts: [],
    ...o
  };
  if (row.totalToPay === undefined) {
    const sum = (list) => (list || []).reduce((t, x) => t + x.amount, 0);
    row.totalToPay =
      Math.round(
        (row.balance +
          sum(row.preTaxAmounts) +
          sum(row.charges) +
          sum(row.buildingCharges) +
          (row.extracharge || 0) -
          sum(row.discounts)) *
          100
      ) / 100;
  }
  return row;
};
const amounts = (lines) => lines.map((l) => [l.lineKey, l.amount]);

describe('owed lines of the payment window', () => {
  it('a debt carried in is its own line, first (unchanged)', () => {
    expect(amounts(computeOwedLines(rent({ balance: 250 })))).toEqual([
      ['previousBalance', 250],
      ['preTax:0', 400]
    ]);
  });

  it('a credit carried in comes off the bill: only the rest is owed', () => {
    expect(amounts(computeOwedLines(rent({ balance: -150 })))).toEqual([
      ['preTax:0', 250]
    ]);
  });

  it('a credit that covers the whole month leaves nothing owed', () => {
    expect(computeOwedLines(rent({ balance: -400 }))).toEqual([]);
    expect(computeOwedLines(rent({ balance: -900 }))).toEqual([]);
  });

  it('a credit is used in the order a payment fills the lines', () => {
    const lines = computeOwedLines(
      rent({
        balance: -420,
        buildingCharges: [
          {
            description: 'Common electricity',
            amount: 50,
            type: 'electricity_common'
          }
        ]
      })
    );
    expect(amounts(lines)).toEqual([['building:0', 30]]);
  });
});

describe('what is still owed once the payments already saved are counted', () => {
  const owed = (rentRow, payments) => amounts(owedLinesOf(rentRow, payments));
  const paid = (amount, ...allocation) => ({ amount, allocation });
  const toPreviousBalance = (amount) => ({
    category: 'previousBalance',
    lineKey: 'previousBalance',
    amount
  });
  const toRent = (amount) => ({
    category: 'rent',
    lineKey: 'preTax:0',
    amount
  });
  const withCharge = (o) =>
    rent({ charges: [{ description: 'Parking', amount: 100 }], ...o });

  it('an attribution is applied to the line it names (unchanged)', () => {
    expect(
      owed(withCharge({ balance: 250 }), [paid(300, toRent(300))])
    ).toEqual([
      ['previousBalance', 250],
      ['preTax:0', 100],
      ['charges:0', 100]
    ]);
  });

  it('a payment that settled a previous balance no longer carried counts toward the month itself', () => {
    // The month now carries nothing in: the debt was paid on its own month.
    expect(
      owed(rent({ balance: 0 }), [paid(400, toPreviousBalance(400))])
    ).toEqual([['preTax:0', 0]]);
  });

  it('only the part the previous balance cannot take counts toward the month', () => {
    // 100 is still carried in; the saved payment had settled 400 of it.
    expect(
      owed(rent({ balance: 100 }), [paid(400, toPreviousBalance(400))])
    ).toEqual([
      ['previousBalance', 0],
      ['preTax:0', 100]
    ]);
  });

  it('with the debt still fully carried, the month itself is untouched (unchanged)', () => {
    expect(
      owed(rent({ balance: 400 }), [paid(400, toPreviousBalance(400))])
    ).toEqual([
      ['previousBalance', 0],
      ['preTax:0', 400]
    ]);
  });

  it('two saved payments give the same answer in either order', () => {
    // 400 that paid the old balance and 400 for the rent, on a month that has since
    // stopped carrying the balance: rent 400 + parking 100 against 800 received.
    const first = paid(400, toPreviousBalance(400));
    const second = paid(400, toRent(400));
    const settled = [
      ['preTax:0', 0],
      ['charges:0', 0]
    ];
    expect(owed(withCharge({}), [first, second])).toEqual(settled);
    expect(owed(withCharge({}), [second, first])).toEqual(settled);
  });

  it('a credit that arrived later and a payment already on the line it covers', () => {
    // Rent 400 + parking 100; 100 was paid and attributed to the rent; then a 400
    // credit arrived. The month is settled: 500 − 400 − 100.
    expect(
      owed(withCharge({ balance: -400 }), [paid(100, toRent(100))])
    ).toEqual([['charges:0', 0]]);
    // Rent 400 + common charges 50, 400 attributed to the rent, then a 100 credit:
    // 50 in credit, nothing owed.
    expect(
      owed(
        rent({
          balance: -100,
          buildingCharges: [
            { description: 'Common', amount: 50, type: 'cleaning' }
          ]
        }),
        [paid(400, toRent(400))]
      )
    ).toEqual([
      ['preTax:0', 0],
      ['building:0', 0]
    ]);
  });

  it('an attribution to a line that no longer exists is still money received', () => {
    expect(
      owed(rent({}), [
        paid(50, {
          category: 'buildingCharge',
          lineKey: 'building:7',
          amount: 50
        })
      ])
    ).toEqual([['preTax:0', 350]]);
  });

  it('a payment that carries no attribution counts too', () => {
    // Recorded before attributions existed (or seeded as «paid» at import).
    expect(owed(rent({}), [paid(400)])).toEqual([['preTax:0', 0]]);
    expect(owed(rent({ balance: 100 }), [paid(150)])).toEqual([
      ['previousBalance', 0],
      ['preTax:0', 350]
    ]);
    expect(owed(rent({}), [{ amount: 150 }])).toEqual([['preTax:0', 250]]);
  });

  it('the part of a payment beyond its attribution counts too', () => {
    expect(owed(rent({ balance: 100 }), [paid(430, toRent(400))])).toEqual([
      ['previousBalance', 70],
      ['preTax:0', 0]
    ]);
  });

  it('money with no line of its own settles the lines in the order a payment fills them', () => {
    // Rent 400 + parking 100: the rent first, then the parking.
    expect(owed(withCharge({}), [paid(450, toPreviousBalance(450))])).toEqual([
      ['preTax:0', 0],
      ['charges:0', 50]
    ]);
  });

  it('a legacy attribution to «expenses» goes to the charges, not to the rent', () => {
    expect(
      owed(withCharge({}), [paid(60, { category: 'expenses', amount: 60 })])
    ).toEqual([
      ['preTax:0', 400],
      ['charges:0', 40]
    ]);
    expect(
      owed(rent({}), [paid(400, { category: 'rent', amount: 400 })])
    ).toEqual([['preTax:0', 0]]);
  });

  it('a legacy attribution to «rent» fills every rent line before anything else', () => {
    // Two apartments on one lease, and a previous balance in front of them.
    const twoApartments = rent({
      balance: 100,
      preTaxAmounts: [
        { description: 'Apt A', amount: 300 },
        { description: 'Apt B', amount: 200 }
      ]
    });
    expect(
      owed(twoApartments, [paid(450, { category: 'rent', amount: 450 })])
    ).toEqual([
      ['previousBalance', 100],
      ['preTax:0', 0],
      ['preTax:1', 50]
    ]);
  });

  it('copes with nothing saved, and leaves the lines it is given untouched', () => {
    const lines = computeOwedLines(rent({ balance: 250 }));
    const before = JSON.stringify(lines);
    expect(amounts(owedAfterSavedPayments(lines, undefined))).toEqual(
      amounts(lines)
    );
    expect(amounts(owedAfterSavedPayments(lines, []))).toEqual(amounts(lines));
    owedAfterSavedPayments(lines, [paid(999)]);
    expect(JSON.stringify(lines)).toBe(before);
    expect(owedAfterSavedPayments(undefined, [paid(5)])).toEqual([]);
  });

  it('always leaves exactly what the month still owes (400 random months)', () => {
    // Small deterministic generator: the test must fail the same way every run.
    let seed = 20261123;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const cents = (n) => Math.round(n * 100) / 100;
    const keys = [
      'previousBalance',
      'preTax:0',
      'charges:0',
      'building:0',
      'extracharge',
      'vat',
      'gone:9'
    ];
    for (let n = 0; n < 400; n++) {
      const row = rent({
        balance: cents(
          rnd() < 0.3 ? -rnd() * 600 : rnd() < 0.5 ? rnd() * 800 : 0
        ),
        preTaxAmounts: [
          { description: 'Apt A', amount: cents(100 + rnd() * 500) }
        ],
        charges:
          rnd() < 0.5
            ? [{ description: 'Parking', amount: cents(rnd() * 120) }]
            : [],
        buildingCharges:
          rnd() < 0.5
            ? [
                {
                  description: 'Common',
                  amount: cents(rnd() * 90),
                  type: 'cleaning'
                }
              ]
            : [],
        extracharge: rnd() < 0.3 ? cents(rnd() * 80) : 0
      });
      const payments = Array.from({ length: Math.floor(rnd() * 4) }, () => {
        const amount = cents(rnd() * 700);
        const attributed = rnd() < 0.3 ? 0 : cents(amount * rnd());
        const key = keys[Math.floor(rnd() * keys.length)];
        return {
          amount,
          allocation:
            attributed > 0
              ? [
                  rnd() < 0.5
                    ? { lineKey: key, category: 'x', amount: attributed }
                    : { category: key.split(':')[0], amount: attributed }
                ]
              : []
        };
      });
      const left = owedLinesOf(row, payments);
      const received = payments.reduce((sum, p) => sum + p.amount, 0);
      // What the ROW says is still owed — from the amounts the row was made of,
      // not from the lines under test.
      expect(cents(left.reduce((sum, l) => sum + l.amount, 0))).toBeCloseTo(
        Math.max(0, cents(row.totalToPay - received)),
        2
      );
      // Never a line the row does not have, never more on a line than it bills.
      const billed = Object.fromEntries([
        ['previousBalance', Math.max(0, row.balance)],
        ['preTax:0', row.preTaxAmounts[0].amount],
        ['charges:0', row.charges[0]?.amount],
        ['building:0', row.buildingCharges[0]?.amount],
        ['extracharge', row.extracharge]
      ]);
      left.forEach((l) => {
        expect(billed[l.lineKey]).toBeGreaterThan(0);
        expect(l.amount).toBeGreaterThanOrEqual(0);
        expect(l.amount).toBeLessThanOrEqual(billed[l.lineKey] + 0.001);
      });
    }
  });
});

// A month that bills VAT. The row the API returns says how much (`vatAmount`) but has
// no `vat` / `vats`, so the window lists no VAT line and its lines do not add up to the
// month's bill. Such a month is listed exactly as before this file existed: a saved
// attribution comes off the line it names, nothing else is counted, a carried credit is
// not taken off. The rows are what GET /rents/tenant/:id returned for a 500 € shop at
// 24 % (2026-11-22, local copy), cut down to what the window reads.
describe('a month that bills VAT is listed as it always was', () => {
  const listed = (row) => amounts(owedLinesOf(row, row.payments));
  const shop = {
    balance: 0,
    totalToPay: 620,
    payment: 0,
    vatAmount: 120,
    extracharge: 0,
    preTaxAmounts: [{ description: 'Shop', amount: 500 }],
    charges: [],
    buildingCharges: [],
    debts: [],
    payments: []
  };
  const toVat = (amount) => ({ category: 'vat', lineKey: 'vat', amount });
  const toShop = (amount) => ({
    category: 'rent',
    lineKey: 'preTax:0',
    amount
  });

  it.each([
    ['an amount', 120, true],
    ['an amount as text', '120', true],
    ['zero', 0, false],
    ['nothing', undefined, false],
    ['null', null, false],
    ['an empty text', '', false],
    ['a negative amount', -5, false],
    ['text that is not an amount', '10020x', true],
    ['not-a-number', NaN, true]
  ])('«bills VAT» when the row’s VAT is %s: %s → %s', (_what, vat, yes) => {
    expect(billsVat({ vatAmount: vat })).toBe(yes);
  });

  it('…and when the row lists its VAT itself', () => {
    expect(billsVat({ vat: 96 })).toBe(true);
    expect(billsVat({ vats: [{ amount: 0 }, { amount: 96 }] })).toBe(true);
    expect(billsVat({ vats: [{ amount: 0 }] })).toBe(false);
    expect(billsVat(undefined)).toBe(false);
  });

  it('money attributed to VAT is not taken off the rent', () => {
    // 220 saved as «VAT 120 + rent 100»: the row still owes 400, all of it rent.
    // Counting every euro spread the 120 over the rent and listed 280.
    const row = {
      ...shop,
      payment: 220,
      payments: [{ amount: 220, allocation: [toVat(120), toShop(100)] }]
    };
    expect(listed(row)).toEqual([['preTax:0', 400]]);
    expect(row.totalToPay - row.payment).toBe(400);
  });

  it('money with no attribution is not counted (as before; the row owes less than is listed)', () => {
    // 640 on a month that also has a 62 € extra charge: the server attributed «rent
    // 500 + VAT 120», the other 20 carry no attribution. The row owes 42; the window
    // lists the extra charge in full, as it did.
    const row = {
      ...shop,
      totalToPay: 682,
      payment: 640,
      extracharge: 62,
      debts: [{ description: 'key', amount: 50, origin: 'settlement' }],
      payments: [{ amount: 640, allocation: [toShop(500), toVat(120)] }]
    };
    expect(listed(row)).toEqual([
      ['preTax:0', 0],
      ['extracharge', 62]
    ]);
  });

  it('a carried credit is not taken off (as before)', () => {
    // Rent 500 + VAT 120 + extra charge 62, a credit of 600 carried in: the row owes
    // 82. Taken off the listed lines alone, the credit left nothing listed.
    const row = {
      ...shop,
      balance: -600,
      totalToPay: 82,
      extracharge: 62,
      debts: [{ description: 'key', amount: 50, origin: 'settlement' }]
    };
    expect(listed(row)).toEqual([
      ['preTax:0', 500],
      ['extracharge', 62]
    ]);
  });

  it('a payment whose line has gone is not counted (as before)', () => {
    // Rent 500 + VAT 120 + extra charge 62 − a 124 write-off = 558, paid in full by
    // a payment attributed to a previous balance the month no longer carries.
    const row = {
      ...shop,
      totalToPay: 558,
      payment: 558,
      extracharge: 62,
      promo: 124,
      debts: [{ description: 'key', amount: 50, origin: 'settlement' }],
      payments: [
        {
          amount: 558,
          allocation: [
            {
              category: 'previousBalance',
              lineKey: 'previousBalance',
              amount: 558
            }
          ]
        }
      ]
    };
    expect(listed(row)).toEqual([
      ['preTax:0', 500],
      ['extracharge', 62]
    ]);
  });

  it('once the lease no longer carries VAT, the month is an ordinary month again', () => {
    // 120 was saved as VAT; then VAT was taken off the lease and the open month was
    // recomputed to 500. The row owes 380, and every euro received counts.
    const row = {
      ...shop,
      totalToPay: 500,
      payment: 120,
      vatAmount: 0,
      payments: [{ amount: 120, allocation: [toVat(120)] }]
    };
    expect(listed(row)).toEqual([['preTax:0', 380]]);
  });

  it('an attribution is read by its key (on any month)', () => {
    // The server stores this pair as it is sent, and applies it by the key.
    const pair = [{ category: 'vat', lineKey: 'preTax:0', amount: 120 }];
    expect(
      listed({
        ...shop,
        totalToPay: 500,
        vatAmount: 0,
        payment: 120,
        payments: [{ amount: 120, allocation: pair }]
      })
    ).toEqual([['preTax:0', 380]]);
    expect(
      listed({
        ...shop,
        payment: 120,
        payments: [{ amount: 120, allocation: pair }]
      })
    ).toEqual([['preTax:0', 380]]);
  });
});

// Money can be spread over the lines only when the lines ARE the bill. The row does not
// always say when they are not: a VAT lease in a month with no rent line (the property's
// window has ended, the lease goes on) bills the VAT of an extra charge with `vatAmount`
// 0 and the extra charge shown net. The rows are what GET /rents/tenant/:id returned for
// such a lease at 24 % (2026-11-22, local copy), cut down to what the window reads.
describe('a month whose lines are not its whole bill is listed as it always was', () => {
  const listed = (row) => amounts(owedLinesOf(row, row.payments));
  // An extra charge of 62 gross on a month with no rent line: stored 50 + 12 of VAT.
  const extraChargeOnly = {
    balance: 0,
    totalToPay: 62,
    payment: 0,
    vatAmount: 0,
    extracharge: 50,
    promo: 0,
    preTaxAmounts: [],
    charges: [],
    buildingCharges: [],
    debts: [{ description: 'key', amount: 50, origin: 'settlement' }],
    discounts: [],
    payments: []
  };

  it('the row does not say «VAT», and its lines do not add up to its bill', () => {
    expect(billsVat(extraChargeOnly)).toBe(false);
    expect(listsWholeBill(extraChargeOnly)).toBe(false);
    expect(listed(extraChargeOnly)).toEqual([['extracharge', 50]]);
  });

  it('50 paid on it, attributed by the server to «VAT 12 + extra charge 38»: 12 is still listed', () => {
    // The row owes 12. Counting every euro took the 12 of VAT off the extra charge
    // as well and listed nothing.
    const row = {
      ...extraChargeOnly,
      payment: 50,
      payments: [
        {
          amount: 50,
          allocation: [
            { category: 'vat', lineKey: 'vat', amount: 12 },
            { category: 'extracharge', lineKey: 'extracharge', amount: 38 }
          ]
        }
      ]
    };
    expect(row.totalToPay - row.payment).toBe(12);
    expect(listed(row)).toEqual([['extracharge', 12]]);
  });

  it('a credit of 50 carried in is not taken off it: the extra charge stays listed', () => {
    // The row owes 12 (62 − 50). Taken off the one listed line, the credit left
    // nothing listed.
    const row = { ...extraChargeOnly, balance: -50, totalToPay: 12 };
    expect(listsWholeBill(row)).toBe(false);
    expect(listed(row)).toEqual([['extracharge', 50]]);
  });

  describe('«the lines are the whole bill»', () => {
    const whole = (o) => listsWholeBill(rent(o));

    it('an ordinary month, with a debt or a credit carried in, with a discount', () => {
      expect(whole({})).toBe(true);
      expect(whole({ balance: 250 })).toBe(true);
      expect(whole({ balance: -150 })).toBe(true);
      expect(
        whole({
          charges: [{ description: 'Parking', amount: 100 }],
          buildingCharges: [
            { description: 'Common', amount: 33.34, type: 'cleaning' }
          ],
          extracharge: 20,
          discounts: [{ description: 'Agreed', amount: 60, origin: 'contract' }]
        })
      ).toBe(true);
    });

    it('figures that arrive as text are figures', () => {
      expect(whole({ totalToPay: '400', balance: '0' })).toBe(true);
      expect(whole({ totalToPay: '250', balance: '-150' })).toBe(true);
    });

    it.each([
      ['a total that is a cent more than the lines', { totalToPay: 400.01 }],
      ['a total that is 12 more than the lines', { totalToPay: 412 }],
      ['a total that is less than the lines', { totalToPay: 380 }],
      ['no total', { totalToPay: null }],
      [
        'no total, on a month with no lines',
        { preTaxAmounts: [], totalToPay: null }
      ],
      ['a total that is an empty text', { totalToPay: '' }],
      [
        'a total that is an empty text, on a month with no lines',
        { preTaxAmounts: [], totalToPay: '' }
      ],
      ['a total that is not a number', { totalToPay: NaN }],
      ['a total that is not an amount', { totalToPay: '400 €' }],
      ['a total that is true', { totalToPay: true }],
      ['a total that is a list', { totalToPay: [400] }],
      [
        'a carried balance that is not an amount',
        { balance: 'x', totalToPay: 400 }
      ],
      [
        'a carried balance that is an empty text',
        { balance: '', totalToPay: 400 }
      ],
      [
        'a discount the row does not list',
        { discounts: undefined, totalToPay: 300 }
      ],
      [
        'a line with a negative amount, which the window does not list',
        {
          buildingCharges: [
            { description: 'Credit note', amount: -10, type: 'cleaning' }
          ]
        }
      ],
      ['a row that says it bills VAT', { vatAmount: 96, totalToPay: 496 }],
      ['a row that says it bills VAT, even if it adds up', { vatAmount: 96 }]
    ])('not with %s', (_what, o) => {
      expect(whole(o)).toBe(false);
    });

    it('no row at all', () => {
      expect(listsWholeBill(undefined)).toBe(false);
      expect(listsWholeBill(null)).toBe(false);
    });

    it('a row with no carried balance carries nothing', () => {
      expect(whole({ balance: undefined, totalToPay: 400 })).toBe(true);
      expect(whole({ balance: null, totalToPay: 400 })).toBe(true);
    });

    it('when they are not, a credit is not taken off and only attributions count', () => {
      // The same month twice: the lines add up to the bill / the bill holds 12 the
      // lines do not list.
      const payments = [
        { amount: 100, allocation: [] },
        {
          amount: 50,
          allocation: [{ category: 'rent', lineKey: 'preTax:0', amount: 50 }]
        }
      ];
      expect(amounts(owedLinesOf(rent({ balance: -100 }), payments))).toEqual([
        ['preTax:0', 150]
      ]);
      expect(
        amounts(owedLinesOf(rent({ balance: -100, totalToPay: 312 }), payments))
      ).toEqual([['preTax:0', 350]]);
    });
  });
});

describe('what the express drawer offers', () => {
  const row = (o) => ({
    totalWithoutBalanceAmount: 400,
    balance: 0,
    payment: 0,
    ...o
  });

  it('an unpaid month: its bill', () => {
    expect(expressOwed(row({}))).toEqual({ monthly: 400, carry: 0 });
  });

  it('a debt carried in is offered separately', () => {
    expect(expressOwed(row({ balance: 800 }))).toEqual({
      monthly: 400,
      carry: 800
    });
  });

  it('what is already paid settles the carried debt first, then the month', () => {
    expect(expressOwed(row({ balance: 200, payment: 250 }))).toEqual({
      monthly: 350,
      carry: 0
    });
  });

  it('a credit carried in reduces what the month still needs', () => {
    expect(expressOwed(row({ balance: -150 }))).toEqual({
      monthly: 250,
      carry: 0
    });
  });

  it('a month the credit covers is not offered at all', () => {
    expect(expressOwed(row({ balance: -400 }))).toEqual({
      monthly: 0,
      carry: 0
    });
    expect(expressOwed(row({ balance: -800 }))).toEqual({
      monthly: 0,
      carry: 0
    });
  });

  it('a credit and a part payment together', () => {
    expect(expressOwed(row({ balance: -150, payment: 100 }))).toEqual({
      monthly: 150,
      carry: 0
    });
  });

  it('a paid or overpaid month: nothing', () => {
    expect(expressOwed(row({ payment: 400 }))).toEqual({
      monthly: 0,
      carry: 0
    });
    expect(expressOwed(row({ payment: 650 }))).toEqual({
      monthly: 0,
      carry: 0
    });
  });
});
