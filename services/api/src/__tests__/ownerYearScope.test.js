/* eslint-env node, jest */
/**
 * Owner ledger year-scoping — round-2 audit H9.
 *
 * The Accounting page's Ιδιοκτήτες (Owners) sub-tab is year-scoped (its sibling
 * Incoming/Outgoing/Payments tabs + the per-owner statement PDF all filter to
 * the page year) but its data came from GET /owners with NO year — so Paid /
 * Outstanding showed ALL-TIME totals, contradicting the statement beside them.
 *
 * Fix: _aggregateOwners gained an optional `year` param that filters each owner
 * charge by `Math.floor(term/1e6) === year`; absent year → all-time (the
 * standalone Owners page). all() reads ?year=. This proves the aggregator.
 *
 * type: module → jest.unstable_mockModule + dynamic import; the REAL
 * OwnerStatement is wired in (mirrors ownerPaymentCarry.test.js).
 */
import { jest } from '@jest/globals';

let _aggregateOwners;

beforeAll(async () => {
  class ServiceError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
  const OwnerStatement = await import(
    '../../../common/src/utils/ownerstatement.ts'
  );
  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: { Tenant: { find: () => ({ lean: async () => [] }) } },
    logger: { warn() {}, info() {}, error() {} },
    ServiceError,
    OwnerStatement
  }));
  ({ _aggregateOwners } = await import('../managers/ownermanager.js'));
});

// One building, one owner (ΛΑΜΔΑ), two vacant-owner charges in different years:
// term 2025040100 (€100, 2025) and term 2026040100 (€50, 2026). Both billed to
// the owner via chargeOwnerWhenVacant (source:'vacant', propertyId p1).
function building() {
  return {
    _id: 'b1',
    name: 'B1',
    units: [
      {
        _id: 'u1',
        propertyId: 'p1',
        isManaged: true,
        owners: [{ name: 'ΛΑΜΔΑ', taxId: '021301485', percentage: 100 }]
      }
    ],
    expenses: [
      {
        _id: 'e1',
        name: 'Cleaning',
        type: 'common',
        amount: 100,
        chargeOwnerWhenVacant: true,
        isRecurring: true,
        startTerm: 2025010100
      }
    ],
    ownerMonthlyExpenses: [
      {
        _id: 'ome1',
        expenseId: 'e1',
        source: 'vacant',
        propertyId: 'p1',
        term: 2025040100,
        amount: 100,
        payments: []
      },
      {
        _id: 'ome2',
        expenseId: 'e1',
        source: 'vacant',
        propertyId: 'p1',
        term: 2026040100,
        amount: 50,
        payments: []
      }
    ]
  };
}

function ownerTotal(map) {
  const owners = Array.from(map.values());
  return owners.reduce((s, o) => s + o.totalAmount, 0);
}

describe('H9 — _aggregateOwners year-scopes owner totals', () => {
  it('returns only the requested year (2026 → €50)', () => {
    const map = _aggregateOwners([building()], new Set(), 2026);
    // FAILING-FIRST: before the year param the aggregator summed both terms
    // (€150) regardless of year.
    expect(ownerTotal(map)).toBe(50);
  });

  it('returns only the requested year (2025 → €100)', () => {
    const map = _aggregateOwners([building()], new Set(), 2025);
    expect(ownerTotal(map)).toBe(100);
  });

  it('absent year → all-time (€150) for the standalone Owners page', () => {
    const map = _aggregateOwners([building()], new Set());
    expect(ownerTotal(map)).toBe(150);
  });
});
