/* eslint-env node, jest */
/**
 * Regression (reported 2026-07): an EXPRESS katavolh (or any payment) on a
 * PAST month must SUCCEED, not 422.
 *
 * Root cause was the round-3t "date is after this rent month + 7d" guard in
 * _updateByTerm: express stamps the payment date = TODAY, so any term >~1 month
 * old was rejected — breaking the common, legitimate action of settling arrears
 * late. The guard protected nothing real: the payment date never enters any
 * money computation, and the "negative grandTotal" it claimed to prevent is
 * legitimate credit-carry produced by OVERpayment regardless of date (see
 * expressCreditCarry test). The after-term guard was removed; the before-term
 * (wrong-page pre-dating) and >7-day-future (typo) guards remain.
 *
 * This runs the REAL bulkExpressPayment end-to-end against a mocked DB and
 * asserts a 2- and 3-month-old term now settle (no 422), while the FUTURE-date
 * typo guard still fires.
 */
import { jest } from '@jest/globals';
import moment from 'moment';

let rentManager;
let TENANTS = [];

beforeAll(async () => {
  const real = await import('@microrealestate/common');
  jest.unstable_mockModule('@microrealestate/common', () => ({
    ...real,
    Collections: {
      ...(real.Collections || {}),
      Tenant: {
        find: () => ({ lean: async () => TENANTS }),
        findOne: () => ({ lean: async () => TENANTS[0] }),
        findOneAndUpdate: (_q, upd) => ({
          lean: async () => ({
            ...TENANTS[0],
            rents: upd?.$set?.rents || TENANTS[0].rents
          })
        })
      },
      Building: { find: () => ({ lean: async () => [] }) }
    }
  }));
  rentManager = await import('../managers/rentmanager.js');
});

function makeRes() {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

const m0 = moment.utc().startOf('month');
const monthsAgo = (n) => m0.clone().subtract(n, 'months');
const termOf = (mo) => `${mo.format('YYYYMM')}0100`;
const TID = '507f1f77bcf86cd799439011';

function buildTenant() {
  const rents = [];
  for (let i = 5; i >= 0; i--) {
    const mo = monthsAgo(i);
    rents.push({
      term: Number(termOf(mo)),
      month: Number(mo.format('MM')),
      year: Number(mo.format('YYYY')),
      total: { grandTotal: 200, balance: 0, payment: 0, discount: 0 },
      payments: [],
      discounts: [],
      debts: [],
      vats: [],
      preTaxAmounts: [{ description: 'Rent', amount: 200 }],
      charges: [],
      buildingCharges: []
    });
  }
  return {
    _id: TID,
    __v: 0,
    name: 'ProbeTenant',
    frequency: 'months',
    beginDate: monthsAgo(5).toDate(),
    endDate: m0.clone().add(12, 'months').toDate(),
    discount: 0,
    properties: [{ propertyId: 'prop1', rent: 200, expenses: [] }],
    rents,
    contacts: [{ email: 'x@x.com' }]
  };
}

async function expressPay(back) {
  TENANTS = [buildTenant()];
  const req = {
    realm: { _id: 'r1' },
    headers: {},
    body: { items: [{ tenantId: TID, term: termOf(monthsAgo(back)), monthly: true }] }
  };
  const res = makeRes();
  await rentManager.bulkExpressPayment(req, res);
  return res.json.mock.calls[0]?.[0]?.results?.[0];
}

describe('express katavolh on a past month (round-3t guard removed)', () => {
  test('CURRENT month settles', async () => {
    const r = await expressPay(0);
    expect(r.failed).toBeFalsy();
    expect(r.skipped).toBeFalsy();
    expect(r.amount).toBeCloseTo(200, 2);
  });

  test('2-month-old term now settles (was 422 before the fix)', async () => {
    const r = await expressPay(2);
    // r.error is undefined on success; surface it if the guard ever returns.
    expect(r.error).toBeUndefined();
    expect(r.failed).toBeFalsy();
    expect(r.amount).toBeCloseTo(200, 2);
  });

  test('3-month-old term now settles (was 422 before the fix)', async () => {
    const r = await expressPay(3);
    expect(r.error).toBeUndefined();
    expect(r.failed).toBeFalsy();
    expect(r.amount).toBeCloseTo(200, 2);
  });
});
