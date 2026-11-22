// What a month carries in from the month before it («Προηγούμενο υπόλοιπο») must follow
// that month — also when both are already closed.
//
// The freeze of closed months (contract.ts `_isFrozen`) exists so that what a closed
// month BILLED is never re-priced. It also froze what the month CARRIES IN, which is not
// a price: it is `previous.grandTotal − previous.payment` (5_balance.ts). Three ways that
// went wrong, all measured on the running app before these tests were written:
//
//   1. A payment recorded on an older month never reached the months after it — the
//      money stayed owed on every later month, for good.
//   2. Extending a lease whose end had passed (or removing a termination) generated the
//      missing closed months as if nothing had ever been paid: every euro the tenant had
//      paid came back as «Προηγούμενο υπόλοιπο».
//   3. Moving the begin date left the months after it carrying the old chain: the debt
//      of newly added months never reached the present, and the debt of a month that no
//      longer exists stayed.
//
// The rule these tests pin: what a closed month billed stays exactly as billed; what it
// carries in is what the month before it left unpaid. Nothing is floored at zero — a
// payment above what was owed is a credit for the months after it (see
// __tests__/expressCreditCarry.test.js for why a floor would delete tenant money).
//
// Plain-import pattern, as contract-freeze-past-unpaid.test.js.
import { jest } from '@jest/globals';
import * as Contract from '../../managers/contract.js';

const term = (yyyymm) => Number(`${yyyymm}0100`);
const JAN = term(202601);
const FEB = term(202602);
const MAR = term(202603);
const APR = term(202604);
const MAY = term(202605);
const JUN = term(202606);

const at = (iso) => jest.useFakeTimers().setSystemTime(new Date(iso));

function property(begin, end, rent = 400, expenses = []) {
  return {
    propertyId: 'prop1',
    rent,
    expenses,
    entryDate: new Date(begin),
    exitDate: new Date(end),
    property: { name: 'Apt A', price: rent }
  };
}

function building(expenseAmount) {
  return {
    _id: 'building1',
    name: 'Building A',
    atakPrefix: '011172',
    units: [
      {
        _id: 'unit1',
        propertyId: 'prop1',
        atakNumber: '01234567890',
        isManaged: true,
        surface: 80,
        generalThousandths: 1000,
        heatingThousandths: 0,
        elevatorThousandths: 0,
        owners: [],
        monthlyCharges: []
      }
    ],
    expenses: [
      {
        _id: 'exp1',
        name: 'Cleaning',
        type: 'cleaning',
        amount: expenseAmount,
        allocationMethod: 'general_thousandths',
        isRecurring: true,
        startTerm: 2026010100,
        customAllocations: []
      }
    ],
    address: {},
    blockStreets: [],
    hasElevator: false,
    hasCentralHeating: false,
    contractors: [],
    repairs: []
  };
}

// A lease for the whole of 2026 at 400 a month, looked at in mid April: January to March
// are closed, April is the current month, nothing has been paid.
function leaseSeenInApril(extra = {}) {
  at('2026-04-15T12:00:00Z');
  return Contract.create({
    begin: Date.parse('2026-01-01T00:00:00Z'),
    end: Date.parse('2026-12-31T23:59:59Z'),
    frequency: 'months',
    properties: [property('2026-01-01', '2026-12-31')],
    ...extra
  });
}

const cash = (amount, date = '15/04/2026') => ({
  payments: [{ amount, type: 'cash', date, reference: '' }]
});

const rentOf = (contract, t) => contract.rents.find((r) => r.term === t);

// [carried in, total due, paid] of a month.
const row = (contract, t) => {
  const r = rentOf(contract, t);
  return [r.total.balance, r.total.grandTotal, r.total.payment];
};

// Everything a month holds EXCEPT what it carries in and the total that includes it.
function billed(rent) {
  const copy = JSON.parse(JSON.stringify(rent));
  delete copy.total.balance;
  delete copy.total.grandTotal;
  return copy;
}

// Every month from `fromTerm` on carries in exactly what the month before it left unpaid.
function expectChainFrom(contract, fromTerm) {
  const rents = contract.rents;
  for (let i = 1; i < rents.length; i++) {
    if (rents[i].term < fromTerm) continue;
    const prev = rents[i - 1];
    const leftUnpaid =
      Math.round((prev.total.grandTotal - prev.total.payment) * 100) / 100;
    expect([rents[i].term, rents[i].total.balance]).toEqual([
      rents[i].term,
      leftUnpaid
    ]);
  }
}

afterEach(() => jest.useRealTimers());

describe('a payment on an older month reaches the months after it', () => {
  test('one older month paid: every later month carries in 400 less', () => {
    const c = leaseSeenInApril();
    expect(row(c, FEB)).toEqual([400, 800, 0]);
    expect(row(c, MAR)).toEqual([800, 1200, 0]);
    expect(row(c, APR)).toEqual([1200, 1600, 0]);

    Contract.payTerm(c, String(JAN), cash(400));

    expect(row(c, JAN)).toEqual([0, 400, 400]);
    expect(row(c, FEB)).toEqual([0, 400, 0]);
    expect(row(c, MAR)).toEqual([400, 800, 0]);
    expect(row(c, APR)).toEqual([800, 1200, 0]);
    expect(row(c, MAY)).toEqual([1200, 1600, 0]);
    expectChainFrom(c, FEB);
  });

  test('each older month paid in turn: this month owes only itself', () => {
    const c = leaseSeenInApril();
    Contract.payTerm(c, String(JAN), cash(400));
    Contract.payTerm(c, String(FEB), cash(400));
    Contract.payTerm(c, String(MAR), cash(400));

    expect(row(c, FEB)).toEqual([0, 400, 400]);
    expect(row(c, MAR)).toEqual([0, 400, 400]);
    expect(row(c, APR)).toEqual([0, 400, 0]);
    expect(row(c, MAY)).toEqual([400, 800, 0]);
    expectChainFrom(c, FEB);
  });

  test('the order the older months are paid in does not matter', () => {
    const c = leaseSeenInApril();
    Contract.payTerm(c, String(MAR), cash(400));
    Contract.payTerm(c, String(FEB), cash(400));
    Contract.payTerm(c, String(JAN), cash(400));

    expect(row(c, JAN)).toEqual([0, 400, 400]);
    expect(row(c, FEB)).toEqual([0, 400, 400]);
    expect(row(c, MAR)).toEqual([0, 400, 400]);
    expect(row(c, APR)).toEqual([0, 400, 0]);
    expectChainFrom(c, FEB);
  });

  test('a part payment moves later months by exactly that part', () => {
    const c = leaseSeenInApril();
    Contract.payTerm(c, String(FEB), cash(150.55));

    expect(row(c, FEB)).toEqual([400, 800, 150.55]);
    expect(row(c, MAR)).toEqual([649.45, 1049.45, 0]);
    expect(row(c, APR)).toEqual([1049.45, 1449.45, 0]);
    expectChainFrom(c, MAR);
  });

  test('removing the payment puts the debt back on the later months', () => {
    const c = leaseSeenInApril();
    Contract.payTerm(c, String(JAN), cash(400));
    expect(row(c, APR)).toEqual([800, 1200, 0]);

    Contract.payTerm(c, String(JAN), { payments: [] });

    expect(row(c, JAN)).toEqual([0, 400, 0]);
    expect(row(c, FEB)).toEqual([400, 800, 0]);
    expect(row(c, MAR)).toEqual([800, 1200, 0]);
    expect(row(c, APR)).toEqual([1200, 1600, 0]);
  });

  test('a write-off or an extra charge on an older month moves later months by the same amount', () => {
    const c = leaseSeenInApril();
    Contract.payTerm(c, String(JAN), {
      payments: [],
      discounts: [{ origin: 'settlement', description: 'goodwill', amount: 50 }]
    });
    expect(row(c, JAN)).toEqual([0, 350, 0]);
    expect(row(c, FEB)).toEqual([350, 750, 0]);
    expect(row(c, APR)).toEqual([1150, 1550, 0]);

    Contract.payTerm(c, String(JAN), {
      payments: [],
      debts: [{ description: 'late fee', amount: 30 }]
    });
    expect(row(c, JAN)).toEqual([0, 430, 0]);
    expect(row(c, FEB)).toEqual([430, 830, 0]);
    expect(row(c, APR)).toEqual([1230, 1630, 0]);
    expectChainFrom(c, FEB);
  });

  test('more than was owed becomes a credit for the months after it', () => {
    const c = leaseSeenInApril();
    Contract.payTerm(c, String(JAN), cash(1200));

    expect(row(c, JAN)).toEqual([0, 400, 1200]);
    expect(row(c, FEB)).toEqual([-800, -400, 0]);
    expect(row(c, MAR)).toEqual([-400, 0, 0]);
    expect(row(c, APR)).toEqual([0, 400, 0]);
    expect(row(c, MAY)).toEqual([400, 800, 0]);
    expectChainFrom(c, FEB);
  });

  test('a current month already paid in full follows too, and its surplus moves on', () => {
    const c = leaseSeenInApril();
    // The tenant clears everything in April: 3 older months + April.
    Contract.payTerm(c, String(APR), cash(1600));
    expect(row(c, APR)).toEqual([1200, 1600, 1600]);
    expect(row(c, MAY)).toEqual([0, 400, 0]);
    const aprilAsBilled = billed(rentOf(c, APR));

    // January's 400 is then recorded as well — the tenant has now paid 400 too much.
    Contract.payTerm(c, String(JAN), cash(400));

    expect(row(c, FEB)).toEqual([0, 400, 0]);
    expect(row(c, MAR)).toEqual([400, 800, 0]);
    expect(row(c, APR)).toEqual([800, 1200, 1600]);
    expect(billed(rentOf(c, APR))).toEqual(aprilAsBilled);
    expect(row(c, MAY)).toEqual([-400, 0, 0]);
    expect(row(c, JUN)).toEqual([0, 400, 0]);
  });

  test('an older month recorded after the next month was already settled in full: the surplus shows as credit', () => {
    const c = leaseSeenInApril();
    // February was settled together with January's debt (800), then January's 400 is
    // recorded on January as well — a double entry, or a second real payment.
    Contract.payTerm(c, String(FEB), cash(800));
    expect(row(c, FEB)).toEqual([400, 800, 800]);
    expect(row(c, MAR)).toEqual([0, 400, 0]);

    Contract.payTerm(c, String(JAN), cash(400));

    expect(row(c, JAN)).toEqual([0, 400, 400]);
    expect(row(c, FEB)).toEqual([0, 400, 800]);
    expect(row(c, MAR)).toEqual([-400, 0, 0]);
    expect(row(c, APR)).toEqual([0, 400, 0]);
    expectChainFrom(c, FEB);
  });

  test('saving the same payment again changes nothing', () => {
    const c = leaseSeenInApril();
    Contract.payTerm(c, String(JAN), cash(400));
    const once = JSON.parse(JSON.stringify(c.rents));
    Contract.payTerm(c, String(JAN), cash(400));
    expect(JSON.parse(JSON.stringify(c.rents))).toEqual(once);
  });

  test('months before the paid month are left exactly as they were', () => {
    const c = leaseSeenInApril();
    const before = JSON.parse(JSON.stringify([rentOf(c, JAN), rentOf(c, FEB)]));
    Contract.payTerm(c, String(MAR), cash(400));
    expect(
      JSON.parse(JSON.stringify([rentOf(c, JAN), rentOf(c, FEB)]))
    ).toEqual(before);
  });

  test('a lease that has ended: the closed months after the paid one follow', () => {
    at('2026-05-15T12:00:00Z');
    const c = Contract.create({
      begin: Date.parse('2026-01-01T00:00:00Z'),
      end: Date.parse('2026-12-31T23:59:59Z'),
      termination: Date.parse('2026-03-31T12:00:00Z'),
      frequency: 'months',
      properties: [property('2026-01-01', '2026-12-31')]
    });
    expect(c.rents.map((r) => r.term)).toEqual([JAN, FEB, MAR]);
    // rentmanager._updateByTerm hands payTerm a contract without `termination`.
    delete c.termination;

    Contract.payTerm(c, String(JAN), cash(400, '15/05/2026'));

    expect(row(c, FEB)).toEqual([0, 400, 0]);
    expect(row(c, MAR)).toEqual([400, 800, 0]);
  });
});

describe('what happens next on the corrected ledger', () => {
  test('a note saved on an older month moves no amount', () => {
    const c = leaseSeenInApril();
    const before = JSON.parse(JSON.stringify(c.rents));
    Contract.payTerm(c, String(JAN), {
      payments: [],
      description: 'called the tenant'
    });

    expect(rentOf(c, JAN).description).toBe('called the tenant');
    const after = JSON.parse(JSON.stringify(c.rents));
    after[0].description = before[0].description;
    expect(after).toEqual(before);
  });

  test('then paying this month: what is asked is the corrected total, and next month starts clean', () => {
    const c = leaseSeenInApril();
    Contract.payTerm(c, String(JAN), cash(400));
    Contract.payTerm(c, String(FEB), cash(400));
    Contract.payTerm(c, String(MAR), cash(400));
    expect(row(c, APR)).toEqual([0, 400, 0]);

    Contract.payTerm(c, String(APR), cash(400));

    expect(row(c, APR)).toEqual([0, 400, 400]);
    expect(row(c, MAY)).toEqual([0, 400, 0]);
  });

  test('then a later closed month is paid: it is asked for its own bill only', () => {
    const c = leaseSeenInApril();
    Contract.payTerm(c, String(JAN), cash(400));
    // February now carries nothing in; paying its 400 settles it and March follows.
    Contract.payTerm(c, String(FEB), cash(400));

    expect(row(c, FEB)).toEqual([0, 400, 400]);
    expect(row(c, MAR)).toEqual([0, 400, 0]);
    expect(row(c, APR)).toEqual([400, 800, 0]);
  });

  test('a write-off entered gross on a VAT lease keeps every later month adding up', () => {
    at('2026-04-15T12:00:00Z');
    const c = Contract.create({
      begin: Date.parse('2026-01-01T00:00:00Z'),
      end: Date.parse('2026-12-31T23:59:59Z'),
      frequency: 'months',
      vatRate: 0.24,
      properties: [property('2026-01-01', '2026-12-31')]
    });
    expect(row(c, JAN)).toEqual([0, 496, 0]);

    // rentmanager stores a 124 gross write-off as 100 net; 4_vats adds the −24.
    Contract.payTerm(c, String(JAN), {
      payments: [
        { amount: 100, type: 'cash', date: '15/04/2026', reference: '' }
      ],
      discounts: [
        { origin: 'settlement', description: 'goodwill', amount: 100 }
      ]
    });

    expect(row(c, JAN)).toEqual([0, 372, 100]);
    expect(row(c, FEB)).toEqual([272, 768, 0]);
    expect(row(c, MAR)).toEqual([768, 1264, 0]);
    expect(row(c, APR)).toEqual([1264, 1760, 0]);
    expectChainFrom(c, FEB);
  });

  test('a legacy row without totals in the chain does not break the walk', () => {
    const c = leaseSeenInApril();
    delete rentOf(c, FEB).total;
    const marBefore = JSON.parse(JSON.stringify(rentOf(c, MAR)));

    expect(() => Contract.payTerm(c, String(JAN), cash(400))).not.toThrow();

    expect(row(c, JAN)).toEqual([0, 400, 400]);
    expect(rentOf(c, FEB).total).toBeUndefined();
    expect(JSON.parse(JSON.stringify(rentOf(c, MAR)))).toEqual(marBefore);
  });
});

describe('what the later closed months billed is not touched', () => {
  // VAT, a standing discount, a property charge and a building charge, so every kind of
  // line is on the bill; February also holds a part payment with its own note.
  function richLease() {
    at('2026-04-15T12:00:00Z');
    const c = Contract.create({
      begin: Date.parse('2026-01-01T00:00:00Z'),
      end: Date.parse('2026-12-31T23:59:59Z'),
      frequency: 'months',
      vatRate: 0.24,
      discount: 20,
      properties: [
        property('2026-01-01', '2026-12-31', 400, [
          {
            title: 'Parking',
            amount: 30,
            beginDate: '01/01/2026',
            endDate: '31/12/2026'
          }
        ])
      ],
      buildings: [building(50)]
    });
    Contract.payTerm(c, String(FEB), {
      payments: [
        {
          amount: 100,
          type: 'transfer',
          date: '15/04/2026',
          reference: 'ref-1',
          allocation: [{ category: 'rent', lineKey: 'preTax:0', amount: 100 }]
        }
      ],
      discounts: [{ origin: 'settlement', description: 'promo', amount: 10 }],
      description: 'note on February'
    });
    return c;
  }

  test('only the carry-in and the total move; every line, payment and note stays', () => {
    const c = richLease();
    const febBefore = JSON.parse(JSON.stringify(rentOf(c, FEB)));
    const marBefore = JSON.parse(JSON.stringify(rentOf(c, MAR)));
    const janOwed = rentOf(c, JAN).total.grandTotal;
    expect(febBefore.buildingCharges).toHaveLength(1);
    expect(febBefore.charges).toHaveLength(1);
    expect(febBefore.vats.length).toBeGreaterThan(0);
    expect(febBefore.payments[0].allocation).toEqual([
      { category: 'rent', lineKey: 'preTax:0', amount: 100 }
    ]);

    Contract.payTerm(c, String(JAN), cash(janOwed));

    const feb = rentOf(c, FEB);
    const mar = rentOf(c, MAR);
    expect(billed(feb)).toEqual(billed(febBefore));
    expect(billed(mar)).toEqual(billed(marBefore));
    // The carry-in fell by what January no longer owes; each month's own bill is intact.
    expect(feb.total.balance).toBe(0);
    expect(
      Math.round((feb.total.grandTotal - feb.total.balance) * 100) / 100
    ).toBe(
      Math.round((febBefore.total.grandTotal - febBefore.total.balance) * 100) /
        100
    );
    expect(
      Math.round((mar.total.grandTotal - mar.total.balance) * 100) / 100
    ).toBe(
      Math.round((marBefore.total.grandTotal - marBefore.total.balance) * 100) /
        100
    );
    expectChainFrom(c, FEB);
  });

  test('prices changed since then still do not reach the later closed months', () => {
    const c = richLease();
    const febBefore = JSON.parse(JSON.stringify(rentOf(c, FEB)));
    const marBefore = JSON.parse(JSON.stringify(rentOf(c, MAR)));
    const janOwed = rentOf(c, JAN).total.grandTotal;

    // Live state moves on: dearer building expense, dearer rent, smaller discount.
    c.buildings = [building(200)];
    c.properties = [property('2026-01-01', '2026-12-31', 450)];
    c.discount = 5;
    Contract.payTerm(c, String(JAN), cash(janOwed));

    expect(billed(rentOf(c, FEB))).toEqual(billed(febBefore));
    expect(billed(rentOf(c, MAR))).toEqual(billed(marBefore));
    expect(rentOf(c, FEB).total.balance).toBe(0);
    // April is the open month: it does take the new prices, and the corrected carry-in.
    const apr = rentOf(c, APR);
    const mar = rentOf(c, MAR);
    expect(apr.preTaxAmounts[0].amount).toBe(450);
    expect(apr.total.balance).toBe(
      Math.round((mar.total.grandTotal - mar.total.payment) * 100) / 100
    );
  });
});

describe('stored ledgers that do not add up', () => {
  // Fixtures and legacy rows can hold a carry-in that does not match the month before
  // it. A payment must change only what follows from it: the carry-in of a closed month
  // is set to what the month before it leaves unpaid — never shifted blindly by the
  // amount paid — and only where the month before it actually moved.

  test('a later month that never carried the debt is left as it is: no credit is invented, no other debt appears', () => {
    // Every month stands alone (carry-in 0) although the months before it are unpaid.
    const c = leaseSeenInApril();
    [FEB, MAR].forEach((t) => {
      const r = rentOf(c, t);
      r.total.grandTotal = 400;
      r.total.balance = 0;
    });

    Contract.payTerm(c, String(JAN), cash(400));

    // January now leaves nothing unpaid, and February already carried in nothing —
    // shifting it by the 400 paid would have handed the tenant a 400 credit.
    expect(row(c, FEB)).toEqual([0, 400, 0]);
    // February leaves what it always left, so March is not touched either.
    expect(row(c, MAR)).toEqual([0, 400, 0]);
    // The open month is recomputed from March, as it always was.
    expect(row(c, APR)).toEqual([400, 800, 0]);
  });

  test('a carry-in that was too high is put right once the month before it moves', () => {
    const c = leaseSeenInApril();
    const feb = rentOf(c, FEB);
    feb.total.balance = 900; // January left 400 — 500 too much
    feb.total.grandTotal = 1300;

    Contract.payTerm(c, String(JAN), cash(100));

    expect(row(c, JAN)).toEqual([0, 400, 100]);
    expect(row(c, FEB)).toEqual([300, 700, 0]);
    expect(row(c, MAR)).toEqual([700, 1100, 0]);
    expect(row(c, APR)).toEqual([1100, 1500, 0]);
    expectChainFrom(c, FEB);
  });

  test('sub-cent residue on a closed month is not rewritten', () => {
    const c = leaseSeenInApril();
    const mar = rentOf(c, MAR);
    mar.total.balance = 700.004;
    mar.total.grandTotal = 1100.004;

    // February goes from leaving 800 to leaving 700: March must follow, and 700 is
    // what it already holds to within half a cent.
    Contract.payTerm(c, String(FEB), cash(100));

    expect(row(c, FEB)).toEqual([400, 800, 100]);
    expect(rentOf(c, MAR).total.balance).toBe(700.004);
    expect(rentOf(c, MAR).total.grandTotal).toBe(1100.004);
  });
});

describe('months that appear or disappear when the lease dates are edited', () => {
  test('extending a lease whose end has passed does not bring back what was paid', () => {
    at('2025-01-15T12:00:00Z');
    let c = Contract.create({
      begin: Date.parse('2025-01-01T00:00:00Z'),
      end: Date.parse('2025-06-30T23:59:59Z'),
      frequency: 'months',
      properties: [property('2025-01-01', '2025-06-30')]
    });
    for (let m = 1; m <= 6; m++) {
      at(`2025-0${m}-15T12:00:00Z`);
      Contract.payTerm(c, `20250${m}0100`, cash(400, `15/0${m}/2025`));
    }
    const paidMonths = JSON.parse(JSON.stringify(c.rents));
    expect(paidMonths.map((r) => r.total.payment)).toEqual([
      400, 400, 400, 400, 400, 400
    ]);

    // November: the landlord extends the lease to June 2026.
    at('2025-11-15T12:00:00Z');
    c = Contract.update(c, {
      end: new Date('2026-06-30T23:59:59Z'),
      properties: [property('2025-01-01', '2026-06-30')]
    });

    // What was paid is exactly as it was.
    expect(JSON.parse(JSON.stringify(c.rents.slice(0, 6)))).toEqual(paidMonths);
    // July to October are closed and unpaid: 400 each, starting from nothing owed.
    expect(row(c, term(202507))).toEqual([0, 400, 0]);
    expect(row(c, term(202508))).toEqual([400, 800, 0]);
    expect(row(c, term(202509))).toEqual([800, 1200, 0]);
    expect(row(c, term(202510))).toEqual([1200, 1600, 0]);
    // November is the open month.
    expect(row(c, term(202511))).toEqual([1600, 2000, 0]);
    expect(row(c, term(202512))).toEqual([2000, 2400, 0]);
    expectChainFrom(c, term(202507));
  });

  test('removing a termination: the months in between start from what was really owed', () => {
    at('2026-03-15T12:00:00Z');
    let c = Contract.create({
      begin: Date.parse('2026-01-01T00:00:00Z'),
      end: Date.parse('2026-12-31T23:59:59Z'),
      frequency: 'months',
      properties: [property('2026-01-01', '2026-12-31')]
    });
    Contract.payTerm(c, String(JAN), cash(400, '15/03/2026'));
    Contract.payTerm(c, String(FEB), cash(400, '15/03/2026'));
    c = Contract.update(c, { termination: new Date('2026-02-28T12:00:00Z') });
    expect(c.rents.map((r) => r.term)).toEqual([JAN, FEB]);

    at('2026-05-15T12:00:00Z');
    c = Contract.update(c, { termination: undefined });

    expect(row(c, JAN)).toEqual([0, 400, 400]);
    expect(row(c, FEB)).toEqual([0, 400, 400]);
    expect(row(c, MAR)).toEqual([0, 400, 0]);
    expect(row(c, APR)).toEqual([400, 800, 0]);
    expect(row(c, MAY)).toEqual([800, 1200, 0]);
    expect(row(c, JUN)).toEqual([1200, 1600, 0]);
  });

  // March is the first month of the lease and is paid; April is the open month.
  function leaseFromMarch() {
    at('2026-04-15T12:00:00Z');
    const c = Contract.create({
      begin: Date.parse('2026-03-01T00:00:00Z'),
      end: Date.parse('2026-12-31T23:59:59Z'),
      frequency: 'months',
      properties: [property('2026-03-01', '2026-12-31')]
    });
    Contract.payTerm(c, String(MAR), cash(400));
    return c;
  }

  test('begin date moved earlier: the new unpaid months reach the months after them', () => {
    let c = leaseFromMarch();
    const marchAsBilled = billed(rentOf(c, MAR));
    expect(row(c, APR)).toEqual([0, 400, 0]);

    c = Contract.update(c, {
      begin: new Date('2026-01-01T00:00:00Z'),
      properties: [property('2026-01-01', '2026-12-31')]
    });

    expect(row(c, JAN)).toEqual([0, 400, 0]);
    expect(row(c, FEB)).toEqual([400, 800, 0]);
    // March keeps what it billed and its payment; it now carries in January + February.
    expect(row(c, MAR)).toEqual([800, 1200, 400]);
    expect(billed(rentOf(c, MAR))).toEqual(marchAsBilled);
    expect(row(c, APR)).toEqual([800, 1200, 0]);
    expect(row(c, MAY)).toEqual([1200, 1600, 0]);
  });

  test('begin date moved earlier while this month is part paid', () => {
    let c = leaseFromMarch();
    Contract.payTerm(c, String(APR), cash(100));

    c = Contract.update(c, {
      begin: new Date('2026-01-01T00:00:00Z'),
      properties: [property('2026-01-01', '2026-12-31')]
    });

    expect(row(c, MAR)).toEqual([800, 1200, 400]);
    expect(row(c, APR)).toEqual([800, 1200, 100]);
    expect(row(c, MAY)).toEqual([1100, 1500, 0]);
  });

  test('begin date moved earlier while this month is paid in full', () => {
    let c = leaseFromMarch();
    Contract.payTerm(c, String(APR), cash(400));
    const aprilAsBilled = billed(rentOf(c, APR));

    c = Contract.update(c, {
      begin: new Date('2026-01-01T00:00:00Z'),
      properties: [property('2026-01-01', '2026-12-31')]
    });

    // April keeps its lines and its payment, and now shows the 800 that came before it.
    expect(row(c, APR)).toEqual([800, 1200, 400]);
    expect(billed(rentOf(c, APR))).toEqual(aprilAsBilled);
    expect(row(c, MAY)).toEqual([800, 1200, 0]);
  });

  test('begin date moved later: the debt of a month that no longer exists goes with it', () => {
    let c = leaseSeenInApril();
    expect(row(c, FEB)).toEqual([400, 800, 0]);

    // January was never part of the lease; it is unpaid, so it may be dropped.
    c = Contract.update(c, {
      begin: new Date('2026-02-01T00:00:00Z'),
      properties: [property('2026-02-01', '2026-12-31')]
    });

    expect(c.rents[0].term).toBe(FEB);
    expect(row(c, FEB)).toEqual([0, 400, 0]);
    expect(row(c, MAR)).toEqual([400, 800, 0]);
    expect(row(c, APR)).toEqual([800, 1200, 0]);
  });

  test('an edit that adds or removes no month leaves closed months exactly as stored', () => {
    // Blast-radius guard. Building expenses, unit edits, sibling tenants and repairs all
    // recompute through Contract.update; none of them may rewrite a closed month — not
    // even one whose stored carry-in does not add up.
    const c = leaseSeenInApril();
    const feb = rentOf(c, FEB);
    feb.total.balance = 123;
    feb.total.grandTotal = 523;
    const closedBefore = JSON.parse(
      JSON.stringify([rentOf(c, JAN), rentOf(c, FEB), rentOf(c, MAR)])
    );

    const updated = Contract.update(c, {
      properties: [property('2026-01-01', '2026-12-31')],
      buildings: [building(50)]
    });

    expect(
      JSON.parse(
        JSON.stringify([
          rentOf(updated, JAN),
          rentOf(updated, FEB),
          rentOf(updated, MAR)
        ])
      )
    ).toEqual(closedBefore);
    // The open month takes the new charge and the carry-in March hands it.
    expect(rentOf(updated, APR).buildingCharges).toHaveLength(1);
    expect(row(updated, APR)).toEqual([1200, 1650, 0]);
  });

  test('…and a current month that is paid in full, exactly as stored too', () => {
    const c = leaseSeenInApril();
    Contract.payTerm(c, String(APR), cash(1600));
    const apr = rentOf(c, APR);
    apr.total.balance = 1100; // March leaves 1200
    apr.total.grandTotal = 1500;
    const aprilBefore = JSON.parse(JSON.stringify(apr));

    const updated = Contract.update(c, {
      properties: [property('2026-01-01', '2026-12-31')],
      buildings: [building(50)]
    });

    // Paid in full = closed: neither the new charge nor a re-derived carry-in reach it.
    expect(JSON.parse(JSON.stringify(rentOf(updated, APR)))).toEqual(
      aprilBefore
    );
    // May is open: new charge, and the 100 April was overpaid by.
    expect(row(updated, MAY)).toEqual([-100, 350, 0]);
  });

  test('extending a lease that is still running changes no closed month', () => {
    const c = leaseSeenInApril();
    Contract.payTerm(c, String(JAN), cash(400));
    const closedBefore = JSON.parse(
      JSON.stringify([rentOf(c, JAN), rentOf(c, FEB), rentOf(c, MAR)])
    );

    const updated = Contract.update(c, {
      end: new Date('2027-06-30T23:59:59Z'),
      properties: [property('2026-01-01', '2027-06-30')]
    });

    expect(
      JSON.parse(
        JSON.stringify([
          rentOf(updated, JAN),
          rentOf(updated, FEB),
          rentOf(updated, MAR)
        ])
      )
    ).toEqual(closedBefore);
    expect(updated.rents[updated.rents.length - 1].term).toBe(term(202706));
    expectChainFrom(updated, APR);
  });
});

describe('to the cent', () => {
  test('correcting an older payment by one cent moves every later month by exactly one cent', () => {
    const c = leaseSeenInApril();
    Contract.payTerm(c, String(JAN), cash(400));
    expect(row(c, FEB)).toEqual([0, 400, 0]);

    // The payment turns out to have been one cent short.
    Contract.payTerm(c, String(JAN), cash(399.99));

    expect(row(c, JAN)).toEqual([0, 400, 399.99]);
    expect(row(c, FEB)).toEqual([0.01, 400.01, 0]);
    expect(row(c, MAR)).toEqual([400.01, 800.01, 0]);
    expect(row(c, APR)).toEqual([800.01, 1200.01, 0]);

    // …and corrected back: the cent goes away again, everywhere.
    Contract.payTerm(c, String(JAN), cash(400));

    expect(row(c, FEB)).toEqual([0, 400, 0]);
    expect(row(c, MAR)).toEqual([400, 800, 0]);
    expect(row(c, APR)).toEqual([800, 1200, 0]);
  });

  test('amounts that do not add up cleanly in binary are stored as clean cents', () => {
    // 333.33 − 199.99 is 133.33999999999997 and 666.66 − 333.33 + 133.34 is
    // 466.66999999999996 in floating point: neither may reach the ledger.
    const c = leaseSeenInApril({
      properties: [property('2026-01-01', '2026-12-31', 333.33)]
    });
    expect(row(c, FEB)).toEqual([333.33, 666.66, 0]);

    Contract.payTerm(c, String(JAN), cash(199.99));

    expect(row(c, JAN)).toEqual([0, 333.33, 199.99]);
    expect(row(c, FEB)).toEqual([133.34, 466.67, 0]);
    expect(row(c, MAR)).toEqual([466.67, 800, 0]);
    expect(row(c, APR)).toEqual([800, 1133.33, 0]);
  });

  test('a one-cent month added in front of the lease reaches every month after it', () => {
    // The begin date moves one month earlier, and that month bills one cent (a second
    // property that was held for December only). January gets a new month before it;
    // February and March keep theirs, and must still follow — by that one cent.
    at('2026-04-15T12:00:00Z');
    const properties = [
      property('2026-01-01', '2026-12-31'),
      {
        ...property('2025-12-01', '2025-12-31', 0.01),
        propertyId: 'prop2',
        property: { name: 'Storage', price: 0.01 }
      }
    ];
    const c = Contract.create({
      begin: Date.parse('2026-01-01T00:00:00Z'),
      end: Date.parse('2026-12-31T23:59:59Z'),
      frequency: 'months',
      properties
    });
    expect(row(c, FEB)).toEqual([400, 800, 0]);

    const updated = Contract.update(c, {
      begin: Date.parse('2025-12-01T00:00:00Z'),
      properties
    });

    expect(row(updated, term(202512))).toEqual([0, 0.01, 0]);
    expect(row(updated, JAN)).toEqual([0.01, 400.01, 0]);
    expect(row(updated, FEB)).toEqual([400.01, 800.01, 0]);
    expect(row(updated, MAR)).toEqual([800.01, 1200.01, 0]);
    expect(row(updated, APR)).toEqual([1200.01, 1600.01, 0]);
  });
});

describe('rows that are damaged or old-shaped', () => {
  // None of these shapes exists on the landlord's ledgers (audited). They exist on old
  // fixtures, and the walk now WRITES to closed months, so it must not make them worse.
  const emptySettlement = {
    payments: [],
    debts: [],
    discounts: [],
    description: ''
  };

  test('totals that are not an object stop no payment and no edit, and are not written to', () => {
    const c = leaseSeenInApril();
    rentOf(c, FEB).total = 'n/a';

    expect(() => Contract.payTerm(c, String(JAN), cash(400))).not.toThrow();
    expect(row(c, JAN)).toEqual([0, 400, 400]);
    expect(rentOf(c, FEB).total).toBe('n/a');

    let updated;
    expect(() => {
      updated = Contract.update(c, {
        properties: [property('2026-01-01', '2026-12-31')]
      });
    }).not.toThrow();
    expect(rentOf(updated, FEB).total).toBe('n/a');
  });

  test.each([
    ['missing', undefined],
    ['null', null],
    ['an empty text', ''],
    ['a text that is not a number', 'n/a'],
    ['blank text', '   '],
    ['a number written the Greek way', '800,00'],
    ['hexadecimal text', '0x320'],
    ['exponent text', '8e2'],
    ['true', true],
    ['false', false],
    ['an empty list', []],
    ['a list holding a number', [800]],
    ['an object', { amount: 800 }],
    ['a date', new Date('2026-02-01T00:00:00Z')],
    ['not-a-number', NaN],
    ['infinity', Infinity],
    ['decimal text too long to be an amount', '9'.repeat(400)],
    ['negative decimal text too long to be an amount', `-${'9'.repeat(400)}.5`]
  ])(
    'a closed row whose total figure is %s is left exactly as stored',
    (_label, value) => {
      const c = leaseSeenInApril();
      if (value === undefined) delete rentOf(c, FEB).total.grandTotal;
      else rentOf(c, FEB).total.grandTotal = value;
      const febBefore = JSON.parse(JSON.stringify(rentOf(c, FEB)));

      // January goes from leaving 400 to leaving nothing: February would follow.
      Contract.payTerm(c, String(JAN), cash(400));

      expect(JSON.parse(JSON.stringify(rentOf(c, FEB)))).toEqual(febBefore);
    }
  );

  test('a total figure stored as text is a figure: the row follows, and the chain goes on through it', () => {
    const c = leaseSeenInApril();
    rentOf(c, FEB).total.grandTotal = '800';

    Contract.payTerm(c, String(JAN), cash(400));

    // Written back as a number, and March carries in what February now leaves.
    expect(row(c, FEB)).toEqual([0, 400, 0]);
    expect(row(c, MAR)).toEqual([400, 800, 0]);
    expect(row(c, APR)).toEqual([800, 1200, 0]);
  });

  test.each([
    ['decimal text too long to be an amount', '9'.repeat(400)],
    ['negative decimal text too long to be an amount', `-${'9'.repeat(400)}.5`],
    ['a date', new Date('2026-02-01T00:00:00Z')],
    ['a list holding a number', [800]],
    ['true', true],
    // Finite, so «figures» — but the arithmetic on them overflows.
    ['a number so large that cents overflow', 1e307],
    ['a negative number so large that cents overflow', -1e307],
    ['decimal text so large that cents overflow', '9'.repeat(307)]
  ])(
    'the closed months after a row whose total figure is %s are not written to either',
    (_label, value) => {
      // What such a row «leaves unpaid» cannot be known. Read with Number() it was
      // infinity, or 800, or 1 — and a recompute that changed nothing then wrote that
      // onto March as its carried balance.
      const c = leaseSeenInApril();
      rentOf(c, FEB).total.grandTotal = value;
      const febBefore = JSON.stringify(rentOf(c, FEB));
      const marBefore = JSON.parse(JSON.stringify(rentOf(c, MAR)));

      const updated = Contract.update(c, {
        properties: [property('2026-01-01', '2026-12-31')]
      });
      expect(JSON.parse(JSON.stringify(rentOf(updated, MAR)))).toEqual(
        marBefore
      );
      expect(JSON.stringify(rentOf(updated, FEB))).toBe(febBefore);

      // …nor by a payment on the month before it; the row itself stays as stored.
      Contract.payTerm(c, String(JAN), cash(400));
      expect(JSON.parse(JSON.stringify(rentOf(c, MAR)))).toEqual(marBefore);
      expect(JSON.stringify(rentOf(c, FEB))).toBe(febBefore);
    }
  );

  test.each([
    ['text that is not a number', 'n/a'],
    ['true', true],
    ['a list holding a number', [800]],
    ['a date', new Date('2026-02-01T00:00:00Z')],
    ['hexadecimal text', '0x320'],
    ['exponent text', '8e2'],
    ['a number so large that cents overflow', 1e307],
    ['decimal text so large that cents overflow', '9'.repeat(307)]
  ])(
    'the open month after a row whose total figure is %s starts from nothing',
    (_label, value) => {
      // What such a row leaves cannot be known: its total counts as nothing, for
      // every kind of such row alike. Read with Number() the open month carried in
      // 1, or 800, or a date in milliseconds; an overflow left it as rebuilt from
      // scratch (1.200 carried in).
      const c = leaseSeenInApril();
      rentOf(c, MAR).total.grandTotal = value;
      const updated = Contract.update(c, {
        properties: [property('2026-01-01', '2026-12-31')]
      });
      expect(row(updated, APR)).toEqual([0, 400, 0]);
    }
  );

  test('no closed month is ever written with something that is not a finite amount (300 damaged ledgers)', () => {
    // The closed months that FOLLOW are the ones this file's rule writes to. (In
    // payTerm an OPEN month is priced by the pipeline, businesslogic/tasks/5_balance.ts,
    // and the month a payment is recorded ON is rebuilt by _freezeBilledCharges, both
    // as they always were: neither is looked at here.)
    // Small deterministic generator: the test must fail the same way every run.
    let seed = 20261129;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
    const damage = [
      1e307,
      -1e307,
      1.7e308,
      '9'.repeat(307),
      '9'.repeat(400),
      Infinity,
      -Infinity,
      NaN,
      '',
      null,
      undefined,
      true,
      [800],
      'abc',
      '400',
      0,
      -400
    ];
    const months = [JAN, FEB, MAR];
    for (let n = 0; n < 300; n++) {
      const c = leaseSeenInApril();
      const before = new Map();
      // damage one to three figures of the closed months
      const hits = 1 + Math.floor(rnd() * 3);
      for (let h = 0; h < hits; h++) {
        const t = pick(months);
        const field = pick(['grandTotal', 'balance', 'payment']);
        rentOf(c, t).total[field] = pick(damage);
      }
      c.rents.forEach((r) =>
        before.set(r.term, [r.total.balance, r.total.grandTotal])
      );
      const check = (contract, what, paidTerm) => {
        contract.rents.forEach((r) => {
          if (!months.includes(r.term) || r.term === paidTerm) return;
          const was = before.get(r.term);
          ['balance', 'grandTotal'].forEach((field, i) => {
            const now = r.total[field];
            // either exactly what was stored, or a finite number
            if (
              !Object.is(now, was[i]) &&
              JSON.stringify(now) !== JSON.stringify(was[i])
            ) {
              expect([n, what, r.term, field, Number.isFinite(now)]).toEqual([
                n,
                what,
                r.term,
                field,
                true
              ]);
            }
          });
        });
      };
      const updated = Contract.update(c, {
        properties: [property('2026-01-01', '2026-12-31')]
      });
      check(updated, 'update');
      const paidTerm = pick(months);
      try {
        Contract.payTerm(c, String(paidTerm), cash(400));
      } catch (e) {
        // a refusal writes nothing
      }
      check(c, 'payTerm', paidTerm);
    }
  });

  test('a total figure stored as text with spaces or cents is a figure too', () => {
    const c = leaseSeenInApril();
    rentOf(c, FEB).total.grandTotal = ' 800.00 ';

    Contract.payTerm(c, String(JAN), cash(400));

    expect(row(c, FEB)).toEqual([0, 400, 0]);
    expect(rentOf(c, FEB).total.grandTotal).toBe(400);
  });

  test.each([
    ['a number written the Greek way', '400,00'],
    ['blank text', '   '],
    ['true', true],
    ['a list holding a number', [400]],
    ['a date', new Date('2026-02-01T00:00:00Z')],
    ['decimal text too long to be an amount', '9'.repeat(400)]
  ])(
    'a closed row whose carried balance is %s is left exactly as stored',
    (_label, value) => {
      // Read as «carries nothing», the 400 it really carries would be added to the
      // month's own bill a second time.
      const c = leaseSeenInApril();
      rentOf(c, FEB).total.balance = value;
      const febBefore = JSON.parse(JSON.stringify(rentOf(c, FEB)));

      Contract.payTerm(c, String(JAN), cash(100));

      expect(JSON.parse(JSON.stringify(rentOf(c, FEB)))).toEqual(febBefore);
    }
  );

  test('a carried balance stored as text is a figure', () => {
    const c = leaseSeenInApril();
    rentOf(c, FEB).total.balance = '400';

    Contract.payTerm(c, String(JAN), cash(100));

    expect(row(c, FEB)).toEqual([300, 700, 0]);
    expect(rentOf(c, FEB).total.balance).toBe(300);
  });

  test('a closed row stored without a carried balance counts as carrying nothing', () => {
    const c = leaseSeenInApril();
    const feb = rentOf(c, FEB);
    delete feb.total.balance;
    feb.total.grandTotal = 400;

    // January leaves nothing; February already carries nothing: no change at all.
    Contract.payTerm(c, String(JAN), cash(400));
    expect(rentOf(c, FEB).total.grandTotal).toBe(400);
    expect(rentOf(c, FEB).total.balance).toBeUndefined();

    // January leaves 250: February is given a carried balance, and its total follows.
    Contract.payTerm(c, String(JAN), cash(150));
    expect(row(c, FEB)).toEqual([250, 650, 0]);
  });

  test.each([
    ['no payment figure', 'payment', [1200, 1600, 0]],
    ['no total figure', 'grandTotal', [0, 400, 0]]
  ])(
    'a row with %s leaves the same for the next month whichever way it is recomputed',
    (_label, missing, expectedApril) => {
      const edited = leaseSeenInApril();
      delete rentOf(edited, MAR).total[missing];
      const paid = JSON.parse(JSON.stringify(edited));

      // An edit that recomputes the lease…
      const updated = Contract.update(edited, {
        properties: [property('2026-01-01', '2026-12-31')]
      });
      // …and a save on the open month, which goes through the pipeline (5_balance).
      Contract.payTerm(paid, String(APR), emptySettlement);

      expect(row(updated, APR)).toEqual(expectedApril);
      expect(row(paid, APR)).toEqual(expectedApril);
    }
  );

  test('after a row with no totals the open month starts from nothing, whichever way it is recomputed', () => {
    const c = leaseSeenInApril();
    [JAN, FEB, MAR].forEach((t) => Contract.payTerm(c, String(t), cash(400)));
    expect(row(c, APR)).toEqual([0, 400, 0]);
    delete rentOf(c, MAR).total;
    const paid = JSON.parse(JSON.stringify(c));

    const updated = Contract.update(c, {
      properties: [property('2026-01-01', '2026-12-31')]
    });
    Contract.payTerm(paid, String(APR), emptySettlement);

    // Keeping the figure create() computes here showed the 1.200 the tenant had paid
    // as owed again.
    expect(row(updated, APR)).toEqual([0, 400, 0]);
    expect(row(paid, APR)).toEqual([0, 400, 0]);
  });

  test('a month stored twice: an edit that adds or removes no month still rewrites nothing', () => {
    const c = leaseSeenInApril();
    Contract.payTerm(c, String(JAN), cash(400));
    const stray = JSON.parse(JSON.stringify(rentOf(c, FEB)));
    stray.total.balance = 999;
    stray.total.grandTotal = 1399;
    c.rents.splice(c.rents.indexOf(rentOf(c, FEB)) + 1, 0, stray);
    const marBefore = JSON.parse(JSON.stringify(rentOf(c, MAR)));

    const updated = Contract.update(c, {
      properties: [property('2026-01-01', '2026-12-31')],
      buildings: [building(50)]
    });

    // The copy stored last is the one that is kept, exactly as stored.
    expect(updated.rents.filter((r) => r.term === FEB)).toHaveLength(1);
    expect(row(updated, FEB)).toEqual([999, 1399, 0]);
    expect(JSON.parse(JSON.stringify(rentOf(updated, MAR)))).toEqual(marBefore);
  });

  test('the order the months are stored in does not matter', () => {
    const c = leaseSeenInApril();
    const feb = rentOf(c, FEB);
    feb.total.balance = 123;
    feb.total.grandTotal = 523;
    const closedBefore = JSON.parse(
      JSON.stringify([rentOf(c, JAN), rentOf(c, FEB), rentOf(c, MAR)])
    );
    c.rents.reverse();

    const updated = Contract.update(c, {
      properties: [property('2026-01-01', '2026-12-31')],
      buildings: [building(50)]
    });

    expect(
      JSON.parse(
        JSON.stringify([
          rentOf(updated, JAN),
          rentOf(updated, FEB),
          rentOf(updated, MAR)
        ])
      )
    ).toEqual(closedBefore);
  });
});

describe('what closes the current month is unchanged', () => {
  // The current month is closed once it is paid in full; a month with nothing left
  // to pay is NOT "paid in full" (contract.ts `_isFullyPaid`, as it always was). Two
  // consequences that existed before the carry-in started to follow, pinned here so
  // that a change to that rule is a decision and not an accident. What that rule
  // still lets through is recorded in documentation/DEFERRED_DECISIONS.md, D-11.
  const at450 = { properties: [property('2026-01-01', '2026-12-31', 450)] };

  test('a month covered by a credit alone, with no payment of its own, is open: a price change reaches it', () => {
    const c = leaseSeenInApril();
    Contract.payTerm(c, String(JAN), cash(400));
    Contract.payTerm(c, String(FEB), cash(400));
    Contract.payTerm(c, String(MAR), cash(800));
    expect(row(c, APR)).toEqual([-400, 0, 0]);

    const updated = Contract.update(c, at450);

    expect(rentOf(updated, APR).preTaxAmounts[0].amount).toBe(450);
    expect(row(updated, APR)).toEqual([-400, 50, 0]);
  });

  test('a month with nothing billed yet is open even with a payment on it: the bill can still be raised', () => {
    const c = leaseSeenInApril({
      properties: [property('2026-01-01', '2026-12-31', 0)]
    });
    Contract.payTerm(c, String(APR), cash(50));
    expect(row(c, APR)).toEqual([0, 0, 50]);

    const updated = Contract.update(c, {
      properties: [property('2026-01-01', '2026-12-31', 400)]
    });

    expect(rentOf(updated, APR).preTaxAmounts[0].amount).toBe(400);
    expect(row(updated, APR)).toEqual([0, 400, 50]);
  });

  test('a month paid in full is closed: a price change does not reach it, and applies from the next month', () => {
    const c = leaseSeenInApril();
    [JAN, FEB, MAR, APR].forEach((t) =>
      Contract.payTerm(c, String(t), cash(400))
    );
    const aprilAsBilled = billed(rentOf(c, APR));

    const updated = Contract.update(c, at450);

    expect(billed(rentOf(updated, APR))).toEqual(aprilAsBilled);
    expect(row(updated, APR)).toEqual([0, 400, 400]);
    expect(row(updated, MAY)).toEqual([0, 450, 0]);
  });
});

describe('any sequence of payments, removals, write-offs, extra charges and recomputes', () => {
  test('keeps the ledger adding up and touches nothing but the month it is saved on (120 ledgers)', () => {
    // Deterministic generator: the test must fail the same way on every run.
    let seed = 20261122;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const round2 = (n) => Math.round(n * 100) / 100;
    const pad2 = (n) => String(n).padStart(2, '0');
    let saves = 0;
    let recomputes = 0;
    let creditMonthsSeen = 0;

    for (let n = 0; n < 120; n++) {
      const months = 6 + Math.floor(rnd() * 7); // 6 to 12 months, from January 2026
      const nowMonth = 1 + Math.floor(rnd() * months);
      const rent = pick([400, 333.33, 512.5, 250]);
      const vatRate = rnd() < 0.3 ? 0.24 : undefined;
      const discount = rnd() < 0.3 ? pick([20, 33.33]) : undefined;
      const lastDay = new Date(Date.UTC(2026, months, 0))
        .toISOString()
        .slice(0, 10);
      const properties = [property('2026-01-01', lastDay, rent)];
      at(`2026-${pad2(nowMonth)}-15T12:00:00Z`);
      let c = Contract.create({
        begin: Date.parse('2026-01-01T00:00:00Z'),
        end: Date.parse(`${lastDay}T23:59:59Z`),
        frequency: 'months',
        properties,
        ...(vatRate ? { vatRate } : {}),
        ...(discount ? { discount } : {})
      });
      const terms = c.rents.map((r) => r.term);
      const currentTerm = term(`2026${pad2(nowMonth)}`);

      const check = (what, savedOn, before) => {
        // 1. every month carries in exactly what the month before it leaves unpaid
        c.rents.forEach((r, i) => {
          const expected =
            i === 0
              ? 0
              : round2(
                  c.rents[i - 1].total.grandTotal - c.rents[i - 1].total.payment
                );
          expect([what, r.term, r.total.balance]).toEqual([
            what,
            r.term,
            expected
          ]);
          if (r.total.balance < 0) creditMonthsSeen++;
        });
        // 2. everything billed minus everything paid is what the last month leaves
        const billedTotal = c.rents.reduce(
          (sum, r) => sum + (r.total.grandTotal - r.total.balance),
          0
        );
        const paidTotal = c.rents.reduce((sum, r) => sum + r.total.payment, 0);
        const last = c.rents[c.rents.length - 1];
        expect([what, round2(billedTotal - paidTotal)]).toEqual([
          what,
          round2(last.total.grandTotal - last.total.payment)
        ]);
        // 3. no month but the one saved on changed what it billed, was paid, or says
        c.rents.forEach((r, i) => {
          if (r.term === savedOn) return;
          expect([what, r.term, billed(r)]).toEqual([what, r.term, before[i]]);
        });
      };

      const steps = 6 + Math.floor(rnd() * 8);
      for (let s = 0; s < steps; s++) {
        const before = c.rents.map(billed);
        if (rnd() < 0.2) {
          // A recompute that changes nothing: what an expense or a unit edit triggers.
          const pastBefore = JSON.stringify(
            c.rents.filter((r) => r.term < currentTerm)
          );
          c = Contract.update(c, { properties });
          expect([
            n,
            s,
            JSON.stringify(c.rents.filter((r) => r.term < currentTerm))
          ]).toEqual([n, s, pastBefore]);
          check(`ledger ${n}, step ${s}, recompute`, null, before);
          recomputes++;
          continue;
        }
        // A save on a past month, on this month or on next month.
        const target = pick(terms.filter((t) => t <= currentTerm + 10000));
        const payments = [];
        for (let p = pick([0, 1, 1, 1, 2]); p > 0; p--) {
          payments.push({
            amount: pick([
              rent,
              round2(rent / 2),
              0.01,
              123.45,
              round2(rent * 3),
              1199.99
            ]),
            type: 'cash',
            date: '15/01/2026',
            reference: ''
          });
        }
        const settlement = {
          payments,
          discounts: [],
          debts: [],
          description: rnd() < 0.2 ? 'note' : ''
        };
        if (rnd() < 0.2) {
          settlement.discounts.push({
            origin: 'settlement',
            description: 'write-off',
            amount: pick([50, round2(rent), 600])
          });
        }
        if (rnd() < 0.15) {
          settlement.debts.push({
            origin: 'settlement',
            description: 'extra charge',
            amount: pick([30, 99.99])
          });
        }
        Contract.payTerm(c, String(target), settlement);
        check(`ledger ${n}, step ${s}, save on ${target}`, target, before);
        saves++;
      }
    }
    // The generator must really reach the states the rule is about.
    expect(saves).toBeGreaterThan(800);
    expect(recomputes).toBeGreaterThan(150);
    expect(creditMonthsSeen).toBeGreaterThan(300);
  });
});
