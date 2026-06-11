import * as BL from '../businesslogic/index.js';

/**
 * Regression test for the equal-allocation GROUP-CARRIER bug (audit
 * finding #1, HIGH).
 *
 * When a multi-unit tenant's lex-min "carrier" unit has exited but a
 * sibling unit is still active, the group used to:
 *   - stay in the denominator (activeGroups keeps any group with ANY
 *     active member), but
 *   - emit its share on the STATIC lex-min propertyId (the exited unit),
 *     which the outer rent loop never visits → the share silently
 *     vanished and the building under-collected.
 *
 * The fix selects the carrier as the lex-MIN propertyId that is ACTIVE
 * for the term, so the share lands on the still-billed sibling.
 *
 * This path is only reached when the building carries `_tenantGroups`
 * (attached in production by occupantmanager._attachTenantGroupsToBuildings);
 * the broader scenario suite exercises only the no-groups fallback, which
 * is why this class shipped uncaught.
 */
describe('Building charges — equal allocation group carrier (active-member)', () => {
  const TERM = '01/06/2024 00:00'; // June 2024

  const makeUnit = (propertyId, overrides = {}) => ({
    _id: `unit_${propertyId}`,
    propertyId,
    atakNumber: `ATAK_${propertyId}`,
    isManaged: true,
    surface: 80,
    generalThousandths: 0,
    heatingThousandths: 0,
    elevatorThousandths: 0,
    owners: [],
    monthlyCharges: [],
    ...overrides
  });

  const makeExpense = (name, amount, method) => ({
    _id: `exp_${name}`,
    name,
    type: 'common',
    amount,
    allocationMethod: method,
    isRecurring: true,
    // Recurring expense needs a startTerm (engine rejects falsy). Active
    // since Jan 2024, well before the June 2024 term under test.
    startTerm: 2024010100,
    customAllocations: []
  });

  // Build a building whose _tenantGroups model: tenant T owns {p1 (exited
  // 2024-03-31), p2 (active)}; tenant U owns {p3 (active)}. p1 is the
  // static lex-min of T's group but has exited by June.
  const makeBuildingWithGroups = (expense) => ({
    _id: 'bldg1',
    name: 'Building A',
    atakPrefix: '005578',
    units: [makeUnit('p1'), makeUnit('p2'), makeUnit('p3')],
    expenses: [expense],
    address: {},
    blockStreets: [],
    hasElevator: false,
    hasCentralHeating: false,
    contractors: [],
    repairs: [],
    _tenantGroups: [
      {
        propertyIds: ['p1', 'p2'],
        properties: [
          {
            propertyId: 'p1',
            entryDate: new Date('2024-01-01'),
            exitDate: new Date('2024-03-31') // p1 EXITED before June
          },
          {
            propertyId: 'p2',
            entryDate: new Date('2024-01-01'),
            exitDate: new Date('2024-12-31') // p2 still active
          }
        ],
        beginDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
        terminationDate: null
      },
      {
        propertyIds: ['p3'],
        properties: [
          {
            propertyId: 'p3',
            entryDate: new Date('2024-01-01'),
            exitDate: new Date('2024-12-31')
          }
        ],
        beginDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
        terminationDate: null
      }
    ]
  });

  const makeContract = (properties, building) => ({
    begin: new Date('2024-01-01'),
    end: new Date('2024-12-31'),
    frequency: 'months',
    properties,
    buildings: [building],
    rents: []
  });

  it('emits the group share on the still-active sibling when the lex-min carrier has exited', () => {
    const expense = makeExpense('Cleaning', 120, 'equal'); // 2 groups → 60 each
    const building = makeBuildingWithGroups(expense);

    // Tenant T's contract now only carries the still-active p2 (p1 exited).
    const propP2 = {
      propertyId: 'p2',
      rent: 500,
      expenses: [],
      entryDate: new Date('2024-01-01'),
      exitDate: new Date('2024-12-31'),
      property: { name: 'Prop p2' }
    };
    const rent = BL.computeRent(makeContract([propP2], building), TERM, null);

    // Before the fix: carrier was p1 (exited, never billed) → p2 got 0,
    // the whole 60 vanished. After: p2 (active lex-min of the group) is
    // the carrier and is billed the full group share.
    const cleaning = (rent.buildingCharges || []).find(
      (c) => c.description === 'Cleaning' || c.amount === 60
    );
    expect(cleaning).toBeTruthy();
    expect(cleaning.amount).toBe(60);
  });

  it('still bills the lone active group (p3) its half', () => {
    const expense = makeExpense('Cleaning', 120, 'equal');
    const building = makeBuildingWithGroups(expense);
    const propP3 = {
      propertyId: 'p3',
      rent: 500,
      expenses: [],
      entryDate: new Date('2024-01-01'),
      exitDate: new Date('2024-12-31'),
      property: { name: 'Prop p3' }
    };
    const rent = BL.computeRent(makeContract([propP3], building), TERM, null);
    const cleaning = (rent.buildingCharges || []).find((c) => c.amount === 60);
    expect(cleaning).toBeTruthy();
    expect(cleaning.amount).toBe(60);
  });

  // Audit finding #6: a recurring expense with a FALSY startTerm must bill
  // nothing (it used to bill every term back to epoch, invisible in the UI
  // which already guarded !startTerm).
  it('recurring expense with no startTerm bills nothing (not billed back to epoch)', () => {
    const expense = makeExpense('Cleaning', 120, 'equal');
    delete expense.startTerm; // the misconfigured legacy/seeded row
    const building = makeBuildingWithGroups(expense);
    const propP3 = {
      propertyId: 'p3',
      rent: 500,
      expenses: [],
      entryDate: new Date('2024-01-01'),
      exitDate: new Date('2024-12-31'),
      property: { name: 'Prop p3' }
    };
    const rent = BL.computeRent(makeContract([propP3], building), TERM, null);
    expect(rent.buildingCharges || []).toHaveLength(0);
  });
});
