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

  // VAC-EQUAL-NOOP regression. The PRODUCTION path attaches _tenantGroups
  // (one group per OCCUPIED unit) before calling the engine. The vacant unit
  // has NO group, so the old `equal` branch returned 0 for it AND divided the
  // pool by occupied-count only — a 3-unit/1-vacant building with a €90 equal
  // expense billed the two tenants €45 each and the vacant unit's owner share
  // was 0 (the chargeOwnerWhenVacant feature was a no-op for `equal`). The fix
  // counts the vacant managed unit as its own equal-split party: €30 each, the
  // vacant €30 routed to the owner. This test exercises the GROUPED path (the
  // un-grouped fixtures above hit the per-managed-unit fallback that always
  // divided by 3 and so never reproduced the bug).
  it('VAC-EQUAL-NOOP: grouped equal split counts the vacant unit as a party (90/3=30, not 90/2=45)', () => {
    const b = {
      _id: 'bg', name: 'BG', atakPrefix: '005578',
      units: [
        { ...makeUnit('g1'), property: { name: 'Apt 1' }, tenant: { _id: 't1', name: 'Alice' } },
        { ...makeUnit('g2'), property: { name: 'Apt 2' }, tenant: { _id: 't2', name: 'Bob' } },
        { ...makeUnit('g3'), property: { name: 'Apt 3' }, tenant: null } // vacant
      ],
      expenses: [{ _id: 'e1', name: 'Cleaning', type: 'cleaning', amount: 90, allocationMethod: 'equal', isRecurring: true, startTerm: 2024010100, chargeOwnerWhenVacant: true, customAllocations: [] }],
      address: {}, blockStreets: [], contractors: [], repairs: [], ownerMonthlyExpenses: [],
      // Production grouping: one group per OCCUPIED unit; vacant g3 has none.
      _tenantGroups: [
        { propertyIds: ['g1'], properties: [{ propertyId: 'g1' }], beginDate: null, endDate: null, terminationDate: null },
        { propertyIds: ['g2'], properties: [{ propertyId: 'g2' }], beginDate: null, endDate: null, terminationDate: null }
      ]
    };
    const r = computeBuildingExpenseBreakdown(b, 2024060100);
    const byProp = Object.fromEntries(r.rows.map((x) => [x.propertyId, x]));
    expect(byProp.g1.amount).toBe(30); // NOT 45
    expect(byProp.g2.amount).toBe(30); // NOT 45
    expect(byProp.g3.recipient).toBe('owner');
    expect(byProp.g3.amount).toBe(30); // vacant unit IS a party now
    expect(r.tenantTotal).toBe(60);
    expect(r.ownerBilledTotal).toBe(30); // owner billed for the vacant unit
    expect(r.ownerUnbilledTotal).toBe(0);
  });

  // VAC-EQUAL-NOOP — partial exit. A multi-unit tenant (g1+g2) gives up g2
  // mid-lease (g2's per-property window no longer covers the term) while
  // keeping g1. g2 is vacant THIS term even though the group still lists it.
  // It must be treated as a vacant party, not silently zeroed by the
  // "is it in some active group" check. 3 parties (g1 tenant, g3 tenant, g2
  // vacant) → €90/3 = €30 each.
  it('VAC-EQUAL-NOOP: a partially-exited unit is a vacant party, not zeroed', () => {
    const term = 2024060100;
    const b = {
      _id: 'bpe', name: 'BPE', atakPrefix: '005578',
      units: [
        { ...makeUnit('g1'), property: { name: 'Apt 1' }, tenant: { _id: 't1', name: 'Alice' } },
        { ...makeUnit('g2'), property: { name: 'Apt 2' }, tenant: null },
        { ...makeUnit('g3'), property: { name: 'Apt 3' }, tenant: { _id: 't3', name: 'Carol' } }
      ],
      expenses: [{ _id: 'e1', name: 'Cleaning', type: 'cleaning', amount: 90, allocationMethod: 'equal', isRecurring: true, startTerm: 2024010100, chargeOwnerWhenVacant: true, customAllocations: [] }],
      address: {}, blockStreets: [], contractors: [], repairs: [], ownerMonthlyExpenses: [],
      // Alice's group still lists g2, but g2's per-property window ended in
      // May so it is NOT active for the June term. g3 is its own active group.
      _tenantGroups: [
        {
          propertyIds: ['g1', 'g2'],
          properties: [
            { propertyId: 'g1', entryDate: null, exitDate: null },
            { propertyId: 'g2', entryDate: null, exitDate: new Date('2024-05-31T00:00:00Z') }
          ],
          beginDate: null, endDate: null, terminationDate: null
        },
        { propertyIds: ['g3'], properties: [{ propertyId: 'g3' }], beginDate: null, endDate: null, terminationDate: null }
      ]
    };
    const r = computeBuildingExpenseBreakdown(b, term);
    const byProp = Object.fromEntries(r.rows.map((x) => [x.propertyId, x]));
    expect(byProp.g1.amount).toBe(30);
    expect(byProp.g3.amount).toBe(30);
    // g2 is vacant (window exited) → owner party, €30, not absorbed or zeroed.
    expect(byProp.g2?.recipient).toBe('owner');
    expect(byProp.g2.amount).toBe(30);
    expect(r.tenantTotal).toBe(60);
    expect(r.ownerBilledTotal).toBe(30);
  });

  // #2/#3: chargeOwnerWhenVacant routes a vacant unit's share to the owner
  // (ownerBilled) instead of leaving it uncollected.
  it('vacant share is OWNER-BILLED when chargeOwnerWhenVacant is on, UNCOLLECTED when off', () => {
    const mk = (chargeOwnerWhenVacant) => ({
      _id: 'b3', name: 'B3', atakPrefix: '005578',
      units: [
        { ...makeUnit('r1'), property: { name: 'A' }, tenant: { _id: 't1', name: 'A' } },
        { ...makeUnit('r2'), property: { name: 'B' }, tenant: null } // vacant
      ],
      expenses: [{ _id: 'e1', name: 'Cleaning', type: 'common', amount: 100, allocationMethod: 'equal', isRecurring: true, startTerm: 2024010100, chargeOwnerWhenVacant, customAllocations: [] }],
      address: {}, blockStreets: [], contractors: [], repairs: [], ownerMonthlyExpenses: []
    });
    const on = computeBuildingExpenseBreakdown(mk(true), 2024060100);
    expect(on.ownerBilledTotal).toBe(50);   // vacant r2 share → owner
    expect(on.ownerUnbilledTotal).toBe(0);
    const off = computeBuildingExpenseBreakdown(mk(false), 2024060100);
    expect(off.ownerBilledTotal).toBe(0);
    expect(off.ownerUnbilledTotal).toBe(50); // vacant r2 share uncollected
  });
});
