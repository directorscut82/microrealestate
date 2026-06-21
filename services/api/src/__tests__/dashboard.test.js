/* eslint-env node */
import moment from 'moment';
// M3 (test integrity): import the REAL dashboard computations the `all()`
// handler runs — not hand-copied mirrors. The previous version re-implemented
// each function in this file; those copies silently drifted from production
// (the revenue mirror lacked the M6 VAT/allocation exclusion, the notPaid
// mirror kept the pre-Wave-26 signed value, the top-unpaid mirror omitted the
// carry-forward settle check) so the suite was green while asserting a contract
// the API no longer ships (the GEN-001 incident). These are pure functions —
// no DB mock needed — so a plain import under @swc/jest is fine.
import {
  _computeActiveTenants as computeActiveTenants,
  _computeTopUnpaid as computeTopUnpaid,
  _computeTotalYearRevenues as computeTotalYearRevenues,
  _computeRevenues as computeRevenues,
  _computeOccupancyRate as computeOccupancyRate
} from '../managers/dashboardmanager.js';

function _tenantName(tenant) {
  return (
    tenant.name ||
    `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim()
  );
}

// --- Test Data Factories ---

function makeTenant(overrides = {}) {
  const now = moment.utc();
  return {
    _id: 'tenant1',
    name: 'John Doe',
    endDate: now.clone().add(6, 'months').toDate(),
    properties: [{ propertyId: 'prop1' }],
    rents: [],
    ...overrides
  };
}

function makeRent(term, opts = {}) {
  return {
    term,
    total: {
      grandTotal: opts.grandTotal ?? 1000,
      payment: opts.payment ?? 0,
      preTaxAmount: opts.preTaxAmount ?? 900
    },
    payments: opts.payments || [],
    charges: opts.charges || [],
    buildingCharges: opts.buildingCharges || []
  };
}

// --- Tests ---

describe('Dashboard computation logic', () => {
  describe('computeActiveTenants', () => {
    it('should include tenants with endDate in the future', () => {
      const now = moment.utc();
      const active = makeTenant({
        _id: 't1',
        endDate: now.clone().add(1, 'month').toDate()
      });
      const expired = makeTenant({
        _id: 't2',
        endDate: now.clone().subtract(1, 'month').toDate()
      });
      const result = computeActiveTenants([active, expired], now);
      expect(result).toHaveLength(1);
      expect(result[0]._id).toBe('t1');
    });

    it('should use terminationDate over endDate when present', () => {
      const now = moment.utc();
      const tenant = makeTenant({
        endDate: now.clone().add(1, 'year').toDate(),
        terminationDate: now.clone().subtract(1, 'day').toDate()
      });
      const result = computeActiveTenants([tenant], now);
      expect(result).toHaveLength(0);
    });

    it('should include tenant whose endDate is today', () => {
      const now = moment.utc();
      const tenant = makeTenant({
        endDate: now.clone().toDate()
      });
      const result = computeActiveTenants([tenant], now);
      expect(result).toHaveLength(1);
    });

    // T2.1 regression coverage. The pre-T2.1 predicate counted any
    // tenant whose `terminationDate || endDate` was missing as active
    // (because moment.utc(undefined) resolves to "now"), so a half-
    // setup property-less tenant inflated activeTenants and the
    // dashboard occupancy denominator alongside it.
    it('should exclude property-less tenants', () => {
      const now = moment.utc();
      const tenant = makeTenant({
        endDate: now.clone().add(1, 'month').toDate(),
        properties: []
      });
      const result = computeActiveTenants([tenant], now);
      expect(result).toHaveLength(0);
    });

    it('should exclude tenants with no end date at all', () => {
      const now = moment.utc();
      const tenant = makeTenant({
        endDate: undefined,
        terminationDate: undefined
      });
      const result = computeActiveTenants([tenant], now);
      expect(result).toHaveLength(0);
    });

    it('should exclude tenants with an invalid terminationDate', () => {
      const now = moment.utc();
      const tenant = makeTenant({
        endDate: now.clone().add(1, 'year').toDate(),
        terminationDate: 'not-a-real-date'
      });
      const result = computeActiveTenants([tenant], now);
      expect(result).toHaveLength(0);
    });
  });

  describe('computeTotalYearRevenues', () => {
    it('should sum payments with dates in the current year', () => {
      const now = moment.utc();
      const year = now.year();
      const beginOfYear = moment.utc(now).startOf('year');
      const endOfYear = moment.utc(now).endOf('year');
      const term = `${year}010100`;

      const tenant = makeTenant({
        rents: [
          makeRent(term, {
            payments: [
              { date: `15/03/${year}`, amount: 500 },
              { date: `15/04/${year}`, amount: 300 }
            ]
          })
        ]
      });

      const result = computeTotalYearRevenues(
        [tenant],
        beginOfYear,
        endOfYear
      );
      expect(result).toBe(800);
    });

    it('should skip payments with zero amount', () => {
      const now = moment.utc();
      const year = now.year();
      const beginOfYear = moment.utc(now).startOf('year');
      const endOfYear = moment.utc(now).endOf('year');
      const term = `${year}010100`;

      const tenant = makeTenant({
        rents: [
          makeRent(term, {
            payments: [
              { date: `15/03/${year}`, amount: 500 },
              { date: `15/04/${year}`, amount: 0 }
            ]
          })
        ]
      });

      const result = computeTotalYearRevenues(
        [tenant],
        beginOfYear,
        endOfYear
      );
      expect(result).toBe(500);
    });

    it('should skip payments with no date', () => {
      const now = moment.utc();
      const year = now.year();
      const beginOfYear = moment.utc(now).startOf('year');
      const endOfYear = moment.utc(now).endOf('year');
      const term = `${year}010100`;

      const tenant = makeTenant({
        rents: [
          makeRent(term, {
            payments: [
              { date: `15/03/${year}`, amount: 500 },
              { date: '', amount: 200 },
              { amount: 100 }
            ]
          })
        ]
      });

      const result = computeTotalYearRevenues(
        [tenant],
        beginOfYear,
        endOfYear
      );
      expect(result).toBe(500);
    });
  });

  describe('computeTopUnpaid', () => {
    it('should return top 5 tenants by remaining owed, biggest debtor first', () => {
      const now = moment.utc();
      const beginOfMonth = moment.utc(now).startOf('month');
      const endOfMonth = moment.utc(now).endOf('month');
      const currentTerm = now.format('YYYYMM') + '0100';

      const tenants = Array.from({ length: 7 }, (_, i) =>
        makeTenant({
          _id: `t${i}`,
          name: `Tenant ${i}`,
          rents: [
            makeRent(currentTerm, {
              grandTotal: 1000,
              payment: 1000 - (i + 1) * 100
            })
          ]
        })
      );

      const result = computeTopUnpaid(tenants, beginOfMonth, endOfMonth);
      expect(result).toHaveLength(5);
      // Largest POSITIVE remaining first (Tenant 6 owes 700, the most).
      expect(result[0].balance).toBeGreaterThan(result[1].balance);
      expect(result[0].balance).toBe(700);
      expect(result[0].tenant.name).toBe('Tenant 6');
    });

    it('should only include _id and name in tenant field', () => {
      const now = moment.utc();
      const beginOfMonth = moment.utc(now).startOf('month');
      const endOfMonth = moment.utc(now).endOf('month');
      const currentTerm = now.format('YYYYMM') + '0100';

      const tenant = makeTenant({
        _id: 't1',
        name: 'Debtor',
        rents: [makeRent(currentTerm, { grandTotal: 1000, payment: 0 })]
      });

      const result = computeTopUnpaid([tenant], beginOfMonth, endOfMonth);
      expect(result[0].tenant).toEqual({ _id: 't1', name: 'Debtor' });
      expect(result[0].balance).toBe(1000);
      expect(result[0].rent).toBeUndefined();
    });

    it('should exclude tenants with zero or positive balance', () => {
      const now = moment.utc();
      const beginOfMonth = moment.utc(now).startOf('month');
      const endOfMonth = moment.utc(now).endOf('month');
      const currentTerm = now.format('YYYYMM') + '0100';

      const paid = makeTenant({
        _id: 't1',
        rents: [makeRent(currentTerm, { grandTotal: 1000, payment: 1000 })]
      });
      const overpaid = makeTenant({
        _id: 't2',
        rents: [makeRent(currentTerm, { grandTotal: 1000, payment: 1200 })]
      });

      const result = computeTopUnpaid(
        [paid, overpaid],
        beginOfMonth,
        endOfMonth
      );
      expect(result).toEqual([]);
    });

    it('should skip tenants with no rent for current month', () => {
      const now = moment.utc();
      const beginOfMonth = moment.utc(now).startOf('month');
      const endOfMonth = moment.utc(now).endOf('month');

      const tenant = makeTenant({ _id: 't1', rents: [] });
      const result = computeTopUnpaid([tenant], beginOfMonth, endOfMonth);
      expect(result).toEqual([]);
    });
  });

  describe('computeRevenues', () => {
    it('should produce 12 monthly entries sorted chronologically', () => {
      const now = moment.utc();
      const beginOfYear = moment.utc(now).startOf('year');
      const endOfYear = moment.utc(now).endOf('year');

      const result = computeRevenues([], beginOfYear, endOfYear, now);
      expect(result).toHaveLength(12);
      const months = result.map((r) => r.month);
      const parsed = months.map((m) => moment.utc(m, 'MMYYYY').valueOf());
      for (let i = 1; i < parsed.length; i++) {
        expect(parsed[i]).toBeGreaterThan(parsed[i - 1]);
      }
    });

    it('should aggregate paid and notPaid per month', () => {
      const now = moment.utc();
      const year = now.year();
      const beginOfYear = moment.utc(now).startOf('year');
      const endOfYear = moment.utc(now).endOf('year');
      const marchTerm = `${year}030100`;

      const tenant = makeTenant({
        rents: [makeRent(marchTerm, { grandTotal: 1000, payment: 600 })]
      });

      const result = computeRevenues([tenant], beginOfYear, endOfYear, now);
      const march = result.find((r) => r.month === `03${year}`);
      expect(march.paid).toBe(600);
      // notPaid is the UNSIGNED this-month shortfall (production emits
      // Math.abs(_round(...))). A €1000 bill with €600 paid → €400 owed.
      expect(march.notPaid).toBe(400);
      expect(march.tenants).toHaveLength(1);
      expect(march.tenants[0].name).toBe('John Doe');
      expect(march.tenants[0].due).toBe(1000);
    });

    it('should include buildingChargesByType breakdown', () => {
      const now = moment.utc();
      const year = now.year();
      const beginOfYear = moment.utc(now).startOf('year');
      const endOfYear = moment.utc(now).endOf('year');
      const term = `${year}050100`;

      const tenant = makeTenant({
        rents: [
          makeRent(term, {
            grandTotal: 1500,
            payment: 1500,
            buildingCharges: [
              { amount: 50, type: 'heating' },
              { amount: 30, type: 'elevator' },
              { amount: 20, type: 'heating' }
            ]
          })
        ]
      });

      const result = computeRevenues([tenant], beginOfYear, endOfYear, now);
      const may = result.find((r) => r.month === `05${year}`);
      expect(may.buildingCharges).toBe(100);
      expect(may.buildingChargesByType).toEqual({
        heating: 70,
        elevator: 30
      });
    });

    it('should round paid/notPaid to 2 decimal places', () => {
      const now = moment.utc();
      const year = now.year();
      const beginOfYear = moment.utc(now).startOf('year');
      const endOfYear = moment.utc(now).endOf('year');
      const term = `${year}010100`;

      const tenant = makeTenant({
        rents: [makeRent(term, { grandTotal: 333.33, payment: 100.111 })]
      });

      const result = computeRevenues([tenant], beginOfYear, endOfYear, now);
      const jan = result.find((r) => r.month === `01${year}`);
      expect(jan.paid).toBe(100.11);
      // Unsigned shortfall, rounded: €333.33 − €100.11 = €233.22.
      expect(jan.notPaid).toBe(233.22);
    });
  });

  describe('computeOccupancyRate', () => {
    it('should exclude owner_occupied and parking from denominator', () => {
      const tenant = makeTenant({
        properties: [{ propertyId: 'prop1' }, { propertyId: 'prop2' }]
      });
      const buildings = [
        {
          units: [
            { propertyId: 'prop3', occupancyType: 'owner_occupied' },
            { propertyId: 'prop4', occupancyType: 'parking' }
          ]
        }
      ];
      // 4 total - 2 non-rentable = 2 rentable; 2 occupied = 100%
      const rate = computeOccupancyRate([tenant], 4, buildings);
      expect(rate).toBe(1);
    });

    it('should return 0 when no rentable properties exist', () => {
      const buildings = [
        {
          units: [
            { propertyId: 'prop1', occupancyType: 'owner_occupied' }
          ]
        }
      ];
      const rate = computeOccupancyRate([], 1, buildings);
      expect(rate).toBe(0);
    });

    it('should compute partial occupancy correctly', () => {
      const tenant = makeTenant({
        properties: [{ propertyId: 'prop1' }]
      });
      const rate = computeOccupancyRate([tenant], 4, []);
      // 4 rentable, 1 occupied = 25%
      expect(rate).toBe(0.25);
    });
  });

  describe('_tenantName', () => {
    it('should prefer name field', () => {
      expect(
        _tenantName({ name: 'Company', firstName: 'A', lastName: 'B' })
      ).toBe('Company');
    });

    it('should fall back to firstName+lastName', () => {
      expect(
        _tenantName({ name: '', firstName: 'Jane', lastName: 'Smith' })
      ).toBe('Jane Smith');
    });

    it('should handle missing fields', () => {
      expect(_tenantName({})).toBe('');
    });
  });

  // Mirror of the `paid` derivation used by buildingmanager.computeOwnerEksoda-
  // ByMonth (the ΕΞΟΔΑ twin of revenues). OWED is now computed LIVE from
  // building expenses + repairs (see the buildingmanager eksoda tests), but a
  // term's PAID is recorded state read from the materialised owner rows:
  //   paid = min(max(Σ payments, paid?amount:0), amount)  per row, summed per
  // term. Bridges old checkbox-paid rows + new καταβολές without double-
  // counting or exceeding the amount. The dashboard then caps a term's paid at
  // that term's live owed (paid can never exceed what is owed for the month).
  describe('eksoda paid derivation (recorded state per term)', () => {
    const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const rowPaid = (e) => {
      const amount = Number(e.amount) || 0;
      const fromPayments = (e.payments || []).reduce(
        (s, p) => s + (Number(p.amount) || 0),
        0
      );
      const fromFlag = e.paid ? amount : 0;
      return Math.min(Math.max(fromPayments, fromFlag), amount);
    };
    // Aggregate recorded paid per term, then cap each term's paid at owed.
    const paidByTermCapped = (rows, owedByTerm, year) => {
      const paid = {};
      for (const e of rows) {
        const term = Number(e.term || 0);
        if (Math.floor(term / 1000000) !== year) continue;
        if (!(Number(e.amount) > 0)) continue;
        paid[term] = round((paid[term] || 0) + rowPaid(e));
      }
      for (const term of Object.keys(paid)) {
        paid[term] = round(Math.min(paid[term], owedByTerm[term] || 0));
      }
      return paid;
    };

    it('payment-derived paid, bucketed per term', () => {
      const paid = paidByTermCapped(
        [
          { term: 2026010100, amount: 100, payments: [{ amount: 100 }] },
          { term: 2026020100, amount: 50, payments: [{ amount: 20 }] }
        ],
        { 2026010100: 100, 2026020100: 50 },
        2026
      );
      expect(paid).toEqual({ 2026010100: 100, 2026020100: 20 });
    });
    it('bridges a manual paid flag with empty payments', () => {
      const paid = paidByTermCapped(
        [{ term: 2026010100, amount: 80, paid: true, payments: [] }],
        { 2026010100: 80 },
        2026
      );
      expect(paid).toEqual({ 2026010100: 80 });
    });
    it('caps paid at the row amount (overpayment cannot inflate paid)', () => {
      const paid = paidByTermCapped(
        [{ term: 2026010100, amount: 60, payments: [{ amount: 90 }] }],
        { 2026010100: 60 },
        2026
      );
      expect(paid).toEqual({ 2026010100: 60 });
    });
    it('caps a term paid at that term LIVE owed (paid ≤ owed)', () => {
      // recorded paid 100 but the live owed for the month is only 50 → 50.
      const paid = paidByTermCapped(
        [{ term: 2026010100, amount: 100, payments: [{ amount: 100 }] }],
        { 2026010100: 50 },
        2026
      );
      expect(paid).toEqual({ 2026010100: 50 });
    });
    it('excludes other-year rows', () => {
      const paid = paidByTermCapped(
        [
          { term: 2025010100, amount: 100, payments: [{ amount: 100 }] },
          { term: 2026010100, amount: 40, payments: [{ amount: 40 }] }
        ],
        { 2026010100: 40 },
        2026
      );
      expect(paid).toEqual({ 2026010100: 40 });
    });
    it('payment flag OR payments, whichever is higher (no double count)', () => {
      const paid = paidByTermCapped(
        [{ term: 2026010100, amount: 100, paid: true, payments: [{ amount: 30 }] }],
        { 2026010100: 100 },
        2026
      );
      expect(paid).toEqual({ 2026010100: 100 });
    });
  });

  // Mirror of dashboardmanager._expensesRollup's per-building merge loop. The
  // producer (computeOwnerEksodaByMonth) emits a delete-time 'credit' row's
  // PAID into paidByTerm with NO owedByTerm entry. The consumer MUST walk the
  // UNION of owed+paid terms (not owedByTerm alone) and must NOT clamp paid to
  // owed — else a credit's preserved καταβολή is silently dropped from the
  // dashboard eksoda total (Step-7 CREDIT-DASH-1). This mirror guards that the
  // union-walk shape stays in sync with the production emit.
  describe('expensesRollup union-walk (credit-row paid surfaces)', () => {
    const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
    // The OLD (broken) consumer: iterate owedByTerm only, clamp paid≤owed.
    const rollupOwedOnly = (owedByTerm, paidByTerm) => {
      let paid = 0;
      let expenses = 0;
      for (const [term, owed] of owedByTerm) {
        const p = Math.min(paidByTerm.get(term) || 0, owed);
        paid = round(paid + p);
        expenses = round(expenses + owed);
      }
      return { paid, expenses };
    };
    // The NEW consumer: walk the union, paid NOT clamped to owed, notPaid ≥0.
    const rollupUnion = (owedByTerm, paidByTerm) => {
      let paid = 0;
      let expenses = 0;
      let notPaid = 0;
      const allTerms = new Set([...owedByTerm.keys(), ...paidByTerm.keys()]);
      for (const term of allTerms) {
        const owed = owedByTerm.get(term) || 0;
        const p = paidByTerm.get(term) || 0;
        paid = round(paid + p);
        notPaid = round(notPaid + Math.max(0, owed - p));
        expenses = round(expenses + owed);
      }
      return { paid, expenses, notPaid };
    };

    it('OLD owed-only loop DROPS a credit-only term (regression witness)', () => {
      // June: owed 0 (credit), paid 40. The owed-only loop never visits June.
      const owed = new Map();
      const paid = new Map([[2026060100, 40]]);
      expect(rollupOwedOnly(owed, paid)).toEqual({ paid: 0, expenses: 0 });
    });

    it('union loop SURFACES the credit-only term paid (paid 40, owed 0)', () => {
      const owed = new Map();
      const paid = new Map([[2026060100, 40]]);
      expect(rollupUnion(owed, paid)).toEqual({
        paid: 40,
        expenses: 0,
        notPaid: 0 // credit surplus never produces negative notPaid
      });
    });

    it('union loop keeps normal owed+paid terms intact alongside a credit term', () => {
      // May: normal €100 owed, €60 paid. June: credit €40 paid, €0 owed.
      const owed = new Map([[2026050100, 100]]);
      const paid = new Map([
        [2026050100, 60],
        [2026060100, 40]
      ]);
      expect(rollupUnion(owed, paid)).toEqual({
        paid: 100, // 60 + 40
        expenses: 100, // only May owes
        notPaid: 40 // May shortfall 40; June credit contributes 0
      });
    });

    it('union loop does NOT clamp a credit overpayment down to owed', () => {
      // A credit can legitimately have paid>owed(=0). The OLD min(...,owed)
      // clamp zeroed it; the union loop counts it verbatim.
      const owed = new Map();
      const paid = new Map([[2026060100, 40]]);
      expect(rollupOwedOnly(owed, paid).paid).toBe(0); // clamped away
      expect(rollupUnion(owed, paid).paid).toBe(40); // preserved
    });
  });

  // Mirror of A2 _toBuildingData tenantRentYTD per-tenant loop. rent.total
  // .grandTotal is CUMULATIVE (carries prior unpaid months), so owed must strip
  // the carry-in (monthDue = max(0, grandTotal − max(0, balance))) before
  // subtracting payment — else a tenant N months behind shows a quadratic owed
  // (Step-7 A2 carry-forward double-count). Guards the carry-strip stays.
  describe('A2 tenantRentYTD carry-forward (owed strips the carried balance)', () => {
    const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
    // The BROKEN formula: owed += max(0, grandTotal − payment).
    const owedNaive = (rents, year) =>
      round(
        rents
          .filter((r) => Math.floor(r.term / 1000000) === year)
          .reduce((s, r) => s + Math.max(0, r.grandTotal - r.payment), 0)
      );
    // The FIXED formula: strip the carried balance first.
    const owedFixed = (rents, year) =>
      round(
        rents
          .filter((r) => Math.floor(r.term / 1000000) === year)
          .reduce((s, r) => {
            const monthDue = Math.max(0, r.grandTotal - Math.max(0, r.balance));
            return s + Math.max(0, monthDue - r.payment);
          }, 0)
      );
    // €1000/mo, nothing paid for 6 months → grandTotal carries: 1000,2000,...,6000.
    const rents = [1000, 2000, 3000, 4000, 5000, 6000].map((g, i) => ({
      term: Number(`2026${String(i + 1).padStart(2, '0')}0100`),
      grandTotal: g,
      payment: 0,
      balance: g - 1000 // prior cumulative deficit carried into this month
    }));

    it('naive sum blows up quadratically (regression witness)', () => {
      expect(owedNaive(rents, 2026)).toBe(21000); // 1000+2000+...+6000
    });
    it('carry-stripped sum equals the true arrears (€6,000)', () => {
      expect(owedFixed(rents, 2026)).toBe(6000); // 6 × €1000 monthly bill
    });
    it('a fully-paid tenant owes €0 either way', () => {
      const paid = [1, 2, 3].map((m) => ({
        term: Number(`20260${m}0100`),
        grandTotal: 1000,
        payment: 1000,
        balance: 0
      }));
      expect(owedFixed(paid, 2026)).toBe(0);
      expect(owedNaive(paid, 2026)).toBe(0);
    });
    it('partial monthly payment: owed is the per-month shortfall, not the carry', () => {
      // €1000/mo, pays €600 each month → carries €400/mo. True YTD shortfall over
      // 3 months = €1200, NOT the cumulative-sum blow-up.
      const partial = [
        { term: 2026010100, grandTotal: 1000, payment: 600, balance: 0 },
        { term: 2026020100, grandTotal: 1400, payment: 600, balance: 400 },
        { term: 2026030100, grandTotal: 1800, payment: 600, balance: 800 }
      ];
      expect(owedFixed(partial, 2026)).toBe(1200); // 3 × €400 monthly shortfall
    });
  });

  // Mirror of §5 addUncollectedPayment's oldest-first allocation. A voluntary
  // coverage payment is distributed across the year's OUTSTANDING uncollected
  // terms (gross − already-covered) oldest-first, so it lands on the months that
  // carry the gross — making the per-term ΧΡΕΩΣΕΙΣ panel and the year tile
  // reconcile (a client-fixed current-month term made them disagree, Step-7 §5).
  describe('A§5 uncollected coverage allocation (oldest-first)', () => {
    const _r = (n) => Math.round((Number(n) || 0) * 100) / 100;
    // grossByTerm: Map-like array [[term, gross], ...]; paidByTerm: {term: paid}.
    const allocate = (amount, grossByTerm, paidByTerm = {}, fallbackTerm) => {
      const outstanding = grossByTerm
        .map(([tm, g]) => [tm, _r(g - (paidByTerm[tm] || 0))])
        .filter(([, rem]) => rem > 0.005)
        .sort((a, b) => a[0] - b[0]);
      let remaining = _r(amount);
      const pushed = [];
      for (const [tm, rem] of outstanding) {
        if (remaining <= 0.005) break;
        const apply = Math.min(rem, remaining);
        pushed.push({ term: tm, amount: _r(apply) });
        remaining = _r(remaining - apply);
      }
      if (remaining > 0.005) pushed.push({ term: fallbackTerm, amount: _r(remaining) });
      return pushed;
    };

    it('covers a single past-month gross on THAT term (not the current month)', () => {
      // Jan gross €500, current month June (gross 0). Pay €500 → lands on Jan.
      const pushed = allocate(500, [[2026010100, 500]], {}, 2026060100);
      expect(pushed).toEqual([{ term: 2026010100, amount: 500 }]);
    });

    it('spreads oldest-first across multiple outstanding months', () => {
      // Jan €300, Mar €200. Pay €400 → €300 Jan + €100 Mar.
      const pushed = allocate(400, [[2026010100, 300], [2026030100, 200]], {}, 2026060100);
      expect(pushed).toEqual([
        { term: 2026010100, amount: 300 },
        { term: 2026030100, amount: 100 }
      ]);
    });

    it('skips already-covered terms (gross − paid)', () => {
      // Jan €300 but €300 already covered; Mar €200 open. Pay €200 → Mar only.
      const pushed = allocate(200, [[2026010100, 300], [2026030100, 200]], { 2026010100: 300 }, 2026060100);
      expect(pushed).toEqual([{ term: 2026030100, amount: 200 }]);
    });

    it('surplus beyond the year gross falls to the requested term (clamped ≥0 by the tile)', () => {
      const pushed = allocate(500, [[2026010100, 300]], {}, 2026060100);
      expect(pushed).toEqual([
        { term: 2026010100, amount: 300 },
        { term: 2026060100, amount: 200 }
      ]);
    });

    it('per-term panel + year tile now reconcile (Σ per-term covered === total covered)', () => {
      // gross Jan 300 + Mar 200 = 500; pay 500 → fully allocated to Jan+Mar.
      const pushed = allocate(500, [[2026010100, 300], [2026030100, 200]], {}, 2026060100);
      const perTermCovered = {};
      for (const p of pushed) perTermCovered[p.term] = (perTermCovered[p.term] || 0) + p.amount;
      // Panel for Jan: gross 300 − covered 300 = 0; Mar: 200 − 200 = 0. Tile: 0.
      expect(_r(300 - (perTermCovered[2026010100] || 0))).toBe(0);
      expect(_r(200 - (perTermCovered[2026030100] || 0))).toBe(0);
      // No coverage stranded on a zero-gross current month.
      expect(perTermCovered[2026060100] || 0).toBe(0);
    });
  });
});
