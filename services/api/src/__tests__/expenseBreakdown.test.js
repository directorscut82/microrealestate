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
});
