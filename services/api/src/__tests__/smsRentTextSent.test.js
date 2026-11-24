/* eslint-env node, jest */
/**
 * The rent SMS as it leaves the api: what `POST /emails/sms` hands to the SMS door for a
 * tenant whose rent of the month carries a share of an older month.
 *
 * smsRentText.test.js asks the function that builds the amounts; this file asks that the
 * handler uses it, on the rent of the month that was asked for.
 */
import { jest } from '@jest/globals';

let emailManager;
let TENANTS = [];
const posted = [];

const OCT = 2026100100;
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

beforeAll(async () => {
  const real = await import('@microrealestate/common');
  jest.unstable_mockModule('@microrealestate/common', () => ({
    ...real,
    Collections: {
      ...(real.Collections || {}),
      Tenant: { find: () => ({ lean: async () => TENANTS }) },
      Email: { find: () => ({ lean: async () => [] }) }
    },
    // `...real` would leave the real Service singleton, which throws outside a booted
    // service (see mediumBatch.test.js).
    Service: {
      getInstance: () => ({
        envConfig: { getValues: () => ({ EMAILER_URL: 'http://emailer' }) }
      })
    }
  }));
  jest.unstable_mockModule('axios', () => ({
    default: {
      post: async (url, body) => {
        posted.push({ url, body });
        return { status: 200, data: { id: 'sms-1' } };
      }
    }
  }));
  emailManager = await import('../managers/emailmanager.js');
});

beforeEach(() => {
  posted.length = 0;
  TENANTS = [];
});

const res = () => {
  const r = { json: jest.fn(), status: jest.fn() };
  r.status.mockReturnValue(r);
  return r;
};
const smsFor = async (body) => {
  await emailManager.sendSmsOnly(
    { realm: { _id: 'r1', locale: 'el' }, headers: {}, body },
    res()
  );
  return posted
    .filter((p) => p.url === 'http://emailer/sms')
    .map((p) => p.body);
};

/** October: rent and its own power. November: the same, plus October's late bill. */
const tenant = () => ({
  _id: '507f1f77bcf86cd799439011',
  name: 'ΔΟΚΙΜΗ ΑΛΦΑ',
  phone: '6900000000',
  rents: [
    {
      term: OCT,
      total: { preTaxAmount: 400, grandTotal: 440, balance: 0 },
      buildingCharges: [line(40)]
    },
    {
      term: NOV,
      total: { preTaxAmount: 400, grandTotal: 470, balance: 0 },
      buildingCharges: [line(40), line(30, { forTerm: OCT })]
    }
  ]
});

describe('the rent SMS as it is handed to the SMS door', () => {
  it('names the older month of a share that was billed late', async () => {
    TENANTS = [tenant()];
    const sent = await smsFor({
      tenantIds: [TENANTS[0]._id],
      year: 2026,
      month: 11,
      document: 'rentcall'
    });
    expect(sent).toEqual([
      {
        phoneNumber: '6900000000',
        text: 'Ειδοποίηση πληρωμής 11/2026 - ΔΟΚΙΜΗ ΑΛΦΑ (Ενοίκιο: 400€, Κοινόχρ: 40€, Κοινόχρ 10/2026: 30€, ΣΥΝΟΛΟ: 470€)'
      }
    ]);
  });

  it('for the month before, which carries nothing, it reads as it always did', async () => {
    TENANTS = [tenant()];
    const sent = await smsFor({
      tenantIds: [TENANTS[0]._id],
      year: 2026,
      month: 10,
      document: 'rentcall'
    });
    expect(sent.map((s) => s.text)).toEqual([
      'Ειδοποίηση πληρωμής 10/2026 - ΔΟΚΙΜΗ ΑΛΦΑ (Ενοίκιο: 400€, Κοινόχρ: 40€, ΣΥΝΟΛΟ: 440€)'
    ]);
  });

  it('a month the tenant has no rent for carries no amounts at all', async () => {
    TENANTS = [tenant()];
    const sent = await smsFor({
      tenantIds: [TENANTS[0]._id],
      year: 2026,
      month: 12,
      document: 'rentcall'
    });
    expect(sent.map((s) => s.text)).toEqual([
      'Ειδοποίηση πληρωμής 12/2026 - ΔΟΚΙΜΗ ΑΛΦΑ'
    ]);
  });

  it('the receipt SMS names no amounts, as before', async () => {
    TENANTS = [tenant()];
    const sent = await smsFor({
      tenantIds: [TENANTS[0]._id],
      year: 2026,
      month: 11,
      document: 'invoice'
    });
    expect(sent.map((s) => s.text)).toEqual([
      'Απόδειξη πληρωμής 11/2026 - ΔΟΚΙΜΗ ΑΛΦΑ'
    ]);
  });
});
