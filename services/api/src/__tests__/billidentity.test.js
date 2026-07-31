/* eslint-env node, jest */
// billidentity — physical-bill identity probe (BILL-IDENTITY, bill-OCR audit
// 2026-07). Locks the behaviour that a bill re-parsed into a DIFFERENT term is
// still recognised as the same physical λογαριασμός, WITHOUT the probe firing on
// the routine next-month bill for the same meter.
//
// Deliberately its own suite with a ONE-KEY common mock: billidentity.ts imports
// only Collections. Extending billstorage.test.js instead (as first proposed)
// would have needed that suite's {Crypto, logger} factory widened AND would pull
// the PDF-parser + axios chain of billmanager into a B2-archival unit suite.
import { jest } from '@jest/globals';

// Every findOne call is recorded so the tests can assert the QUERY, not just the
// result — the term:{$ne} scoping and the "arm skipped entirely" cases are only
// observable there.
const state = { queries: [], responder: () => null };

jest.unstable_mockModule('@microrealestate/common', () => ({
  Collections: {
    Bill: {
      findOne: (q) => {
        state.queries.push(q);
        return { lean: async () => state.responder(q) };
      }
    }
  },
  logger: { error() {}, warn() {}, info() {}, debug() {} }
}));

const { findDuplicateBillByIdentity } = await import(
  '../managers/billidentity.js'
);

const REALM = 'realm-1';
const BUILDING = 'building-1';
const EXPENSE = 'expense-1';
const PROPOSED_TERM = 2026060100;

// A DEH-shaped July bill: period 09/06–09/07, so computeDefaultTerm(periodEnd)
// would normally derive July — the bug is when it derives June instead.
const JULY_BILL = {
  rfCode: 'RF12345678901234567',
  billingId: '1 234567 89',
  periodStart: new Date('2026-06-09T00:00:00Z'),
  periodEnd: new Date('2026-07-09T00:00:00Z')
};

const storedBill = (over = {}) => ({
  term: 2026070100,
  totalAmount: 186.21,
  ...over
});

beforeEach(() => {
  state.queries = [];
  state.responder = () => null;
});

const call = (bill = JULY_BILL, term = PROPOSED_TERM) =>
  findDuplicateBillByIdentity(REALM, BUILDING, EXPENSE, bill, term);

describe('findDuplicateBillByIdentity — rfCode arm', () => {
  it('finds the same physical bill filed under a DIFFERENT term', async () => {
    state.responder = (q) => (q.rfCode ? storedBill() : null);
    const out = await call();
    expect(out).toEqual({
      term: 2026070100,
      totalAmount: 186.21,
      matchedOn: 'rfCode'
    });
  });

  it('scopes every probe to term:{$ne: proposedTerm}', async () => {
    // The SAME-term case is the ordinary replace flow, already reported by
    // billmanager's existingAmount probe. Reporting it here too would show the
    // operator two banners and bury the actionable one.
    state.responder = () => null;
    await call();
    expect(state.queries.length).toBeGreaterThan(0);
    for (const q of state.queries) {
      expect(q.term).toEqual({ $ne: PROPOSED_TERM });
      expect(q.realmId).toBe(REALM);
      expect(q.buildingId).toBe(BUILDING);
      expect(q.expenseId).toBe(EXPENSE);
    }
  });

  it('is SKIPPED when rfCode is absent — never queries rfCode:undefined', async () => {
    // A checksum-rejected OCR leaves rfCode undefined (billparser/deh.ts:137).
    // A `{rfCode: undefined}` query would match every bill that has no RF at
    // all, i.e. false-positive on an unrelated ΕΥΔΑΠ bill.
    state.responder = () => null;
    await call({ ...JULY_BILL, rfCode: undefined });
    for (const q of state.queries) {
      expect('rfCode' in q).toBe(false);
    }
  });

  it('is SKIPPED when rfCode is an empty / whitespace string', async () => {
    state.responder = () => null;
    await call({ ...JULY_BILL, rfCode: '   ' });
    for (const q of state.queries) {
      expect('rfCode' in q).toBe(false);
    }
  });
});

describe('findDuplicateBillByIdentity — billingId + period arm', () => {
  const noRf = { ...JULY_BILL, rfCode: undefined };

  it('matches on billingId when periodEnd is within a few days', async () => {
    // The real failure mode: the SAME bill re-read with a slightly different
    // period end (a digit misread, or the Athens UTC+3 boundary at deh.ts:37)
    // that pushed the derived term into the adjacent month.
    state.responder = (q) => (q.billingId ? storedBill() : null);
    const out = await call(noRf);
    expect(out).toMatchObject({ term: 2026070100, matchedOn: 'period' });
  });

  it('the periodEnd window is a ±10-day band around this bill', async () => {
    state.responder = () => null;
    await call(noRf);
    const q = state.queries.find((x) => x.billingId);
    expect(q).toBeTruthy();
    const end = JULY_BILL.periodEnd.getTime();
    const day = 24 * 60 * 60 * 1000;
    expect(q.periodEnd.$gte.getTime()).toBe(end - 10 * day);
    expect(q.periodEnd.$lte.getTime()).toBe(end + 10 * day);
    // A month-long window would swallow the next bill; a zero window would miss
    // the very misread this exists to catch.
    expect(q.periodEnd.$lte.getTime() - q.periodEnd.$gte.getTime()).toBeLessThan(
      25 * day
    );
  });

  it('does NOT match the following month even when the periods TOUCH', async () => {
    // The regression guard on the fix itself. Greek utility periods share a
    // boundary date (…–09/07 then 09/07–09/08), and billingId is the αριθμός
    // παροχής — IDENTICAL every month. An interval-OVERLAP test with inclusive
    // bounds ($lte/$gte) is satisfied by that touching pair, so it would warn on
    // nearly every routine monthly import and train the operator to ignore the
    // one banner that matters. Proximity of periodEnd is the discriminator, so
    // the ~30-day-later bill falls outside the band.
    const nextMonth = {
      ...noRf,
      periodStart: new Date('2026-07-09T00:00:00Z'),
      periodEnd: new Date('2026-08-09T00:00:00Z')
    };
    // Mongo would do the range filter; here the responder proves the QUERY
    // excludes the stored July bill rather than relying on a mock's judgement.
    state.responder = () => null;
    await call(nextMonth, 2026080100);
    const q = state.queries.find((x) => x.billingId);
    const julyEnd = new Date('2026-07-09T00:00:00Z').getTime();
    expect(julyEnd).toBeLessThan(q.periodEnd.$gte.getTime());
  });

  it('is SKIPPED when periodEnd is missing (no unbounded billingId match)', async () => {
    state.responder = () => null;
    await call({ ...noRf, periodEnd: undefined });
    expect(state.queries.filter((q) => q.billingId)).toHaveLength(0);
  });

  it('is SKIPPED when periodStart is missing', async () => {
    state.responder = () => null;
    await call({ ...noRf, periodStart: undefined });
    expect(state.queries.filter((q) => q.billingId)).toHaveLength(0);
  });

  it('is SKIPPED when a period bound is an unparseable date', async () => {
    state.responder = () => null;
    await call({ ...noRf, periodEnd: 'not-a-date' });
    expect(state.queries.filter((q) => q.billingId)).toHaveLength(0);
  });

  it('is SKIPPED when billingId is absent', async () => {
    state.responder = () => null;
    await call({ ...noRf, billingId: undefined });
    expect(state.queries.filter((q) => q.billingId)).toHaveLength(0);
  });
});

describe('findDuplicateBillByIdentity — no match', () => {
  it('returns undefined when nothing matches', async () => {
    state.responder = () => null;
    await expect(call()).resolves.toBeUndefined();
  });

  it('prefers the rfCode arm and does not run the billingId probe on a hit', async () => {
    state.responder = (q) => (q.rfCode ? storedBill() : null);
    await call();
    expect(state.queries.filter((q) => q.billingId)).toHaveLength(0);
  });

  it('falls through to the billingId arm when rfCode finds nothing', async () => {
    state.responder = (q) => (q.billingId ? storedBill() : null);
    const out = await call();
    expect(out?.matchedOn).toBe('period');
    expect(state.queries.filter((q) => q.rfCode)).toHaveLength(1);
  });

  it('coerces a missing totalAmount on the stored doc to 0 rather than NaN', async () => {
    state.responder = (q) =>
      q.rfCode ? storedBill({ totalAmount: undefined }) : null;
    const out = await call();
    expect(out.totalAmount).toBe(0);
  });
});
