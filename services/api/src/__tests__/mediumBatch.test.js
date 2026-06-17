/* eslint-env node, jest */
/**
 * MEDIUM audit batch — server-provable findings.
 *
 *  R1-M9  bulkExpressPayment must reject a DUPLICATE tenant in the batch
 *         (two items for one tenant race on the __v guard → one valid payment
 *         dropped). Shipped dialog emits one item per tenant, so a dup is a
 *         caller bug — fail fast 422.
 *  R1-M11 emailmanager.send / sendSmsOnly must pair each tenant with its OWN
 *         term, not by the (unordered) $in result position. A reordered query
 *         result previously paired a tenant with another tenant's term.
 */
import { jest } from '@jest/globals';

let rentManager;
let emailManager;
let TENANTS = [];
const axiosCalls = [];

beforeAll(async () => {
  const real = await import('@microrealestate/common');
  jest.unstable_mockModule('@microrealestate/common', () => ({
    ...real,
    Collections: {
      ...(real.Collections || {}),
      Tenant: { find: () => ({ lean: async () => TENANTS }) },
      // send() does a double-send-guard lookup on Email; return none.
      Email: { find: () => ({ lean: async () => [] }) }
    }
  }));
  // Mock axios so _sendEmail/_sendSms capture the posted payload (term) without
  // hitting the network. The emailer responds 200 with an ok body.
  jest.unstable_mockModule('axios', () => ({
    default: {
      // _sendEmail maps response.data as an array; echo the posted record back
      // so the term pairing completes (and is observable via axiosCalls).
      post: async (url, body) => {
        axiosCalls.push({ url, body });
        return {
          status: 200,
          data: [
            {
              templateName: body?.templateName,
              recordId: body?.recordId,
              params: body?.params,
              email: 'x@x.com',
              status: 'ok'
            }
          ]
        };
      }
    }
  }));
  rentManager = await import('../managers/rentmanager.js');
  emailManager = await import('../managers/emailmanager.js');
});

function makeRes() {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  axiosCalls.length = 0;
  TENANTS = [];
});

describe('R1-M9 — bulkExpressPayment rejects a duplicate tenant', () => {
  it('throws 422 when the same tenantId appears twice in items', async () => {
    const TID = '507f1f77bcf86cd799439011';
    const req = {
      realm: { _id: 'r1' },
      headers: {},
      body: {
        items: [
          { tenantId: TID, term: '2026060100', monthly: true },
          { tenantId: TID, term: '2026060100', monthly: true } // dup
        ]
      }
    };
    await expect(
      rentManager.bulkExpressPayment(req, makeRes())
    ).rejects.toThrow(/duplicate tenant/i);
  });

  it('does NOT reject distinct tenants (control)', async () => {
    const A = '507f1f77bcf86cd799439011';
    const B = '507f1f77bcf86cd799439012';
    // Distinct tenants pass the dedup guard; they then fail later on the empty
    // mocked tenant fetch — but NOT with a "duplicate tenant" error.
    const req = {
      realm: { _id: 'r1' },
      headers: {},
      body: {
        items: [
          { tenantId: A, term: '2026060100', monthly: true },
          { tenantId: B, term: '2026060100', monthly: true }
        ]
      }
    };
    let err = null;
    try {
      await rentManager.bulkExpressPayment(req, makeRes());
    } catch (e) {
      err = e;
    }
    if (err) expect(err.message).not.toMatch(/duplicate tenant/i);
  });
});

describe('R1-M11 — emailmanager pairs each tenant with its OWN term', () => {
  it('send(): a reordered $in result still emails each tenant its own term', async () => {
    const A = '507f1f77bcf86cd799439011';
    const B = '507f1f77bcf86cd799439012';
    // Request: A→term Jan, B→term Feb. The DB returns them REVERSED (B, A) —
    // exactly what an unordered $in can do.
    TENANTS = [
      { _id: B, name: 'Bravo', contacts: [{ email: 'b@x.com' }] },
      { _id: A, name: 'Alpha', contacts: [{ email: 'a@x.com' }] }
    ];
    const req = {
      realm: { _id: 'r1', locale: 'en' },
      headers: {},
      body: {
        document: 'rentcall',
        tenantIds: [A, B],
        terms: ['2026010100', '2026020100'],
        year: '2026',
        month: '06',
        force: true
      }
    };
    // The send handler computes the per-tenant term and reports it in the
    // statusList it res.json()s (independent of whether the downstream emailer
    // POST succeeds). Capture that list and read term-per-tenant from it.
    const res = makeRes();
    let statusList = [];
    res.json.mockImplementation((x) => {
      statusList = x;
    });
    await emailManager.send(req, res);

    const byTenant = {};
    for (const s of statusList || []) {
      byTenant[String(s.tenantId)] = String(s.term);
    }
    // FAILING-FIRST (positional): with the reversed $in result, A would be
    // paired with B's term (Feb) and vice-versa. After the M11 fix each tenant
    // is paired with its OWN request term by id.
    expect(byTenant[A]).toBe('2026010100');
    expect(byTenant[B]).toBe('2026020100');
  });
});
