import { computeBuildingExpenseBreakdown } from '../businesslogic/tasks/1_base.ts';

// The breakdown must (a) use the real engine so shares match billing, and
// (b) correctly label renter vs owner(vacant). Build a 3-unit building, an
// equal expense of 90, with p1+p2 tenanted and p3 vacant.
const makeUnit = (propertyId, o) => ({
  _id: `unit_${propertyId}`, propertyId, atakNumber: `ATAK_${propertyId}`,
  isManaged: true, surface: 50, generalThousandths: 0, heatingThousandths: 0,
  elevatorThousandths: 0, floor: 1, owners: [], monthlyCharges: [], ...o
});

const building = {
  _id: 'b1', name: 'B', atakPrefix: '005578',
  units: [
    { ...makeUnit('p1'), property: { name: 'Apt 1' }, tenant: { _id: 't1', name: 'Alice' } },
    { ...makeUnit('p2'), property: { name: 'Apt 2' }, tenant: { _id: 't2', name: 'Bob' } },
    { ...makeUnit('p3'), property: { name: 'Apt 3' }, tenant: null } // vacant
  ],
  expenses: [{ _id: 'e1', name: 'Cleaning', type: 'common', amount: 90, allocationMethod: 'equal', isRecurring: true, startTerm: 2024010100, customAllocations: [] }],
  address: {}, blockStreets: [], contractors: [], repairs: [], ownerMonthlyExpenses: []
};

describe('computeBuildingExpenseBreakdown', () => {
  it('labels renter vs vacant-owner and shares match the engine (90/3=30 each)', () => {
    const b = computeBuildingExpenseBreakdown(building, 2024060100);
    const byProp = Object.fromEntries(b.rows.map(r => [r.propertyId, r]));
    expect(byProp.p1.recipient).toBe('renter');
    expect(byProp.p1.recipientName).toBe('Alice');
    expect(byProp.p1.amount).toBe(30);
    expect(byProp.p2.recipient).toBe('renter');
    expect(byProp.p2.amount).toBe(30);
    expect(byProp.p3.recipient).toBe('owner'); // vacant
    expect(byProp.p3.amount).toBe(30);
    expect(b.tenantTotal).toBe(60);        // p1 + p2 billed
    expect(b.ownerUnbilledTotal).toBe(30); // p3 vacant share evaporates
  });

  // Regression for #1 (variable) + #8 (repair): a VARIABLE expense stores
  // its amount in unit.monthlyCharges (expense.amount is 0), and a repair
  // distribution also lands in monthlyCharges with a repairId. The old
  // breakdown iterated building.expenses only → both were INVISIBLE. The
  // rewrite reads monthlyCharges too.
  it('surfaces VARIABLE statement charges and REPAIR charges from monthlyCharges', () => {
    const b2 = {
      _id: 'b2', name: 'B2', atakPrefix: '005578',
      units: [
        {
          ...makeUnit('q1'),
          property: { name: 'Apt Q1' },
          tenant: { _id: 't9', name: 'Carol' },
          monthlyCharges: [
            // variable expense share (expenseId, no repairId)
            { term: 2024060100, amount: 12, inputAmount: 12, description: 'Water', expenseId: 'var1' },
            // repair distribution (repairId)
            { term: 2024060100, amount: 40, description: 'Repair: Elevator', repairId: 'rep1' }
          ]
        }
      ],
      // var1 exists as a variable expense (amount 0 → not billed via path #1)
      expenses: [{ _id: 'var1', name: 'Water', type: 'water_common', amount: 0, allocationMethod: 'equal', isRecurring: true, startTerm: 2024010100, customAllocations: [] }],
      address: {}, blockStreets: [], contractors: [], repairs: [], ownerMonthlyExpenses: []
    };
    const r = computeBuildingExpenseBreakdown(b2, 2024060100);
    const names = r.rows.map((x) => x.expenseName).sort();
    expect(names).toContain('Water');          // #1 variable now visible
    expect(names).toContain('Repair: Elevator'); // #8 repair now visible
    // Both billed to the renter (unit has a tenant), total 52.
    expect(r.tenantTotal).toBe(52);
    expect(r.ownerUnbilledTotal).toBe(0);
  });
});
