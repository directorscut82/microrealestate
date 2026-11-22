/* eslint-env node, jest */
/**
 * A month can carry in a CREDIT: an earlier month was paid more than it owed, and
 * since 2026-11 that surplus reaches every month after it (DEFERRED_DECISIONS D-8).
 * The server-side payment paths were written when a carried balance could only be a
 * debt.
 *
 * WHAT CHANGED — express settlement. It recorded the month's full bill although the
 * credit had already paid for part of it: a payment nobody made. It now records
 * what the month still needs, the same figure the drawer shows
 * (webapps/landlord/src/utils/expressOwed.js, creditAndCarryInTheWindows.test.js).
 *
 * WHAT DID NOT — the attribution of a payment to the month's lines. A payment saved
 * on a month is attributed to that month's lines exactly as before, credit or no
 * credit. The dashboard reads those attributions (dashboardmanager
 * `_computePaidByBucket`, and the year revenue takes VAT out of attributed payments
 * only), so letting the credit shrink the lines made the same month read
 * differently depending on whether it was paid before or after the credit arrived.
 * The second half of this file pins that.
 *
 * Runs the REAL bulkExpressPayment / updateByTerm → _updateByTerm → Contract.payTerm
 * against a mocked database, same harness as expressStaleBaseline.test.js.
 */
import { jest } from '@jest/globals';
import moment from 'moment';

let rentManager;
let TENANT;
const writes = [];

beforeAll(async () => {
  const real = await import('@microrealestate/common');
  jest.unstable_mockModule('@microrealestate/common', () => ({
    ...real,
    Collections: {
      ...(real.Collections || {}),
      Tenant: {
        find: () => ({ lean: async () => [TENANT] }),
        findOne: () => ({ lean: async () => TENANT }),
        findOneAndUpdate: (query, update) => {
          writes.push({ query, update });
          return {
            lean: async () => ({
              ...TENANT,
              rents: update?.$set?.rents || TENANT.rents
            })
          };
        }
      },
      Building: { find: () => ({ lean: async () => [] }) }
    },
    // `...real` would leave the real Service singleton in place (see the mock-factory
    // note in test-running-guide.md); same override as the suites next to this one.
    Service: { getInstance: () => ({ envConfig: { getValues: () => ({}) } }) }
  }));
  rentManager = await import('../managers/rentmanager.js');
});

beforeEach(() => {
  writes.length = 0;
});

const m0 = moment.utc().startOf('month');
const termOf = (mo) => `${mo.format('YYYYMM')}0100`;
const CURRENT = termOf(m0);
const TODAY = m0.format('DD/MM/YYYY');
const TID = '507f1f77bcf86cd799439011';

const rentLine = (key, amount) => ({ category: 'rent', lineKey: key, amount });
const previousBalance = (amount) => ({
  category: 'previousBalance',
  lineKey: 'previousBalance',
  amount
});

// A tenant at 200 a month. `previous` and `current` are the stored totals of last
// month and this month; `payments` are the payments already saved on this month.
function tenant({ previous, current, payments = [] }) {
  const months = [
    [-1, previous, []],
    [0, current, payments],
    [1, { grandTotal: 200, balance: 0, payment: 0 }, []]
  ];
  const rents = months.map(([offset, total, paid]) => {
    const mo = m0.clone().add(offset, 'months');
    return {
      term: Number(termOf(mo)),
      month: Number(mo.format('MM')),
      year: Number(mo.format('YYYY')),
      total: { discount: 0, ...total },
      payments: paid,
      discounts: [],
      debts: [],
      vats: [],
      preTaxAmounts: [{ description: 'Rent', amount: 200 }],
      charges: [],
      buildingCharges: []
    };
  });
  return {
    _id: TID,
    __v: 3,
    name: 'ProbeTenant',
    frequency: 'months',
    beginDate: m0.clone().subtract(1, 'months').toDate(),
    endDate: m0.clone().add(12, 'months').endOf('month').toDate(),
    discount: 0,
    properties: [{ propertyId: 'prop1', rent: 200, expenses: [] }],
    rents,
    contacts: [{ email: 'x@x.com' }]
  };
}

const response = () => {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
};

async function express(item = { monthly: true }) {
  const res = response();
  await rentManager.bulkExpressPayment(
    {
      realm: { _id: 'r1' },
      headers: {},
      body: { items: [{ tenantId: TID, term: CURRENT, ...item }] }
    },
    res
  );
  return res.json.mock.calls[0]?.[0]?.results?.[0];
}

async function save(payments) {
  await rentManager.updateByTerm(
    {
      realm: { _id: 'r1' },
      headers: {},
      params: { id: TID, term: CURRENT },
      body: { _id: TID, payments }
    },
    response()
  );
}

// What the last write stored on this month: [amount, allocation] per payment.
const stored = () =>
  (writes[writes.length - 1]?.update?.$set?.rents || [])
    .find((r) => r.term === Number(CURRENT))
    ?.payments.map((p) => [p.amount, p.allocation]);

const cash = (amount, extra = {}) => ({
  amount,
  date: TODAY,
  type: 'cash',
  reference: '',
  ...extra
});

describe('express settlement on a month that carries a credit', () => {
  test('records only what the month still needs', async () => {
    // Last month was paid 250 for a 200 bill: this month carries a 50 credit.
    TENANT = tenant({
      previous: { grandTotal: 200, balance: 0, payment: 250 },
      current: { grandTotal: 150, balance: -50, payment: 0 }
    });

    const result = await express();

    // It used to record the full 200.
    expect(result.amount).toBe(150);
    expect(stored()).toEqual([[150, [rentLine('preTax:0', 150)]]]);
  });

  test('a month the credit covers is skipped: nothing is recorded', async () => {
    TENANT = tenant({
      previous: { grandTotal: 200, balance: 0, payment: 400 },
      current: { grandTotal: 0, balance: -200, payment: 0 }
    });

    const result = await express();

    expect(result.skipped).toBe(true);
    expect(writes).toHaveLength(0);
  });

  test('a credit larger than the bill: skipped too, never a negative amount', async () => {
    TENANT = tenant({
      previous: { grandTotal: 200, balance: 0, payment: 700 },
      current: { grandTotal: -300, balance: -500, payment: 0 }
    });

    const result = await express();

    expect(result.skipped).toBe(true);
    expect(writes).toHaveLength(0);
  });

  test('a credit and a part payment: the rest of the month', async () => {
    TENANT = tenant({
      previous: { grandTotal: 200, balance: 0, payment: 250 },
      current: { grandTotal: 150, balance: -50, payment: 100 },
      payments: [cash(100, { allocation: [rentLine('preTax:0', 100)] })]
    });

    const result = await express();

    expect(result.amount).toBe(50);
    expect(stored()).toEqual([
      [100, [rentLine('preTax:0', 100)]],
      [50, [rentLine('preTax:0', 50)]]
    ]);
  });

  test('a carried DEBT is still offered separately from the month (unchanged)', async () => {
    const inDebt = () =>
      tenant({
        previous: { grandTotal: 200, balance: 0, payment: 0 },
        current: { grandTotal: 400, balance: 200, payment: 0 }
      });

    TENANT = inDebt();
    const both = await express({ monthly: true, previousBalance: true });
    expect(both.amount).toBe(400);
    expect(stored()).toEqual([
      [400, [rentLine('preTax:0', 200), previousBalance(200)]]
    ]);

    TENANT = inDebt();
    const monthOnly = await express({ monthly: true });
    expect(monthOnly.amount).toBe(200);
    expect(stored()).toEqual([[200, [rentLine('preTax:0', 200)]]]);

    TENANT = inDebt();
    const debtOnly = await express({ previousBalance: true });
    expect(debtOnly.amount).toBe(200);
    expect(stored()).toEqual([[200, [previousBalance(200)]]]);
  });
});

describe('the attribution of a payment does not depend on a carried credit', () => {
  test('a payment on a month the credit partly covers is attributed to the month’s line', async () => {
    TENANT = tenant({
      previous: { grandTotal: 200, balance: 0, payment: 250 },
      current: { grandTotal: 150, balance: -50, payment: 0 }
    });

    await save([cash(200)]);

    expect(stored()).toEqual([[200, [rentLine('preTax:0', 200)]]]);
  });

  test('the same payment is attributed the same whether the credit arrived before it or after it', async () => {
    // Before: the month carries nothing when its 200 is recorded.
    TENANT = tenant({
      previous: { grandTotal: 200, balance: 0, payment: 200 },
      current: { grandTotal: 200, balance: 0, payment: 0 }
    });
    await save([cash(200)]);
    const paidBeforeTheCredit = stored();

    // After: last month was paid twice, so this month is already covered.
    TENANT = tenant({
      previous: { grandTotal: 200, balance: 0, payment: 400 },
      current: { grandTotal: 0, balance: -200, payment: 0 }
    });
    await save([cash(200)]);

    expect(stored()).toEqual(paidBeforeTheCredit);
    expect(stored()).toEqual([[200, [rentLine('preTax:0', 200)]]]);
  });

  test('an explicit attribution sent by the window is stored as sent', async () => {
    TENANT = tenant({
      previous: { grandTotal: 200, balance: 0, payment: 250 },
      current: { grandTotal: 150, balance: -50, payment: 0 }
    });

    await save([cash(150, { allocation: [rentLine('preTax:0', 150)] })]);

    expect(stored()).toEqual([[150, [rentLine('preTax:0', 150)]]]);
  });
});
