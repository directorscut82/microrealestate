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

  // H11 (round-1 audit): a FIXED-allocation expense whose top-level amount is 0
  // (the per-unit shares live in customAllocations, a canonical config the
  // validators accept) is BILLED by the rent engine and COUNTED by the
  // dashboard, but was DROPPED from this breakdown by the `total <= 0 continue`
  // guard — which has no fixed-allocation exemption (unlike the engine at
  // 1_base _computeBuildingChargeRaw, which special-cases `fixed`). The three
  // surfaces must agree. After the fix the fixed/amount-0 row appears here too.
  it('H11: fixed-allocation expense with amount=0 still appears in the breakdown', () => {
    const b = {
      _id: 'bh11', name: 'BH11', atakPrefix: '005578',
      units: [
        { ...makeUnit('p1'), property: { name: 'Apt 1' }, tenant: { _id: 't1', name: 'Alice' } },
        { ...makeUnit('p2'), property: { name: 'Apt 2' }, tenant: { _id: 't2', name: 'Bob' } }
      ],
      // amount:0, fixed, with per-unit customAllocations (Alice €30, Bob €20).
      expenses: [{
        _id: 'fx1', name: 'Doorman', type: 'common', amount: 0,
        allocationMethod: 'fixed', isRecurring: true, startTerm: 2024010100,
        customAllocations: [
          { propertyId: 'p1', value: 30 },
          { propertyId: 'p2', value: 20 }
        ]
      }],
      address: {}, blockStreets: [], contractors: [], repairs: [], ownerMonthlyExpenses: []
    };
    const r = computeBuildingExpenseBreakdown(b, 2024060100);
    const byProp = Object.fromEntries(r.rows.map((x) => [x.propertyId, x]));
    // FAILING-FIRST: today the fixed/amount-0 rows are dropped → byProp.p1 is
    // undefined and tenantTotal is 0.
    expect(byProp.p1).toBeDefined();
    expect(byProp.p1.amount).toBe(30);
    expect(byProp.p2.amount).toBe(20);
    expect(r.tenantTotal).toBe(50); // both billed to renters, matching the engine
  });

  // §1.8: a flag-OFF repair's vacant-unit share is billed to NOBODY (no rent
  // term, flag off) → it must surface in the breakdown as recipient:'owner',
  // ownerBilled:false (Αχρέωτα) instead of silently evaporating. Flag-ON repairs
  // materialise a persisted source:'repair-vacant' owner row (surfaced via
  // ownerDirect, NOT the engine) so the engine must NOT also emit them (double-count).
  it('§1.8: flag-OFF repair vacant share surfaces as owner-UNCOLLECTED (Αχρέωτα)', () => {
    const mk = (chargeOwnerWhenVacant) => ({
      _id: 'br18', name: 'BR18', atakPrefix: '005578',
      units: [
        { ...makeUnit('o1', { generalThousandths: 500 }), property: { name: 'Occ' }, tenant: { _id: 't1', name: 'Alice' } },
        { ...makeUnit('v1', { generalThousandths: 500 }), property: { name: 'Vac' }, tenant: null } // vacant
      ],
      expenses: [],
      repairs: [{
        _id: 'rep1', title: 'Elevator', category: 'elevator', status: 'planned',
        chargeableTo: 'tenants', tenantSharePercentage: 100, allocationMethod: 'general_thousandths',
        chargeTerm: 2024060100, actualCost: 200, affectedUnitIds: [],
        chargeOwnerWhenVacant
      }],
      address: {}, blockStreets: [], contractors: [], ownerMonthlyExpenses: []
    });
    // Flag OFF: the vacant unit's €100 share (200 × 500/1000) is uncollected.
    const off = computeBuildingExpenseBreakdown(mk(false), 2024060100);
    const vacRow = off.rows.find((r) => r.propertyId === 'v1' && r.expenseType === 'repair');
    expect(vacRow).toBeDefined(); // flag-off repair vacant row present
    expect(vacRow.recipient).toBe('owner');
    expect(vacRow.ownerBilled).toBe(false); // Αχρέωτα
    expect(vacRow.amount).toBe(100);
    expect(vacRow.basis.kind).toBe('repair_vacant');
    expect(vacRow.basis.pool).toBe(200); // 200 × 100%
    expect(off.ownerUnbilledTotal).toBe(100); // surfaces in the uncollected total
    // NOTE: the occupied unit's repair tenant-charge is NOT emitted by the
    // engine here — repairs reach tenants only via a persisted monthlyCharge
    // written by _distributeRepairCharge (section 2), which this pure-engine
    // fixture has none of. §1.8 is solely the vacant-Αχρέωτα emission; the
    // occupied/tenant side is the distributor's job and is covered elsewhere
    // (spec 51 / repairCancelUncancel). So we only assert the vacant row here.
    const engineEmittedOccRepair = off.rows.find(
      (r) => r.propertyId === 'o1' && r.expenseType === 'repair'
    );
    expect(engineEmittedOccRepair).toBeUndefined();

    // Flag ON: the engine must NOT emit a vacant repair row (the flag-on path
    // persists a source:'repair-vacant' owner row elsewhere; emitting here too
    // would double-count). So no engine repair row for the vacant unit.
    const on = computeBuildingExpenseBreakdown(mk(true), 2024060100);
    const onVac = on.rows.find((r) => r.propertyId === 'v1' && r.expenseType === 'repair');
    expect(onVac).toBeUndefined(); // flag-on must NOT emit an engine vacant repair row
    expect(on.ownerUnbilledTotal).toBe(0);
  });

  it('§1.8: a cancelled / zero-cost / owners-only repair contributes no Αχρέωτα', () => {
    const base = (repairOverrides) => ({
      _id: 'br18b', name: 'BR18b', atakPrefix: '005578',
      units: [
        { ...makeUnit('v1', { generalThousandths: 1000 }), property: { name: 'Vac' }, tenant: null }
      ],
      expenses: [],
      repairs: [{
        _id: 'rep1', title: 'X', category: 'general', status: 'planned',
        chargeableTo: 'tenants', tenantSharePercentage: 100, allocationMethod: 'general_thousandths',
        chargeTerm: 2024060100, actualCost: 200, affectedUnitIds: [], chargeOwnerWhenVacant: false,
        ...repairOverrides
      }],
      address: {}, blockStreets: [], contractors: [], ownerMonthlyExpenses: []
    });
    // cancelled → nothing
    expect(computeBuildingExpenseBreakdown(base({ status: 'cancelled' }), 2024060100).ownerUnbilledTotal).toBe(0);
    // zero cost → nothing
    expect(computeBuildingExpenseBreakdown(base({ actualCost: 0, estimatedCost: 0 }), 2024060100).ownerUnbilledTotal).toBe(0);
    // owners-only (tenantPct 0) → no tenant pool → no vacant Αχρέωτα slice
    expect(computeBuildingExpenseBreakdown(base({ chargeableTo: 'owners' }), 2024060100).ownerUnbilledTotal).toBe(0);
    // wrong term → nothing
    expect(computeBuildingExpenseBreakdown(base({ chargeTerm: 2024070100 }), 2024060100).ownerUnbilledTotal).toBe(0);
  });

  // §1.8 double-count guard (Step-7): a repair distributed while the unit was
  // OCCUPIED persisted a tenant monthlyCharge {repairId, term, amount}. If the
  // tenant later moved out (unit vacant for the term) that charge is stale but
  // section 2 still surfaces it as owner-uncollected. §1.8 must NOT re-emit the
  // same repair's share — else Αχρέωτα doubles. The share surfaces EXACTLY ONCE.
  it('§1.8: a stale repair monthlyCharge on a now-vacant unit surfaces ONCE (no double-count)', () => {
    const b = {
      _id: 'br18c', name: 'BR18c', atakPrefix: '005578',
      units: [
        {
          ...makeUnit('v1', { generalThousandths: 1000 }),
          property: { name: 'Vac' },
          tenant: null, // vacant for the term now
          // stale tenant repair charge written when v1 was occupied
          monthlyCharges: [
            { term: 2024060100, amount: 100, description: 'Repair: Elevator', repairId: 'rep1' }
          ]
        }
      ],
      expenses: [],
      repairs: [{
        _id: 'rep1', title: 'Elevator', category: 'elevator', status: 'planned',
        chargeableTo: 'tenants', tenantSharePercentage: 100, allocationMethod: 'general_thousandths',
        chargeTerm: 2024060100, actualCost: 100, affectedUnitIds: [], chargeOwnerWhenVacant: false
      }],
      address: {}, blockStreets: [], contractors: [], ownerMonthlyExpenses: []
    };
    const r = computeBuildingExpenseBreakdown(b, 2024060100);
    const repairRows = r.rows.filter(
      (x) => x.propertyId === 'v1' && (x.expenseType === 'repair' || String(x.expenseId) === 'rep1')
    );
    // EXACTLY ONE repair row for v1 (the stale section-2 row), NOT two.
    expect(repairRows.length).toBe(1);
    expect(r.ownerUnbilledTotal).toBe(100); // €100, not €200
  });

  // Round-1 audit M2: the thousandths basis `whole` (the printed denominator)
  // must reduce over ALL building.units — the SAME denominator the engine bills
  // with — so the equation part ÷ whole × total reconciles to the billed share
  // when an UNMANAGED unit (no propertyId) carries thousandths.
  it('M2: thousandths basis `whole` uses the full-building denominator', () => {
    const b = {
      _id: 'bm2', name: 'BM2', atakPrefix: '005578',
      units: [
        // managed unit (500‰), tenant-occupied
        { ...makeUnit('p1', { generalThousandths: 500 }), property: { name: 'Apt 1' }, tenant: { _id: 't1', name: 'Alice' } },
        // UNMANAGED unit (no propertyId) carrying the other 500‰
        { _id: 'u_unmanaged', atakNumber: 'ATAK_u', isManaged: false, surface: 50, generalThousandths: 500, heatingThousandths: 0, elevatorThousandths: 0, floor: 1, owners: [], monthlyCharges: [] }
      ],
      expenses: [{ _id: 'e1', name: 'Cleaning', type: 'common', amount: 100, allocationMethod: 'general_thousandths', isRecurring: true, startTerm: 2024010100, customAllocations: [] }],
      address: {}, blockStreets: [], contractors: [], repairs: [], ownerMonthlyExpenses: []
    };
    const r = computeBuildingExpenseBreakdown(b, 2024060100);
    const row = r.rows.find((x) => x.propertyId === 'p1');
    expect(row).toBeDefined();
    // Engine bills 100 × 500/1000 = 50 for the managed unit.
    expect(row.amount).toBe(50);
    // FAILING-FIRST: basis.whole was 500 (managed-only) → 100×500/500=100 ≠ 50.
    // After the fix whole=1000 (full building) → 100×500/1000=50 = billed share.
    expect(row.basis.kind).toBe('thousandths');
    expect(row.basis.whole).toBe(1000);
    expect(row.basis.part).toBe(500);
    // The equation now reconciles: part/whole*total === amount.
    expect((row.basis.part / row.basis.whole) * row.basis.total).toBeCloseTo(row.amount, 2);
  });
});
