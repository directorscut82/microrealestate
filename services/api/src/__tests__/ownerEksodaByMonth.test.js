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
  // Use the REAL OwnerStatement util (ownerSlicesOf etc.) — buildingmanager +
  // ownermanager import it from common; the mock must provide the genuine
  // implementation so the per-owner split logic under test is exercised.
  const OwnerStatement = await import(
    '../../../common/src/utils/ownerstatement.ts'
  );
  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: {
      // _occupiedPropertyIdsForTerm: .find({...}).lean() → tenants
      Tenant: {
        find: () => ({ lean: async () => TENANTS })
      }
    },
    logger: { warn() {}, info() {}, error() {} },
    ServiceError,
    OwnerStatement
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

  it('STALE-VACANT GUARD: a materialised vacant row for a now-OCCUPIED unit is NOT counted (owner-is-also-renter double-count)', async () => {
    // p1 occupied in June by a tenant; but a stale source:'vacant' row for
    // p1+June survives (recompute only ran for the current term). It must be
    // dropped so the €40 is not billed as owner eksoda AND to the tenant.
    TENANTS = [
      {
        _id: 't1',
        beginDate: '2025-01-01',
        endDate: '2027-01-01',
        properties: [{ propertyId: 'p1', entryDate: '2025-01-01' }]
      }
    ];
    const building = {
      _id: 'b_stale',
      realmId: 'r1',
      units: [mkUnit('p1')],
      expenses: [
        {
          _id: 'e_fixed',
          name: 'Ρεύμα',
          amount: 0,
          allocationMethod: 'fixed',
          isRecurring: true,
          startTerm: 2026010100,
          chargeOwnerWhenVacant: true,
          customAllocations: [{ propertyId: 'p1', value: 40 }]
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: [
        {
          _id: 'stale1',
          expenseId: 'e_fixed',
          propertyId: 'p1',
          term: 2026060100,
          amount: 40,
          source: 'vacant',
          paid: false,
          payments: []
        }
      ]
    };
    const { owedByTerm } = await computeOwnerEksodaByMonth('r1', building, 2026);
    // p1 is occupied in June → the stale vacant row is dropped, owner owes €0.
    expect(owedByTerm.get(term(6, 2026)) || 0).toBe(0);
  });

  it('REPAIR-VACANT survives occupancy: a repair-vacant row on a now-OCCUPIED unit is STILL owed by the owner (it is never re-billed to the tenant)', async () => {
    // Adversarial finding (June 2026): unlike a building-expense 'vacant' row
    // (live-rederived into the occupied tenant's rent), a 'repair-vacant' row
    // is materialised once by _distributeRepairCharge and NEVER re-billed to a
    // later tenant. Dropping it on occupancy would make the repair share vanish
    // from BOTH owner eksoda AND tenant rent. It must persist.
    TENANTS = [
      {
        _id: 't1',
        beginDate: '2025-01-01',
        endDate: '2027-01-01',
        properties: [{ propertyId: 'p1', entryDate: '2025-01-01' }]
      }
    ];
    const building = {
      _id: 'b_rv',
      realmId: 'r1',
      units: [mkUnit('p1')],
      expenses: [],
      repairs: [
        {
          _id: 'rep1',
          title: 'ασανσέρ',
          chargeableTo: 'split',
          actualCost: 100,
          tenantSharePercentage: 50,
          chargeTerm: 2026060100,
          status: 'planned'
        }
      ],
      ownerMonthlyExpenses: [
        {
          _id: 'rv1',
          expenseId: 'rep1',
          propertyId: 'p1',
          term: 2026060100,
          amount: 25,
          source: 'repair-vacant',
          paid: false,
          payments: []
        }
      ]
    };
    const { owedByTerm } = await computeOwnerEksodaByMonth('r1', building, 2026);
    // The owner owes BOTH: the live repair owner-portion (cost·(1−50%) = €50,
    // a building-wide source:'repair') AND the materialised repair-vacant €25
    // (the vacant unit's tenant-share that was never billed to anyone). The
    // €25 MUST survive p1 being occupied in June — it is not re-billed to the
    // new tenant. Total €75. (Before the fix the €25 was wrongly dropped → €50.)
    expect(owedByTerm.get(term(6, 2026))).toBe(75);
  });

  it('STALE-VACANT GUARD: a vacant row whose expense turned chargeOwnerWhenVacant OFF is dropped', async () => {
    const building = {
      _id: 'b_off',
      realmId: 'r1',
      units: [mkUnit('p1')],
      expenses: [
        {
          _id: 'e_fixed',
          name: 'Ρεύμα',
          amount: 0,
          allocationMethod: 'fixed',
          isRecurring: true,
          startTerm: 2026010100,
          chargeOwnerWhenVacant: false, // flag turned OFF
          customAllocations: [{ propertyId: 'p1', value: 40 }]
        }
      ],
      repairs: [],
      ownerMonthlyExpenses: [
        {
          _id: 'stale2',
          expenseId: 'e_fixed',
          propertyId: 'p1',
          term: 2026060100,
          amount: 40,
          source: 'vacant',
          paid: false,
          payments: []
        }
      ]
    };
    const { owedByTerm } = await computeOwnerEksodaByMonth('r1', building, 2026);
    expect(owedByTerm.get(term(6, 2026)) || 0).toBe(0);
  });

  it('detailByTerm: emits per-(owner,category) breakdown lines incl. repairs', async () => {
    const building = {
      _id: 'b_detail',
      realmId: 'r1',
      units: [
        mkUnit('p1', { owners: [{ name: 'ΒΗΤΑ', percentage: 100 }] }),
        mkUnit('p2', { owners: [{ name: 'ΒΗΤΑ', percentage: 100 }] })
      ],
      expenses: [
        {
          _id: 'e_fixed',
          name: 'Ρεύμα',
          type: 'electricity_common',
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
      repairs: [
        {
          _id: 'rep1',
          title: 'ασανσέρ',
          chargeableTo: 'owners',
          actualCost: 100,
          chargeTerm: 2026060100,
          status: 'planned'
        }
      ],
      ownerMonthlyExpenses: []
    };
    const { detailByTerm } = await computeOwnerEksodaByMonth('r1', building, 2026);
    const june = detailByTerm.get(term(6, 2026)) || [];
    // electricity vacant shares (p1+p2, both owned by ΒΗΤΑ → merged) + repair.
    const elec = june.find((d) => d.category === 'electricity_common');
    const repair = june.find((d) => d.category === 'repair');
    expect(elec).toBeTruthy();
    expect(elec.ownerName).toBe('ΒΗΤΑ');
    expect(elec.owed).toBe(50); // 40 + 10 merged
    expect(repair).toBeTruthy();
    expect(repair.owed).toBe(100);
    expect(repair.ownerName).toBeNull(); // building-wide owner-portion
  });
});

describe('ownerSlicesOf (per-owner € split by percentage)', () => {
  let ownerSlicesOf;
  beforeAll(async () => {
    ({ ownerSlicesOf } = await import('../managers/ownermanager.js'));
  });

  it('splits by declared percentages with carrier-remainder summing exactly', () => {
    const slices = ownerSlicesOf(
      [
        { name: 'A', taxId: '1', percentage: 50 },
        { name: 'B', taxId: '2', percentage: 50 }
      ],
      100
    );
    expect(slices).toHaveLength(2);
    expect(slices[0].amount + slices[1].amount).toBe(100);
    expect(slices[0].percentage).toBe(50);
  });

  it('equal-splits when percentages are absent', () => {
    const slices = ownerSlicesOf(
      [
        { name: 'A', taxId: '1' },
        { name: 'B', taxId: '2' },
        { name: 'C', taxId: '3' }
      ],
      90
    );
    expect(slices).toHaveLength(3);
    expect(slices.reduce((s, x) => s + x.amount, 0)).toBe(90);
  });

  it('carrier-remainder: 100 split 3 ways sums to exactly 100', () => {
    const slices = ownerSlicesOf(
      [
        { name: 'A', taxId: '1', percentage: 33.33 },
        { name: 'B', taxId: '2', percentage: 33.33 },
        { name: 'C', taxId: '3', percentage: 33.34 }
      ],
      100
    );
    expect(slices.reduce((s, x) => s + x.amount, 0)).toBe(100);
  });

  it('skips identity-less owners', () => {
    const slices = ownerSlicesOf(
      [{ name: '', taxId: '' }, { name: 'A', taxId: '1', percentage: 100 }],
      50
    );
    expect(slices).toHaveLength(1);
    expect(slices[0].name).toBe('A');
    expect(slices[0].amount).toBe(50);
  });

  it('preserves DECLARED split + appends a "rest" slice for the un-identified remainder (40/40 named + 20 nameless → 40/40/rest-20)', () => {
    // pctSum over the FULL declared set so named 40%/40% are NOT re-normalised
    // to 50/50; the nameless 20% becomes a synthetic isRest slice so the split
    // reconciles to the full €100 and "(40%)" never sits next to a full share.
    const slices = ownerSlicesOf(
      [
        { name: 'A', taxId: '1', percentage: 40 },
        { name: 'B', taxId: '2', percentage: 40 },
        { name: '', taxId: '', percentage: 20 } // nameless co-owner
      ],
      100
    );
    expect(slices).toHaveLength(3); // A, B, + rest
    expect(slices[0].percentage).toBe(40);
    expect(slices[0].amount).toBe(40);
    expect(slices[1].percentage).toBe(40);
    expect(slices[1].amount).toBe(40); // NOT 50 — declared share preserved
    const rest = slices[2];
    expect(rest.isRest).toBe(true);
    expect(rest.percentage).toBe(20);
    expect(rest.amount).toBe(20);
    // slices reconcile to the full amount
    expect(slices.reduce((s, x) => s + x.amount, 0)).toBe(100);
  });

  it('sole 50% owner (co-owner absent) → owner slice + rest slice, reconciling to full', () => {
    const slices = ownerSlicesOf([{ name: 'A', taxId: '1', percentage: 50 }], 80);
    expect(slices).toHaveLength(2);
    expect(slices[0].name).toBe('A');
    expect(slices[0].amount).toBe(40);
    expect(slices[1].isRest).toBe(true);
    expect(slices[1].amount).toBe(40);
  });

  it('keeps a memberId-only owner (identity via memberId, no name/taxId)', () => {
    const slices = ownerSlicesOf(
      [
        { memberId: 'M1', percentage: 50 },
        { name: 'B', taxId: '2', percentage: 50 }
      ],
      100
    );
    expect(slices).toHaveLength(2); // member-only owner kept
    expect(slices[0].amount + slices[1].amount).toBe(100);
  });

  it('clamps a negative / >100 percentage so no negative € slice renders', () => {
    const slices = ownerSlicesOf(
      [
        { name: 'A', taxId: '1', percentage: -50 },
        { name: 'B', taxId: '2', percentage: 150 }
      ],
      100
    );
    // -50 clamps to 0, 150 clamps to 100 → fullPctSum 100 → declared. No
    // negative amounts.
    for (const s of slices) {
      expect(s.amount).toBeGreaterThanOrEqual(0);
      expect(s.percentage).toBeGreaterThanOrEqual(0);
      expect(s.percentage).toBeLessThanOrEqual(100);
    }
  });
});
