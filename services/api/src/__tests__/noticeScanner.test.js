/* eslint-env node, jest */
// `type: module` package → `jest` is not a global under ESM; import it.
import { jest } from '@jest/globals';
import moment from 'moment';

// Same DI approach as leaseExpiryScanner.test.js: every scan takes injectable
// finders + a pushNotice seam, so no live mongo/network is needed while every
// branch (window matching, exclusion predicates, dedupe, resolve) is exercised.
//
// NOTE: every scan MUST be given `emailerUrl` + `mintToken`, otherwise
// _resolveDeps falls through to Service.getInstance(), which throws outside a
// bootstrapped service ("envConfig is required") and kills the whole suite.

import { createNotice, pushNotice } from '../jobs/noticeHelpers.js';
import {
  BILL_DUE_WINDOWS,
  checkBillsDue,
  checkDepositsUnreturned,
  checkHoldoverLeases,
  checkInboxTtl,
  checkUnpaidRentsMonthly,
  DEPOSIT_WINDOWS,
  HOLDOVER_WINDOWS,
  INBOX_TTL_WARN_AGE_DAYS,
  resolveResolvedConditions,
  runNoticeScans
} from '../jobs/noticeScanner.js';

// Mid-June: NOT the last day of the month (the unpaid-rents digest must stay
// silent on this date).
const FIXED_NOW = new Date('2026-06-09T12:00:00.000Z');
// The last UTC day of June 2026 (30th) — the digest's firing day.
const MONTH_END = new Date('2026-06-30T12:00:00.000Z');

function makeDeps(overrides = {}) {
  const pushed = [];
  const deps = {
    emailerUrl: 'http://test/emailer',
    mintToken: jest.fn(async () => 'test-service-token'),
    now: () => FIXED_NOW,
    pushNotice: jest.fn(async (input) => {
      pushed.push(input);
      return { created: true, telegramDelivered: true };
    }),
    ...overrides
  };
  return { deps, pushed };
}

describe('noticeHelpers', () => {
  test('createNotice returns created:false on E11000 duplicate dedupeKey, without throwing', async () => {
    const dup = Object.assign(new Error('E11000 duplicate key'), {
      code: 11000
    });
    const r = await createNotice(
      {
        realmId: 'r1',
        code: 'bill-due',
        message: 'm',
        link: '',
        dedupeKey: 'k'
      },
      { insertNotice: jest.fn(async () => Promise.reject(dup)) }
    );
    expect(r).toEqual({ created: false });
  });

  test('createNotice inserts a pending kind:notice system item', async () => {
    const inserted = [];
    const r = await createNotice(
      {
        realmId: 'r1',
        code: 'holdover-lease',
        message: 'msg',
        link: '/tenants/t1',
        dedupeKey: 'holdover:t1:20260601:7'
      },
      {
        insertNotice: jest.fn(async (doc) => inserted.push(doc)),
        now: () => FIXED_NOW
      }
    );
    expect(r).toEqual({ created: true });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      realmId: 'r1',
      source: 'system',
      status: 'pending',
      kind: 'notice',
      notice: {
        code: 'holdover-lease',
        message: 'msg',
        link: '/tenants/t1'
      },
      dedupeKey: 'holdover:t1:20260601:7'
    });
  });

  test('createNotice swallows arbitrary insert failures (never throws past the caller)', async () => {
    const r = await createNotice(
      {
        realmId: 'r1',
        code: 'bill-due',
        message: 'm',
        link: '',
        dedupeKey: 'k'
      },
      { insertNotice: jest.fn(async () => Promise.reject(new Error('boom'))) }
    );
    expect(r).toEqual({ created: false });
  });

  test('pushNotice: telegram failure still reports created:true (bell is channel of record)', async () => {
    const r = await pushNotice(
      {
        realmId: 'r1',
        code: 'bill-due',
        message: 'm',
        link: '',
        dedupeKey: 'k'
      },
      'http://test/emailer',
      async () => 'tok',
      {
        insertNotice: jest.fn(async () => ({})),
        notifyTelegram: jest.fn(async () => ({
          delivered: false,
          notConfigured: false
        }))
      }
    );
    expect(r).toEqual({ created: true, telegramDelivered: false });
  });

  test('pushNotice: a deduped re-fire does NOT re-ping telegram', async () => {
    const dup = Object.assign(new Error('E11000'), { code: 11000 });
    const telegram = jest.fn(async () => ({
      delivered: true,
      notConfigured: false
    }));
    const r = await pushNotice(
      {
        realmId: 'r1',
        code: 'bill-due',
        message: 'm',
        link: '',
        dedupeKey: 'k'
      },
      'http://test/emailer',
      async () => 'tok',
      {
        insertNotice: jest.fn(async () => Promise.reject(dup)),
        notifyTelegram: telegram
      }
    );
    expect(r).toEqual({ created: false, telegramDelivered: false });
    expect(telegram).not.toHaveBeenCalled();
  });
});

describe('checkBillsDue', () => {
  function bill({
    _id,
    daysFromNow,
    status = 'pending',
    totalAmount = 100,
    receipts
  }) {
    return {
      _id,
      realmId: 'r1',
      buildingId: 'b1',
      provider: 'deh',
      billingId: 'BID',
      totalAmount,
      status,
      receipts,
      dueDate: moment
        .utc(FIXED_NOW)
        .startOf('day')
        .add(daysFromNow, 'days')
        .toDate()
    };
  }
  const buildings = [{ _id: 'b1', name: 'ΚΤΙΡΙΟ Α' }];

  test('exports the [7,1,0,-3] windows', () => {
    expect(BILL_DUE_WINDOWS).toEqual([7, 1, 0, -3]);
  });

  test('fires on an exact window, skips a non-window day', async () => {
    const { deps, pushed } = makeDeps({
      findBills: jest.fn(async () => [
        bill({ _id: 'w7', daysFromNow: 7 }),
        bill({ _id: 'w5', daysFromNow: 5 })
      ]),
      findBuildings: jest.fn(async () => buildings)
    });
    const r = await checkBillsDue(deps);
    expect(r.created).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].dedupeKey).toBe('bill-due:w7:7');
    expect(pushed[0].code).toBe('bill-due');
    expect(pushed[0].link).toBe('/buildings/b1');
    expect(pushed[0].message).toContain('ΔΕΗ');
    expect(pushed[0].message).toContain('ΚΤΙΡΙΟ Α');
  });

  test('overdue window (-3) produces the overdue wording', async () => {
    const { deps, pushed } = makeDeps({
      findBills: jest.fn(async () => [bill({ _id: 'od', daysFromNow: -3 })]),
      findBuildings: jest.fn(async () => buildings)
    });
    await checkBillsDue(deps);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].message).toContain('έληξε πριν 3');
    expect(pushed[0].dedupeKey).toBe('bill-due:od:-3');
  });

  test('outstanding uses receipts, not face amount — a fully receipted bill is silent', async () => {
    const { deps, pushed } = makeDeps({
      findBills: jest.fn(async () => [
        bill({
          _id: 'cov',
          daysFromNow: 1,
          status: 'partial',
          totalAmount: 100,
          receipts: [{ amount: 60 }, { amount: 40 }]
        }),
        bill({
          _id: 'part',
          daysFromNow: 1,
          status: 'partial',
          totalAmount: 100,
          receipts: [{ amount: 60 }]
        })
      ]),
      findBuildings: jest.fn(async () => buildings)
    });
    const r = await checkBillsDue(deps);
    expect(r.created).toBe(1);
    expect(pushed[0].dedupeKey).toBe('bill-due:part:1');
    expect(pushed[0].message).toContain('40,00 €');
  });

  test('a missing building name renders no dangling empty parenthesis', async () => {
    const { deps, pushed } = makeDeps({
      findBills: jest.fn(async () => [bill({ _id: 'orphan', daysFromNow: 0 })]),
      // Building deleted → absent from the lookup.
      findBuildings: jest.fn(async () => [])
    });
    await checkBillsDue(deps);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].message).not.toMatch(/\(\s*\)/);
    expect(pushed[0].message).toContain('σήμερα');
  });
});

describe('checkUnpaidRentsMonthly', () => {
  // Stored-ledger shape: rents[] entries with total.{grandTotal,payment}.
  function tenantWithRent({ _id, name, grandTotal, payment }) {
    return {
      _id,
      name,
      realmId: 'r1',
      rents: [
        {
          term: 2026060100,
          total: {
            grandTotal,
            payment,
            balance: 0,
            preTaxAmount: grandTotal,
            charges: 0,
            vat: 0,
            discount: 0,
            debts: 0,
            payments: payment
          },
          payments:
            payment > 0 ? [{ amount: payment, date: '01/06/2026' }] : [],
          preTaxAmounts: [],
          charges: [],
          debts: [],
          discounts: [],
          vats: []
        }
      ]
    };
  }

  test('stays SILENT on a non-month-end day', async () => {
    const { deps, pushed } = makeDeps({
      now: () => FIXED_NOW,
      findTenants: jest.fn(async () => [
        tenantWithRent({ _id: 't1', name: 'ΑΛΦΑ', grandTotal: 500, payment: 0 })
      ])
    });
    const r = await checkUnpaidRentsMonthly(deps);
    expect(r.created).toBe(0);
    expect(pushed).toHaveLength(0);
  });

  test('one digest per realm on the last UTC day, biggest debtor first', async () => {
    const { deps, pushed } = makeDeps({
      now: () => MONTH_END,
      findTenants: jest.fn(async () => [
        tenantWithRent({
          _id: 't1',
          name: 'ΑΛΦΑ',
          grandTotal: 100,
          payment: 0
        }),
        tenantWithRent({
          _id: 't2',
          name: 'ΒΗΤΑ',
          grandTotal: 900,
          payment: 0
        }),
        // Fully paid → excluded.
        tenantWithRent({
          _id: 't3',
          name: 'ΓΑΜΑ',
          grandTotal: 300,
          payment: 300
        })
      ])
    });
    const r = await checkUnpaidRentsMonthly(deps);
    expect(r.created).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].code).toBe('unpaid-rents');
    expect(pushed[0].dedupeKey).toBe('unpaid-rents:r1:2026060100');
    expect(pushed[0].link).toBe('/rents/2026.06');
    // ΒΗΤΑ (900) must precede ΑΛΦΑ (100); ΓΑΜΑ must be absent.
    expect(pushed[0].message.indexOf('ΒΗΤΑ')).toBeLessThan(
      pushed[0].message.indexOf('ΑΛΦΑ')
    );
    expect(pushed[0].message).not.toContain('ΓΑΜΑ');
    expect(pushed[0].message).toContain(': 2 —');
  });

  test('uses the GENITIVE Greek month («Ιουνίου», not «Ιούνιος»)', async () => {
    const { deps, pushed } = makeDeps({
      now: () => MONTH_END,
      findTenants: jest.fn(async () => [
        tenantWithRent({ _id: 't1', name: 'ΑΛΦΑ', grandTotal: 500, payment: 0 })
      ])
    });
    await checkUnpaidRentsMonthly(deps);
    expect(pushed[0].message).toContain('Ιουνίου 2026');
    expect(pushed[0].message).not.toContain('Ιούνιος');
  });

  test('a rent row with total but NO payment (non-finite balance) is excluded, never "NaN,undefined €"', async () => {
    // toRentData computes newBalance = total.payment - total.grandTotal with no
    // coercion (frontdata.ts), so this legacy shape yields NaN.
    // Math.max(0, -NaN) is NaN, which passes a `<= 0` guard — the row used to
    // survive into the digest and render literally "NaN,undefined €".
    const broken = {
      _id: 'tbad',
      name: 'ΧΑΛΑΣΜΕΝΟ',
      realmId: 'r1',
      rents: [
        {
          term: 2026060100,
          total: { grandTotal: 500, balance: 0 }, // payment MISSING
          payments: [],
          preTaxAmounts: [],
          charges: [],
          debts: [],
          discounts: [],
          vats: []
        }
      ]
    };
    const { deps, pushed } = makeDeps({
      now: () => MONTH_END,
      findTenants: jest.fn(async () => [
        broken,
        tenantWithRent({
          _id: 'tok',
          name: 'ΚΑΛΟ',
          grandTotal: 300,
          payment: 0
        })
      ])
    });
    const r = await checkUnpaidRentsMonthly(deps);
    expect(r.created).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].message).toContain('ΚΑΛΟ');
    expect(pushed[0].message).not.toContain('ΧΑΛΑΣΜΕΝΟ');
    expect(pushed[0].message).not.toMatch(/NaN|undefined/);
    expect(pushed[0].message).toContain(': 1 —');
  });

  test('caps the name list at 10 and appends the remainder count', async () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      tenantWithRent({
        _id: `t${i}`,
        name: `ΕΝΟΙΚΟΣ${i}`,
        grandTotal: 100 + i,
        payment: 0
      })
    );
    const { deps, pushed } = makeDeps({
      now: () => MONTH_END,
      findTenants: jest.fn(async () => many)
    });
    await checkUnpaidRentsMonthly(deps);
    expect(pushed[0].message).toContain(': 13 —');
    expect(pushed[0].message).toContain('και άλλοι 3');
  });

  test('groups per realm — two realms produce two independent digests', async () => {
    const a = tenantWithRent({
      _id: 'a',
      name: 'ΑΛΦΑ',
      grandTotal: 100,
      payment: 0
    });
    const b = tenantWithRent({
      _id: 'b',
      name: 'ΒΗΤΑ',
      grandTotal: 200,
      payment: 0
    });
    b.realmId = 'r2';
    const { deps, pushed } = makeDeps({
      now: () => MONTH_END,
      findTenants: jest.fn(async () => [a, b])
    });
    const r = await checkUnpaidRentsMonthly(deps);
    expect(r.created).toBe(2);
    expect(pushed.map((p) => p.realmId).sort()).toEqual(['r1', 'r2']);
    // No cross-realm leakage of names.
    const byRealm = Object.fromEntries(
      pushed.map((p) => [p.realmId, p.message])
    );
    expect(byRealm.r1).toContain('ΑΛΦΑ');
    expect(byRealm.r1).not.toContain('ΒΗΤΑ');
    expect(byRealm.r2).toContain('ΒΗΤΑ');
    expect(byRealm.r2).not.toContain('ΑΛΦΑ');
  });
});

describe('checkDepositsUnreturned', () => {
  function tenant({
    _id,
    daysPast,
    guaranty = 500,
    guarantyPayback = 0,
    terminated
  }) {
    const end = moment.utc(FIXED_NOW).startOf('day').subtract(daysPast, 'days');
    return {
      _id,
      name: `ΕΝΟΙΚΟΣ ${_id}`,
      realmId: 'r1',
      guaranty,
      guarantyPayback,
      ...(terminated
        ? { terminationDate: end.toDate() }
        : { endDate: end.toDate() })
    };
  }

  test('exports the [14,30] windows', () => {
    expect(DEPOSIT_WINDOWS).toEqual([14, 30]);
  });

  test('fires at day 14 and day 30 past the end, not day 20', async () => {
    const { deps, pushed } = makeDeps({
      findTenants: jest.fn(async () => [
        tenant({ _id: 'd14', daysPast: 14 }),
        tenant({ _id: 'd20', daysPast: 20 }),
        tenant({ _id: 'd30', daysPast: 30 })
      ])
    });
    const r = await checkDepositsUnreturned(deps);
    expect(r.created).toBe(2);
    expect(pushed.map((p) => p.dedupeKey).sort()).toEqual([
      'deposit:d14:20260526:14',
      'deposit:d30:20260510:30'
    ]);
  });

  test('a fully returned deposit is silent; a partial one still fires for the remainder', async () => {
    const { deps, pushed } = makeDeps({
      findTenants: jest.fn(async () => [
        tenant({
          _id: 'back',
          daysPast: 14,
          guaranty: 500,
          guarantyPayback: 500
        }),
        tenant({
          _id: 'part',
          daysPast: 14,
          guaranty: 500,
          guarantyPayback: 200
        })
      ])
    });
    const r = await checkDepositsUnreturned(deps);
    expect(r.created).toBe(1);
    expect(pushed[0].dedupeKey).toContain('deposit:part');
    expect(pushed[0].message).toContain('300,00 €');
  });

  test('terminationDate wins over endDate for the effective end', async () => {
    const t = tenant({ _id: 'trm', daysPast: 14, terminated: true });
    // A much older endDate must NOT be the anchor.
    t.endDate = moment.utc(FIXED_NOW).subtract(200, 'days').toDate();
    const { deps, pushed } = makeDeps({
      findTenants: jest.fn(async () => [t])
    });
    const r = await checkDepositsUnreturned(deps);
    expect(r.created).toBe(1);
    expect(pushed[0].dedupeKey).toBe('deposit:trm:20260526:14');
  });
});

describe('checkHoldoverLeases', () => {
  function tenant({ _id, daysPast }) {
    return {
      _id,
      name: `ΕΝΟΙΚΟΣ ${_id}`,
      realmId: 'r1',
      endDate: moment
        .utc(FIXED_NOW)
        .startOf('day')
        .subtract(daysPast, 'days')
        .toDate()
    };
  }

  test('exports the [7,30] windows', () => {
    expect(HOLDOVER_WINDOWS).toEqual([7, 30]);
  });

  test('fires at day 7 and day 30 past expiry, not day 8', async () => {
    const { deps, pushed } = makeDeps({
      findTenants: jest.fn(async () => [
        tenant({ _id: 'h7', daysPast: 7 }),
        tenant({ _id: 'h8', daysPast: 8 }),
        tenant({ _id: 'h30', daysPast: 30 })
      ])
    });
    const r = await checkHoldoverLeases(deps);
    expect(r.created).toBe(2);
    expect(pushed.map((p) => p.code)).toEqual([
      'holdover-lease',
      'holdover-lease'
    ]);
    expect(pushed.map((p) => p.dedupeKey).sort()).toEqual([
      'holdover:h30:20260510:30',
      'holdover:h7:20260602:7'
    ]);
  });
});

describe('checkInboxTtl', () => {
  test('a 25-day-old pending bill fires; the filter excludes notices and non-pending', async () => {
    let capturedFilter = null;
    const { deps, pushed } = makeDeps({
      findInboxItems: jest.fn(async (f) => {
        capturedFilter = f;
        return [
          {
            _id: 'old',
            realmId: 'r1',
            status: 'pending',
            kind: 'bill',
            createdDate: moment.utc(FIXED_NOW).subtract(26, 'days').toDate()
          },
          {
            _id: 'legacy',
            realmId: 'r1',
            status: 'pending',
            createdDate: moment.utc(FIXED_NOW).subtract(27, 'days').toDate()
          }
        ];
      })
    });
    const r = await checkInboxTtl(deps);
    expect(INBOX_TTL_WARN_AGE_DAYS).toBe(25);
    expect(r.created).toBe(2);
    expect(pushed.map((p) => p.dedupeKey).sort()).toEqual([
      'inbox-ttl:legacy',
      'inbox-ttl:old'
    ]);
    // The query must never match kind:'notice' (a notice about notices).
    expect(capturedFilter.status).toBe('pending');
    expect(JSON.stringify(capturedFilter.$or)).toContain('bill');
    expect(JSON.stringify(capturedFilter.$or)).not.toContain('notice');
  });
});

describe('resolveResolvedConditions', () => {
  // A pending notice must NOT outlive its condition: each condition fires at
  // several windows, so paying a bill on day 2 previously left the day-1 and
  // day-0 notices still claiming money was owed (and counted in the badge).
  function notice({ _id, code, key }) {
    return {
      _id,
      realmId: 'r1',
      kind: 'notice',
      status: 'pending',
      dedupeKey: key,
      notice: { code, message: 'm', link: '' }
    };
  }

  test('a fully-receipted bill resolves EVERY window notice it produced', async () => {
    const resolved = [];
    const r = await resolveResolvedConditions({
      now: () => FIXED_NOW,
      findInboxItems: jest.fn(async () => [
        notice({ _id: 'n7', code: 'bill-due', key: 'bill-due:B1:7' }),
        notice({ _id: 'n1', code: 'bill-due', key: 'bill-due:B1:1' }),
        notice({ _id: 'nx', code: 'bill-due', key: 'bill-due:B2:7' })
      ]),
      findBills: jest.fn(async () => [
        { _id: 'B1', totalAmount: 100, receipts: [{ amount: 100 }] },
        { _id: 'B2', totalAmount: 100, receipts: [{ amount: 20 }] }
      ]),
      resolveNotices: jest.fn(async (ids) => resolved.push(...ids))
    });
    expect(r.resolved).toBe(2);
    expect(resolved.sort()).toEqual(['n1', 'n7']);
  });

  test('a deleted bill resolves its notices (no orphan claiming money)', async () => {
    const resolved = [];
    const r = await resolveResolvedConditions({
      now: () => FIXED_NOW,
      findInboxItems: jest.fn(async () => [
        notice({ _id: 'gone', code: 'bill-due', key: 'bill-due:BX:0' })
      ]),
      findBills: jest.fn(async () => []),
      resolveNotices: jest.fn(async (ids) => resolved.push(...ids))
    });
    expect(r.resolved).toBe(1);
    expect(resolved).toEqual(['gone']);
  });

  test('a returned deposit resolves; a still-held one does not', async () => {
    const resolved = [];
    const r = await resolveResolvedConditions({
      now: () => FIXED_NOW,
      findInboxItems: jest.fn(async () => [
        notice({
          _id: 'back',
          code: 'deposit-unreturned',
          key: 'deposit:T1:20260501:14'
        }),
        notice({
          _id: 'held',
          code: 'deposit-unreturned',
          key: 'deposit:T2:20260501:14'
        })
      ]),
      findTenants: jest.fn(async () => [
        { _id: 'T1', guaranty: 500, guarantyPayback: 500 },
        { _id: 'T2', guaranty: 500, guarantyPayback: 100 }
      ]),
      resolveNotices: jest.fn(async (ids) => resolved.push(...ids))
    });
    expect(r.resolved).toBe(1);
    expect(resolved).toEqual(['back']);
  });

  test('a holdover lease resolves once terminated OR extended past today', async () => {
    const resolved = [];
    const r = await resolveResolvedConditions({
      now: () => FIXED_NOW,
      findInboxItems: jest.fn(async () => [
        notice({
          _id: 'term',
          code: 'holdover-lease',
          key: 'holdover:T1:20260601:7'
        }),
        notice({
          _id: 'ext',
          code: 'holdover-lease',
          key: 'holdover:T2:20260601:7'
        }),
        notice({
          _id: 'still',
          code: 'holdover-lease',
          key: 'holdover:T3:20260601:7'
        })
      ]),
      findTenants: jest.fn(async () => [
        {
          _id: 'T1',
          terminationDate: moment.utc(FIXED_NOW).subtract(1, 'day').toDate()
        },
        { _id: 'T2', endDate: moment.utc(FIXED_NOW).add(90, 'days').toDate() },
        {
          _id: 'T3',
          endDate: moment.utc(FIXED_NOW).subtract(7, 'days').toDate()
        }
      ]),
      resolveNotices: jest.fn(async (ids) => resolved.push(...ids))
    });
    expect(r.resolved).toBe(2);
    expect(resolved.sort()).toEqual(['ext', 'term']);
  });

  test('resolution FREES the dedupeKey so a returning condition can re-notify', async () => {
    // A user-dismissed notice keeps its key ("stop telling me"). An
    // AUTO-resolved one must not: a bill's receipt can be reversed by a
    // corrective re-import, and with the key retained createNotice would hit
    // E11000, report created:false, and the money would be silently invisible.
    // Drive the REAL default resolver by intercepting the collection call, so
    // the assertion is on the update document itself — passing only the ids to
    // a stub would not have caught the retained key.
    const calls = [];
    const { Collections } = await import('@microrealestate/common');
    const orig = Collections.InboxItem.updateMany;
    Collections.InboxItem.updateMany = async (filter, update) => {
      calls.push({ filter, update });
      return { modifiedCount: 1 };
    };
    try {
      await resolveResolvedConditions({
        now: () => FIXED_NOW,
        findInboxItems: jest.fn(async () => [
          notice({ _id: 'n', code: 'bill-due', key: 'bill-due:B1:7' })
        ]),
        findBills: jest.fn(async () => [
          { _id: 'B1', totalAmount: 100, receipts: [{ amount: 100 }] }
        ])
        // NO resolveNotices override — exercise the production path.
      });
    } finally {
      Collections.InboxItem.updateMany = orig;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].filter).toEqual({ _id: { $in: ['n'] } });
    expect(calls[0].update.$set.status).toBe('dismissed');
    expect(calls[0].update.$set.autoResolved).toBe(true);
    // The load-bearing assertion: the key is RENAMED away, not kept.
    expect(calls[0].update.$rename).toEqual({ dedupeKey: 'resolvedKey' });
    expect(calls[0].update.$set.dedupeKey).toBeUndefined();
  });

  test('nothing pending → no update call at all', async () => {
    const resolveNotices = jest.fn();
    const r = await resolveResolvedConditions({
      now: () => FIXED_NOW,
      findInboxItems: jest.fn(async () => []),
      resolveNotices
    });
    expect(r.resolved).toBe(0);
    expect(resolveNotices).not.toHaveBeenCalled();
  });
});

describe('runNoticeScans', () => {
  test('one failing scan does not silence the rest', async () => {
    const { deps, pushed } = makeDeps({
      findBills: jest.fn(async () => {
        throw new Error('bills query exploded');
      }),
      findTenants: jest.fn(async () => []),
      findInboxItems: jest.fn(async () => [
        {
          _id: 'old',
          realmId: 'r1',
          status: 'pending',
          kind: 'bill',
          createdDate: moment.utc(FIXED_NOW).subtract(26, 'days').toDate()
        }
      ])
    });
    const r = await runNoticeScans(deps);
    expect(r.billsDue.errors).toBeGreaterThan(0);
    expect(r.inboxTtl.created).toBe(1);
    expect(pushed.length).toBeGreaterThanOrEqual(1);
  });
});
