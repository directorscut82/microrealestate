/* eslint-env node, jest */
// Tests the shared common/OwnerStatement.buildOwnerStatement — the data source
// for the owner expense statement PDF. It MUST attribute charges to the same
// canonical owner the on-screen ledger does (ownermanager._aggregateOwners) so
// the PDF and the UI never diverge. Pure function, no DB.
import {
  buildOwnerStatement,
  ownerKeyOf
} from '../../../common/src/utils/ownerstatement.ts';

const mkUnit = (propertyId, owners, extra = {}) => ({
  _id: `u_${propertyId}`,
  propertyId,
  owners,
  ...extra
});

describe('buildOwnerStatement', () => {
  it('attributes a propertyId-scoped charge to the canonical (lex-first) owner', () => {
    const beta = { name: 'ΒΗΤΑ', taxId: '111' };
    const buildings = [
      {
        _id: 'b1',
        name: 'ΑΓ. ΟΔΟΣ ΕΨΙΛΟΝ',
        expenses: [{ _id: 'e1', type: 'electricity_common' }],
        units: [mkUnit('p1', [beta])],
        ownerMonthlyExpenses: [
          {
            _id: 'ome1',
            expenseId: 'e1',
            propertyId: 'p1',
            term: 2026060100,
            amount: 40,
            source: 'vacant',
            paid: false,
            payments: []
          }
        ]
      }
    ];
    const key = ownerKeyOf(beta);
    const st = buildOwnerStatement(buildings, key, []);
    expect(st.owner.name).toBe('ΒΗΤΑ');
    expect(st.owner.taxId).toBe('111');
    expect(st.charges).toHaveLength(1);
    expect(st.charges[0].amount).toBe(40);
    expect(st.charges[0].expenseType).toBe('electricity_common');
    expect(st.totals.amount).toBe(40);
    expect(st.totals.outstanding).toBe(40);
  });

  it('repair rows are typed repair and strip the English "Repair:" prefix', () => {
    const owner = { name: 'A', taxId: '1' };
    const buildings = [
      {
        _id: 'b1',
        name: 'B',
        expenses: [],
        units: [mkUnit('p1', [owner])],
        ownerMonthlyExpenses: [
          {
            _id: 'r1',
            expenseId: 'rep1',
            propertyId: 'p1',
            term: 2026050100,
            amount: 50,
            source: 'repair-vacant',
            description: 'Repair: ασανσέρ',
            paid: true,
            payments: [{ amount: 50 }]
          }
        ]
      }
    ];
    const st = buildOwnerStatement(buildings, ownerKeyOf(owner), []);
    expect(st.charges[0].expenseType).toBe('repair');
    expect(st.charges[0].description).toBe('ασανσέρ'); // prefix stripped
    expect(st.charges[0].paid).toBe(true);
    expect(st.totals.paid).toBe(50);
  });

  it('filters by requested terms', () => {
    const owner = { name: 'A', taxId: '1' };
    const buildings = [
      {
        _id: 'b1',
        name: 'B',
        expenses: [{ _id: 'e1', type: 'water_common' }],
        units: [mkUnit('p1', [owner])],
        ownerMonthlyExpenses: [
          { _id: 'a', expenseId: 'e1', propertyId: 'p1', term: 2026050100, amount: 10, source: 'vacant', payments: [] },
          { _id: 'b', expenseId: 'e1', propertyId: 'p1', term: 2026060100, amount: 20, source: 'vacant', payments: [] }
        ]
      }
    ];
    const st = buildOwnerStatement(buildings, ownerKeyOf(owner), [2026060100]);
    expect(st.charges).toHaveLength(1);
    expect(st.charges[0].amount).toBe(20);
  });

  it('does NOT attribute a co-owned charge to the non-canonical owner', () => {
    // Two owners on the unit; canonical (lex-first by ownerKey) gets the charge.
    const a = { name: 'AAA', taxId: '1' };
    const z = { name: 'ZZZ', taxId: '2' };
    const buildings = [
      {
        _id: 'b1',
        name: 'B',
        expenses: [{ _id: 'e1', type: 'cleaning' }],
        units: [mkUnit('p1', [a, z])],
        ownerMonthlyExpenses: [
          { _id: 'a', expenseId: 'e1', propertyId: 'p1', term: 2026060100, amount: 30, source: 'vacant', payments: [] }
        ]
      }
    ];
    const keyA = ownerKeyOf(a);
    const keyZ = ownerKeyOf(z);
    const canonical = [keyA, keyZ].sort()[0];
    const stCanonical = buildOwnerStatement(buildings, canonical, []);
    const stOther = buildOwnerStatement(buildings, canonical === keyA ? keyZ : keyA, []);
    expect(stCanonical.charges).toHaveLength(1); // counted once on canonical
    expect(stOther.charges).toHaveLength(0); // NOT double-counted on the other
  });

  it('returns null owner + empty charges for an unknown ownerKey', () => {
    const buildings = [
      { _id: 'b1', name: 'B', expenses: [], units: [], ownerMonthlyExpenses: [] }
    ];
    const st = buildOwnerStatement(buildings, 'n:nobody|', []);
    expect(st.owner).toBeNull();
    expect(st.charges).toHaveLength(0);
    expect(st.totals.amount).toBe(0);
  });
});
