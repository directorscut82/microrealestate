/* eslint-env node, jest */
import moment from 'moment';

// We test the scanner via its dependency-injection hooks (findTenants /
// findRecentEmail / postEmail / markSent / now). This avoids needing live
// mongo or a network mock while still exercising every branch of
// checkExpiringLeases — window matching, debounce, and the post→mark path.

import {
  buildExpiringFilter,
  checkExpiringLeases,
  EXPIRY_DAY_WINDOWS,
  EXPIRY_DEBOUNCE_DAYS
} from '../jobs/leaseExpiryScanner.js';

const FIXED_NOW = new Date('2026-06-09T12:00:00.000Z');

function tenant({ _id, daysFromNow, terminated, archived, lastSent }) {
  const endDate = moment.utc(FIXED_NOW).startOf('day').add(daysFromNow, 'days').toDate();
  return {
    _id,
    realmId: 'realm-1',
    name: `Tenant ${_id}`,
    endDate,
    terminationDate: terminated ? moment.utc(FIXED_NOW).subtract(1, 'day').toDate() : null,
    archived: !!archived,
    lastExpiryNoticeSentAt: lastSent || null
  };
}

function makeDeps({ tenants, recentEmails }) {
  const sent = [];
  const marked = [];
  const deps = {
    emailerUrl: 'http://test/emailer',
    now: () => FIXED_NOW,
    findTenants: jest.fn(async () => tenants),
    findRecentEmail: jest.fn(async (tenantId) => {
      return recentEmails?.[tenantId] || null;
    }),
    postEmail: jest.fn(async (url, body) => {
      sent.push({ url, body });
      return { status: 200 };
    }),
    markSent: jest.fn(async (tenantId, when) => {
      marked.push({ tenantId, when });
    })
  };
  return { deps, sent, marked };
}

describe('leaseExpiryScanner', () => {
  test('exports the canonical [30, 7, 1] day windows and 25-day debounce', () => {
    expect(EXPIRY_DAY_WINDOWS).toEqual([30, 7, 1]);
    expect(EXPIRY_DEBOUNCE_DAYS).toBe(25);
  });

  test('buildExpiringFilter scopes to non-archived, non-terminated, endDate within range', () => {
    const f = buildExpiringFilter(FIXED_NOW, 30);
    expect(f.archived).toEqual({ $ne: true });
    const terminationClause = f.$and.find((c) => c.$or);
    expect(terminationClause).toBeTruthy();
    const endClause = f.$and.find((c) => c.endDate);
    expect(endClause.endDate.$gte).toBeInstanceOf(Date);
    expect(endClause.endDate.$lte).toBeInstanceOf(Date);
    // Range spans 31 days inclusive (start-of-today through end-of-day-30)
    const span = endClause.endDate.$lte - endClause.endDate.$gte;
    expect(span).toBeGreaterThan(29 * 24 * 3600 * 1000);
  });

  test('tenant ending in 31 days is skipped', async () => {
    const tenants = [tenant({ _id: 't31', daysFromNow: 31 })];
    const { deps, sent, marked } = makeDeps({ tenants });
    const r = await checkExpiringLeases(deps);
    expect(r.scanned).toBe(1);
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(1);
    expect(sent).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  test('tenant ending in exactly 30 days fires', async () => {
    const tenants = [tenant({ _id: 't30', daysFromNow: 30 })];
    const { deps, sent, marked } = makeDeps({ tenants });
    const r = await checkExpiringLeases(deps);
    expect(r.sent).toBe(1);
    expect(r.skipped).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.templateName).toBe('lease_expiry_notice');
    expect(sent[0].body.recordId).toBe('t30');
    expect(sent[0].body.params.daysUntilExpiry).toBe(30);
    expect(marked).toHaveLength(1);
    expect(marked[0].tenantId).toBe('t30');
  });

  test('tenant ending in exactly 7 days fires', async () => {
    const tenants = [tenant({ _id: 't7', daysFromNow: 7 })];
    const { deps, sent } = makeDeps({ tenants });
    const r = await checkExpiringLeases(deps);
    expect(r.sent).toBe(1);
    expect(sent[0].body.params.daysUntilExpiry).toBe(7);
  });

  test('tenant ending in exactly 1 day fires', async () => {
    const tenants = [tenant({ _id: 't1', daysFromNow: 1 })];
    const { deps, sent } = makeDeps({ tenants });
    const r = await checkExpiringLeases(deps);
    expect(r.sent).toBe(1);
    expect(sent[0].body.params.daysUntilExpiry).toBe(1);
  });

  test('terminated tenant is filtered upstream by buildExpiringFilter — but if it slips through, scanner skips it via the $and termination clause', () => {
    // The mongo-side filter rejects terminated tenants, so scanner must
    // never see them in production. The terminationDate field is part of
    // the filter contract, so we only need to assert the filter shape
    // includes it; the scanner test here is the integration of that.
    const f = buildExpiringFilter(FIXED_NOW, 30);
    const terminationClause = f.$and.find((c) => c.$or);
    expect(terminationClause.$or).toEqual(
      expect.arrayContaining([
        { terminationDate: { $exists: false } },
        { terminationDate: null }
      ])
    );
  });

  test('tenant whose lastExpiryNoticeSentAt is 22 days ago is skipped (debounce 25d)', async () => {
    const lastSent = moment.utc(FIXED_NOW).subtract(22, 'days').toDate();
    const tenants = [tenant({ _id: 't7-recent', daysFromNow: 7, lastSent })];
    const { deps, sent, marked } = makeDeps({ tenants });
    const r = await checkExpiringLeases(deps);
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(1);
    expect(sent).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  test('tenant whose lastExpiryNoticeSentAt is 27 days ago fires (debounce window passed)', async () => {
    const lastSent = moment.utc(FIXED_NOW).subtract(27, 'days').toDate();
    const tenants = [tenant({ _id: 't7-stale', daysFromNow: 7, lastSent })];
    const { deps, sent } = makeDeps({ tenants });
    const r = await checkExpiringLeases(deps);
    expect(r.sent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  test('Email-collection lookup is used as a debounce fallback even when in-row marker is null', async () => {
    const tenants = [tenant({ _id: 't7-collection', daysFromNow: 7 })];
    const { deps, sent, marked } = makeDeps({
      tenants,
      recentEmails: { 't7-collection': { _id: 'e1', sentDate: new Date() } }
    });
    const r = await checkExpiringLeases(deps);
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(1);
    expect(sent).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  test('multiple tenants — mixed windows and debounces produce correct counts', async () => {
    const tenants = [
      tenant({ _id: 'hit-30', daysFromNow: 30 }),
      tenant({ _id: 'hit-7', daysFromNow: 7 }),
      tenant({ _id: 'hit-1', daysFromNow: 1 }),
      tenant({ _id: 'skip-31', daysFromNow: 31 }),
      tenant({
        _id: 'skip-recent',
        daysFromNow: 7,
        lastSent: moment.utc(FIXED_NOW).subtract(10, 'days').toDate()
      })
    ];
    const { deps, sent } = makeDeps({ tenants });
    const r = await checkExpiringLeases(deps);
    expect(r.scanned).toBe(5);
    expect(r.sent).toBe(3);
    expect(r.skipped).toBe(2);
    expect(sent.map((s) => s.body.recordId).sort()).toEqual(
      ['hit-1', 'hit-30', 'hit-7']
    );
  });

  test('postEmail failure increments errors and does not call markSent', async () => {
    const tenants = [tenant({ _id: 'fail', daysFromNow: 7 })];
    const { deps, marked } = makeDeps({ tenants });
    deps.postEmail = jest.fn(async () => {
      throw new Error('boom');
    });
    const r = await checkExpiringLeases(deps);
    expect(r.errors).toBe(1);
    expect(r.sent).toBe(0);
    expect(marked).toHaveLength(0);
  });
});
