/* eslint-env node */
import moment from 'moment';

// Test the dashboard computation logic by importing the compiled manager
// and verifying behavior through the response contract

// Since the dashboard manager requires DB mocking via unstable_mockModule
// and this Jest config uses @swc/jest which doesn't support top-level await,
// we test the computation logic directly by extracting and testing the
// pure functions that drive the dashboard response.

// --- Pure computation functions extracted from dashboardmanager logic ---

function _tenantName(tenant) {
  return (
    tenant.name ||
    `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim()
  );
}

// Mirrors dashboardmanager.ts active-tenant predicate:
//   1) tenant has at least one property assigned (T1.7 surfaced
//      property-less tenants as setup-incomplete, they don't generate
//      rent records and shouldn't inflate the dashboard)
//   2) (terminationDate || endDate) is a valid date that is not in
//      the past, with both sides in UTC
function computeActiveTenants(allTenants, now) {
  return allTenants.filter((tenant) => {
    if (!tenant.properties?.length) return false;
    const endValue = tenant.terminationDate || tenant.endDate;
    if (!endValue) return false;
    const endMoment = moment.utc(endValue);
    if (!endMoment.isValid()) return false;
    return endMoment.isSameOrAfter(now, 'day');
  });
}

// GEN-001 fix: this mirror drifted out of sync with the production
// emit in dashboardmanager.ts. The "Top 5 unpaid" tile emits the
// remaining-owed as a POSITIVE amount (`Math.max(0, grandTotal -
// payment)`), keeps only rows where remaining > 0.005, and sorts
// DESCENDING (biggest debtor first). The previous version of this
// helper computed a SIGNED balance (`payment - grandTotal`) and
// filtered `< 0` — pre-Wave-26 semantics that no longer match what
// the API ships, so the suite was green while validating the wrong
// contract. Realigned below. (The production path also drops tenants
// settled by a future-month overpayment via _isSettledByCarryForward;
// that needs the full ledger helper and is exercised by the E2E
// suite, not this pure-function mirror.)
function computeTopUnpaid(activeTenants, beginOfTheMonth, endOfTheMonth) {
  return activeTenants
    .reduce((acc, tenant) => {
      const currentRent = (tenant.rents || []).find((rent) => {
        const termMoment = rent.term && moment.utc(rent.term, 'YYYYMMDDHH');
        return (
          termMoment &&
          termMoment.isBetween(beginOfTheMonth, endOfTheMonth, 'day', '[]')
        );
      });
      if (currentRent) {
        const remaining = Math.max(
          0,
          (currentRent.total?.grandTotal || 0) -
            (currentRent.total?.payment || 0)
        );
        if (remaining > 0.005) {
          acc.push({
            tenant: { _id: tenant._id, name: _tenantName(tenant) },
            balance: remaining
          });
        }
      }
      return acc;
    }, [])
    .sort((t1, t2) => t2.balance - t1.balance)
    .slice(0, 5);
}

function computeTotalYearRevenues(
  allTenants,
  beginOfTheYear,
  endOfTheYear
) {
  return allTenants.reduce((total, { rents = [] }) => {
    let sumPayments = 0;
    rents.forEach((rent) => {
      (rent.payments || []).forEach((payment) => {
        if (!payment.date || Number(payment.amount) === 0) return;
        const paymentMoment = moment.utc(payment.date, 'DD/MM/YYYY');
        if (
          paymentMoment.isBetween(beginOfTheYear, endOfTheYear, 'day', '[]')
        ) {
          sumPayments += payment.amount;
        }
      });
    });
    return total + sumPayments;
  }, 0);
}

function computeRevenues(allTenants, beginOfTheYear, endOfTheYear, now) {
  const emptyRevenues = moment
    .months()
    .reduce((acc, _month, index) => {
      const key = moment
        .utc(`${index + 1}/${now.year()}`, 'MM/YYYY')
        .format('MMYYYY');
      acc[key] = {
        month: key,
        paid: 0,
        notPaid: 0,
        baseRent: 0,
        charges: 0,
        buildingCharges: 0,
        buildingChargesByType: {},
        tenants: []
      };
      return acc;
    }, {});

  return Object.entries(
    allTenants.reduce((acc, tenant) => {
      const tenantName = _tenantName(tenant);
      (tenant.rents || []).forEach((rent) => {
        const termMoment = moment.utc(rent.term, 'YYYYMMDDHH');
        if (
          !termMoment.isBetween(beginOfTheYear, endOfTheYear, 'day', '[]')
        ) {
          return;
        }
        const key = termMoment.format('MMYYYY');

        const tenantBaseRent = rent.total?.preTaxAmount || 0;
        const tenantCharges = (rent.charges || []).reduce(
          (sum, c) => sum + (c.amount || 0),
          0
        );
        const tenantBuildingCharges = (rent.buildingCharges || []).reduce(
          (sum, c) => sum + (c.amount || 0),
          0
        );
        const tenantBuildingByType = {};
        (rent.buildingCharges || []).forEach((c) => {
          const t = c.type || 'other';
          tenantBuildingByType[t] =
            (tenantBuildingByType[t] || 0) + (c.amount || 0);
        });
        const tenantDue = rent.total?.grandTotal || 0;
        const tenantPaid = rent.total?.payment || 0;

        if (!acc[key]) {
          acc[key] = {
            month: key,
            paid: 0,
            notPaid: 0,
            baseRent: 0,
            charges: 0,
            buildingCharges: 0,
            buildingChargesByType: {},
            tenants: []
          };
        }

        acc[key].paid += tenantPaid;
        acc[key].notPaid +=
          tenantPaid - tenantDue < 0 ? tenantPaid - tenantDue : 0;
        acc[key].baseRent += tenantBaseRent;
        acc[key].charges += tenantCharges;
        acc[key].buildingCharges += tenantBuildingCharges;
        Object.entries(tenantBuildingByType).forEach(([type, amount]) => {
          acc[key].buildingChargesByType[type] =
            (acc[key].buildingChargesByType[type] || 0) + amount;
        });
        acc[key].tenants.push({
          name: tenantName,
          paid: tenantPaid,
          due: tenantDue,
          baseRent: tenantBaseRent,
          charges: tenantCharges,
          buildingCharges: tenantBuildingCharges,
          buildingChargesByType: tenantBuildingByType
        });
      });
      return acc;
    }, emptyRevenues)
  )
    .map(([, value]) => ({
      ...value,
      paid: value.paid > 0 ? Math.round(value.paid * 100) / 100 : value.paid,
      notPaid:
        value.notPaid < 0
          ? Math.round(value.notPaid * 100) / 100
          : value.notPaid
    }))
    .sort((r1, r2) =>
      moment.utc(r1.month, 'MMYYYY').isBefore(moment.utc(r2.month, 'MMYYYY'))
        ? -1
        : 1
    );
}

function computeOccupancyRate(
  activeTenants,
  propertyCount,
  buildings
) {
  const nonRentablePropertyIds = new Set();
  for (const building of buildings) {
    for (const unit of building.units || []) {
      if (
        unit.propertyId &&
        (unit.occupancyType === 'owner_occupied' ||
          unit.occupancyType === 'parking')
      ) {
        nonRentablePropertyIds.add(String(unit.propertyId));
      }
    }
  }

  const rentablePropertyCount = propertyCount - nonRentablePropertyIds.size;
  if (rentablePropertyCount <= 0) return 0;

  const countPropertyRented = activeTenants.reduce(
    (acc, { properties = [] }) => {
      properties.forEach(({ propertyId }) => {
        if (!nonRentablePropertyIds.has(String(propertyId))) {
          acc.add(propertyId);
        }
      });
      return acc;
    },
    new Set()
  ).size;
  return countPropertyRented / rentablePropertyCount;
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
      expect(march.notPaid).toBe(-400);
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
      expect(jan.notPaid).toBe(-233.22);
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

  // Mirror of dashboardmanager._ownerExpensesRollup per-row derivation: a
  // row's paid = min(max(Σ payments, paid?amount:0), amount), summed over the
  // current-year owner ledger across buildings. Bridges old checkbox-paid
  // rows + new καταβολές without double-counting or exceeding the amount.
  describe('owner-expenses rollup math', () => {
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
    const rollup = (rows, year) => {
      let total = 0;
      let paid = 0;
      for (const e of rows) {
        if (Math.floor(Number(e.term || 0) / 1000000) !== year) continue;
        const amount = Number(e.amount) || 0;
        if (!(amount > 0)) continue;
        total += amount;
        paid += rowPaid(e);
      }
      total = round(total);
      paid = round(paid);
      return { total, paid, outstanding: round(Math.max(0, total - paid)) };
    };

    it('sums current-year rows; payment-derived paid', () => {
      const r = rollup(
        [
          { term: 2026010100, amount: 100, payments: [{ amount: 100 }] },
          { term: 2026020100, amount: 50, payments: [{ amount: 20 }] }
        ],
        2026
      );
      expect(r).toEqual({ total: 150, paid: 120, outstanding: 30 });
    });
    it('bridges a manual paid flag with empty payments', () => {
      const r = rollup(
        [{ term: 2026010100, amount: 80, paid: true, payments: [] }],
        2026
      );
      expect(r).toEqual({ total: 80, paid: 80, outstanding: 0 });
    });
    it('caps paid at the amount (overpayment cannot inflate paid)', () => {
      const r = rollup(
        [{ term: 2026010100, amount: 60, payments: [{ amount: 90 }] }],
        2026
      );
      expect(r).toEqual({ total: 60, paid: 60, outstanding: 0 });
    });
    it('excludes other-year rows', () => {
      const r = rollup(
        [
          { term: 2025010100, amount: 100, payments: [{ amount: 100 }] },
          { term: 2026010100, amount: 40, payments: [] }
        ],
        2026
      );
      expect(r).toEqual({ total: 40, paid: 0, outstanding: 40 });
    });
    it('payment flag OR payments, whichever is higher (no double count)', () => {
      // paid:true AND a partial payment → counts amount once, not amount+payment
      const r = rollup(
        [{ term: 2026010100, amount: 100, paid: true, payments: [{ amount: 30 }] }],
        2026
      );
      expect(r).toEqual({ total: 100, paid: 100, outstanding: 0 });
    });
  });
});
