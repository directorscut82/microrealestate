/* eslint-env node, jest */
// Direct test of buildingmanager.computeOwnerEksodaByMonth — the LIVE owner-
// borne eksoda computation that feeds the dashboard Έξοδα chart + the Overview
// Έξοδα row. Mirrors the real NAS data shapes that exposed the "every eksoda
// surface reads ~€0" bug: a vacant FIXED expense (cost in customAllocations,
// amount 0) and a split REPAIR owner-portion — neither materialised in the
// owner ledger, so they must be computed live.
//
// This package is `type: module`; jest.mock(factory) does not hoist under ESM.
// Use jest.unstable_mockModule + dynamic import (see realmmanager.test.js).
import { jest } from '@jest/globals';

// Controlled occupancy: tenants returned by Collections.Tenant.find drive
// _occupiedPropertyIdsForTerm. Empty → every unit is vacant.
let TENANTS = [];

let computeOwnerEksodaByMonth;

beforeAll(async () => {
  class ServiceError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: {
      // _occupiedPropertyIdsForTerm: .find({...}).lean() → tenants
      Tenant: {
        find: () => ({ lean: async () => TENANTS })
      }
    },
    logger: { warn() {}, info() {}, error() {} },
    ServiceError
  }));
  // _attachTenantGroupsToBuildings hits the DB; the cases here use fixed /
  // thousandths allocation (which never read _tenantGroups), so a no-op that
  // sets an empty group list is faithful.
  jest.unstable_mockModule('../managers/occupantmanager.js', () => ({
    _attachTenantGroupsToBuildings: async (_realmId, buildings) => {
      buildings.forEach((b) => (b._tenantGroups = []));
    }
  }));

  ({ computeOwnerEksodaByMonth } = await import(
    '../managers/buildingmanager.js'
  ));
});

beforeEach(() => {
  TENANTS = [];
});

const term = (mm, year) => Number(`${year}${String(mm).padStart(2, '0')}0100`);

const mkUnit = (propertyId, extra = {}) => ({
  _id: `u_${propertyId}`,
  propertyId,
  isManaged: true,
  surface: 50,
  generalThousandths: 0,
  heatingThousandths: 0,
  elevatorThousandths: 0,
  owners: [],
  monthlyCharges: [],
  ...extra
});

describe('computeOwnerEksodaByMonth (live owner-borne eksoda)', () => {
  it('vacant FIXED expense (amount 0, cost in customAllocations) → owner owes €40+€10 from its startTerm onward', async () => {
    // Mirrors ΑΓ. ΟΔΟΣ ΕΨΙΛΟΝ 28: fixed expense €40 on p1 + €10 on p2, both
    // vacant, chargeOwnerWhenVacant ON, starts June 2026.
    const building = {
      _id: 'b_agan',
      realmId: 'r1',
      units: [mkUnit('p1'), mkUnit('p2'), mkUnit('p3')],
      expenses: [
        {
          _id: 'e_fixed',
          name: 'Ρεύμα',
          amount: 0,
          allocationMethod: 'fixed',
          isRecurring: true,
          startTerm: 2026060100,
          chargeOwnerWhenVacant: true,
          trackOwnerExpense: false,
          ownerAmount: 0,
          customAllocations: [
            { propertyId: 'p1', value: 40 },
            { propertyId: 'p2', value: 10 }
          ]
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: []
    };
    const { owedByTerm, paidByTerm } = await computeOwnerEksodaByMonth(
      'r1',
      building,
      2026
    );
    // Jan–May: expense not yet active → €0.
    expect(owedByTerm.get(term(5, 2026))).toBeUndefined();
    // June–Dec: €40 + €10 = €50 each, paid €0.
    for (let mm = 6; mm <= 12; mm++) {
      expect(owedByTerm.get(term(mm, 2026))).toBe(50);
      expect(paidByTerm.get(term(mm, 2026)) || 0).toBe(0);
    }
  });

  it('FIXED expense with an OCCUPIED unit → that unit billed to tenant, only the vacant unit is owner-borne', async () => {
    // p1 occupied (tenant covers term), p2 vacant → owner owes only p2's €10.
    TENANTS = [
      {
        _id: 't1',
        beginDate: '2025-01-01',
        endDate: '2027-01-01',
        properties: [{ propertyId: 'p1', entryDate: '2025-01-01' }]
      }
    ];
    const building = {
      _id: 'b2',
      realmId: 'r1',
      units: [mkUnit('p1'), mkUnit('p2')],
      expenses: [
        {
          _id: 'e_fixed',
          name: 'Ρεύμα',
          amount: 0,
          allocationMethod: 'fixed',
          isRecurring: true,
          startTerm: 2026010100,
          chargeOwnerWhenVacant: true,
          customAllocations: [
            { propertyId: 'p1', value: 40 },
            { propertyId: 'p2', value: 10 }
          ]
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: []
    };
    const { owedByTerm } = await computeOwnerEksodaByMonth('r1', building, 2026);
    expect(owedByTerm.get(term(6, 2026))).toBe(10); // only p2 (vacant)
  });

  it('split REPAIR → owner owes cost·(1−share%) at the chargeTerm only', async () => {
    // Mirrors ΟΔΟΣ ΗΤΑ 24: €100 repair, 50% tenant share → €50 owner portion,
    // chargeTerm May. Units carry no thousandths so the tenant-billed €50
    // distributes to €0 (no repair-vacant owner share); owner portion stands.
    const building = {
      _id: 'b_kal',
      realmId: 'r1',
      units: [mkUnit('p1'), mkUnit('p2')],
      expenses: [],
      repairs: [
        {
          _id: 'rep1',
          title: 'ασανσέρ',
          chargeableTo: 'split',
          estimatedCost: 100,
          actualCost: 100,
          tenantSharePercentage: 50,
          chargeTerm: 2026050100,
          status: 'planned',
          affectedUnitIds: []
        }
      ],
      ownerMonthlyExpenses: []
    };
    const { owedByTerm } = await computeOwnerEksodaByMonth('r1', building, 2026);
    expect(owedByTerm.get(term(5, 2026))).toBe(50);
    expect(owedByTerm.get(term(4, 2026))).toBeUndefined();
  });

  it('owners-only REPAIR → full cost to owner', async () => {
    const building = {
      _id: 'b3',
      realmId: 'r1',
      units: [mkUnit('p1')],
      expenses: [],
      repairs: [
        {
          _id: 'rep2',
          title: 'roof',
          chargeableTo: 'owners',
          actualCost: 300,
          chargeTerm: 2026030100,
          status: 'planned'
        }
      ],
      ownerMonthlyExpenses: []
    };
    const { owedByTerm } = await computeOwnerEksodaByMonth('r1', building, 2026);
    expect(owedByTerm.get(term(3, 2026))).toBe(300);
  });

  it('cancelled repair contributes nothing', async () => {
    const building = {
      _id: 'b4',
      realmId: 'r1',
      units: [mkUnit('p1')],
      expenses: [],
      repairs: [
        {
          _id: 'rep3',
          title: 'x',
          chargeableTo: 'owners',
          actualCost: 500,
          chargeTerm: 2026030100,
          status: 'cancelled'
        }
      ],
      ownerMonthlyExpenses: []
    };
    const { owedByTerm } = await computeOwnerEksodaByMonth('r1', building, 2026);
    expect(owedByTerm.get(term(3, 2026)) || 0).toBe(0);
  });

  it('SOURCE-OF-TRUTH: a materialised row wins — owed from row.amount, paid from its καταβολές, NOT double-counted with the live vacant share', async () => {
    // Same vacant fixed expense as case 1, but the owner ledger ALREADY has a
    // materialised source:'vacant' row for p1+e_fixed+June with €40 fully paid.
    // The live stream must NOT add another €40 for p1/June; owed stays €50
    // (€40 materialised + €10 live for p2), paid = €40 (the recorded payment).
    const building = {
      _id: 'b_mat',
      realmId: 'r1',
      units: [mkUnit('p1'), mkUnit('p2')],
      expenses: [
        {
          _id: 'e_fixed',
          name: 'Ρεύμα',
          amount: 0,
          allocationMethod: 'fixed',
          isRecurring: true,
          startTerm: 2026060100,
          chargeOwnerWhenVacant: true,
          customAllocations: [
            { propertyId: 'p1', value: 40 },
            { propertyId: 'p2', value: 10 }
          ]
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: [
        {
          _id: 'ome1',
          expenseId: 'e_fixed',
          propertyId: 'p1',
          term: 2026060100,
          amount: 40,
          source: 'vacant',
          paid: true,
          payments: [{ amount: 40, date: '2026-06-10' }]
        }
      ]
    };
    const { owedByTerm, paidByTerm } = await computeOwnerEksodaByMonth(
      'r1',
      building,
      2026
    );
    expect(owedByTerm.get(term(6, 2026))).toBe(50); // 40 (row) + 10 (live p2), not 90
    expect(paidByTerm.get(term(6, 2026))).toBe(40); // the recorded payment
  });

  it('manual source:expense row (variable owner amount) → owed + paid from the row', async () => {
    const building = {
      _id: 'b_man',
      realmId: 'r1',
      units: [mkUnit('p1')],
      expenses: [],
      repairs: [],
      ownerMonthlyExpenses: [
        {
          _id: 'ome2',
          expenseId: 'e_var',
          propertyId: null,
          term: 2026060100,
          amount: 0.21,
          source: 'expense',
          paid: false,
          payments: []
        }
      ]
    };
    const { owedByTerm, paidByTerm } = await computeOwnerEksodaByMonth(
      'r1',
      building,
      2026
    );
    expect(owedByTerm.get(term(6, 2026))).toBe(0.21);
    expect(paidByTerm.get(term(6, 2026)) || 0).toBe(0);
  });

  it('excludes liabilities outside the requested year', async () => {
    const building = {
      _id: 'b5',
      realmId: 'r1',
      units: [mkUnit('p1')],
      expenses: [],
      repairs: [
        {
          _id: 'rep4',
          title: 'old',
          chargeableTo: 'owners',
          actualCost: 100,
          chargeTerm: 2025030100,
          status: 'planned'
        }
      ],
      ownerMonthlyExpenses: []
    };
    const { owedByTerm } = await computeOwnerEksodaByMonth('r1', building, 2026);
    expect([...owedByTerm.values()].reduce((s, v) => s + v, 0)).toBe(0);
  });
});
