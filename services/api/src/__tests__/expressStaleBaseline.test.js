/* eslint-env node, jest */
/**
 * «Εξόφληση» (express settlement) must not delete a payment that was saved while it was
 * working.
 *
 * bulkExpressPayment reads every tenant of the batch once, up front, and builds from that
 * copy the full list of payments it sends — and `_updateByTerm` REPLACES the stored list
 * with what it is sent. `_updateByTerm` then reads the tenant AGAIN and guards its write
 * with the version of that second read. A payment saved by another tab between the two
 * reads is therefore in neither the list (built from the first read) nor a conflict (the
 * guard uses the second): the express write went through and the other payment was gone,
 * with no error anywhere. (Money review 2026-11, finding M9.)
 *
 * The express path now hands `_updateByTerm` the version of the copy it built its list
 * from, and the write is refused (409) when the stored tenant is no longer at that
 * version — including a tenant that had NO version when it was read and has one now
 * (a document inserted outside Mongoose gains `__v` on its first save).
 *
 * Runs the REAL bulkExpressPayment → _updateByTerm → Contract.payTerm against a mocked
 * database, same harness as expressPastMonthPayment.test.js.
 */
import { jest } from '@jest/globals';
import moment from 'moment';

let rentManager;
// What the batch's up-front read returns, and what `_updateByTerm`'s own read returns.
let SNAPSHOT;
let LIVE;
const writes = [];

beforeAll(async () => {
  const real = await import('@microrealestate/common');
  jest.unstable_mockModule('@microrealestate/common', () => ({
    ...real,
    Collections: {
      ...(real.Collections || {}),
      Tenant: {
        find: () => ({ lean: async () => [SNAPSHOT] }),
        findOne: () => ({ lean: async () => LIVE }),
        findOneAndUpdate: (query, update) => {
          writes.push({ query, update });
          return {
            lean: async () => ({
              ...LIVE,
              rents: update?.$set?.rents || LIVE.rents
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
const TID = '507f1f77bcf86cd799439011';

function tenant({ version, currentMonthPayments = [] }) {
  const rents = [-1, 0, 1].map((offset) => {
    const mo = m0.clone().add(offset, 'months');
    const payments = offset === 0 ? currentMonthPayments : [];
    return {
      term: Number(termOf(mo)),
      month: Number(mo.format('MM')),
      year: Number(mo.format('YYYY')),
      total: {
        grandTotal: 200,
        balance: 0,
        payment: payments.reduce((s, p) => s + p.amount, 0),
        discount: 0
      },
      payments,
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
    ...(version === undefined ? {} : { __v: version }),
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

async function expressCurrentMonth() {
  const req = {
    realm: { _id: 'r1' },
    headers: {},
    body: { items: [{ tenantId: TID, term: CURRENT, monthly: true }] }
  };
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  await rentManager.bulkExpressPayment(req, res);
  return res.json.mock.calls[0]?.[0]?.results?.[0];
}

const paymentsWritten = () =>
  (writes[0]?.update?.$set?.rents || [])
    .find((r) => r.term === Number(CURRENT))
    ?.payments.map((p) => p.amount);

describe('express settlement and a payment saved in the meantime', () => {
  test('a payment recorded between its read and its write is not deleted: the express is refused', async () => {
    SNAPSHOT = tenant({ version: 3 });
    // Another tab saves 50 on the same month before the express write happens.
    LIVE = tenant({
      version: 4,
      currentMonthPayments: [
        {
          amount: 50,
          date: m0.format('DD/MM/YYYY'),
          type: 'cash',
          reference: 'other tab'
        }
      ]
    });

    const result = await expressCurrentMonth();

    // Before the fix this read [200]: the write went through and the 50 was gone.
    expect(paymentsWritten()).toBeUndefined();
    expect(writes).toHaveLength(0);
    expect(result.failed).toBe(true);
    expect(result.error).toMatch(
      /modified while the payment was being recorded/i
    );
  });

  test('nothing changed in between: the express is recorded, guarded by the version it read', async () => {
    SNAPSHOT = tenant({ version: 3 });
    LIVE = tenant({ version: 3 });

    const result = await expressCurrentMonth();

    expect(result.failed).toBeFalsy();
    expect(result.amount).toBeCloseTo(200, 2);
    expect(writes).toHaveLength(1);
    expect(writes[0].query.__v).toBe(3);
    expect(paymentsWritten()).toEqual([200]);
  });

  test('payments already on the month are sent again with the express one', async () => {
    const saved = [
      {
        amount: 50,
        date: m0.format('DD/MM/YYYY'),
        type: 'cash',
        reference: 'earlier'
      }
    ];
    SNAPSHOT = tenant({ version: 7, currentMonthPayments: saved });
    LIVE = tenant({ version: 7, currentMonthPayments: saved });

    const result = await expressCurrentMonth();

    expect(result.failed).toBeFalsy();
    expect(result.amount).toBeCloseTo(150, 2);
    expect(paymentsWritten()).toEqual([50, 150]);
  });

  test('a tenant document that carries no version is still settled', async () => {
    // Rows inserted outside Mongoose have no __v. Nothing was saved in between (still
    // no version), so the write proceeds exactly as before.
    SNAPSHOT = tenant({ version: undefined });
    LIVE = tenant({ version: undefined });

    const result = await expressCurrentMonth();

    expect(result.failed).toBeFalsy();
    expect(writes).toHaveLength(1);
    expect(paymentsWritten()).toEqual([200]);
  });

  test('a tenant with no version that was saved in the meantime: the express is refused', async () => {
    // The first save of such a document gives it a version. "None" against "1" is as
    // stale as 3 against 4 — comparing only when a version exists let this one through
    // and the other tab's 50 was deleted.
    SNAPSHOT = tenant({ version: undefined });
    LIVE = tenant({
      version: 1,
      currentMonthPayments: [
        {
          amount: 50,
          date: m0.format('DD/MM/YYYY'),
          type: 'cash',
          reference: 'other tab'
        }
      ]
    });

    const result = await expressCurrentMonth();

    expect(writes).toHaveLength(0);
    expect(result.failed).toBe(true);
    expect(result.error).toMatch(
      /modified while the payment was being recorded/i
    );
  });

  test('the version travels beside the payload, not inside it: nothing extra is stored', async () => {
    SNAPSHOT = tenant({ version: 3 });
    LIVE = tenant({ version: 3 });

    await expressCurrentMonth();

    // Only `rents` is written, and the write is still guarded by the stored version.
    expect(Object.keys(writes[0].update.$set)).toEqual(['rents']);
    expect(writes[0].update.$inc).toEqual({ __v: 1 });
  });
});
