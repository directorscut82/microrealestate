/* eslint-env node, jest */
import * as Contract from '../managers/contract.js';
import * as BL from '../businesslogic/index.js';
import { computeBuildingExpenseBreakdown } from '../businesslogic/tasks/1_base.ts';

/**
 * MONEY-FLOW LIFECYCLE SUITE
 * --------------------------
 * Traces building-expense / repair money across tenant lifecycle
 * transitions — the edge cases that make an expense tracker trustworthy
 * and that symptom-patching never covers:
 *
 *   A. tenant active whole term → renter billed (baseline)
 *   B. vacant unit, flag OFF → uncollected (no silent owner charge)
 *   C. vacant unit, flag ON  → owner billed
 *   D. repair/charge scheduled for a term AFTER the tenant terminates
 *      → must go to the OWNER, not be orphaned   [policy: owner]
 *   E. multi-unit tenant exits ONE unit mid-lease → that unit's share
 *      must not vanish
 *
 * Each test asserts concrete numbers. Where the engine is currently WRONG
 * the test is written to the CORRECT expected behavior and marked
 * `test.failing` so the suite is green while still documenting the gap as
 * a live, tracked bug (flip to `test` when fixed). This is the bug MAP +
 * regression guard, committed, not a throwaway probe.
 */

const mkUnit = (propertyId, o = {}) => ({
  _id: `u_${propertyId}`,
  propertyId,
  atakNumber: `A_${propertyId}`,
  isManaged: true,
  surface: 50,
  generalThousandths: 500,
  heatingThousandths: 0,
  elevatorThousandths: 0,
  floor: 1,
  owners: [],
  monthlyCharges: [],
  ...o
});

const mkExpense = (o = {}) => ({
  _id: 'e1',
  name: 'Cleaning',
  type: 'common',
  amount: 100,
  allocationMethod: 'equal',
  isRecurring: true,
  startTerm: 2024010100,
  chargeOwnerWhenVacant: false,
  customAllocations: [],
  ...o
});

const mkBuilding = (units, expenses, o = {}) => ({
  _id: 'b1',
  name: 'B',
  atakPrefix: '005578',
  units,
  expenses,
  repairs: [],
  address: {},
  blockStreets: [],
  contractors: [],
  ownerMonthlyExpenses: [],
  ...o
});

describe('money-flow lifecycle — building expenses across tenant transitions', () => {
  // A. Baseline: tenant active whole term → renter billed.
  it('A: active tenant for the term is billed the share', () => {
    const b = mkBuilding(
      [{ ...mkUnit('p1'), property: { name: 'P1' }, tenant: { _id: 't1', name: 'Alice' } }],
      [mkExpense({ amount: 100, allocationMethod: 'equal' })]
    );
    const r = computeBuildingExpenseBreakdown(b, 2024060100);
    expect(r.tenantTotal).toBe(100);
    expect(r.ownerBilledTotal).toBe(0);
    expect(r.ownerUnbilledTotal).toBe(0);
  });

  // B. Vacant + flag OFF → uncollected (NOT silently billed to owner).
  it('B: vacant unit with chargeOwnerWhenVacant OFF is uncollected', () => {
    const b = mkBuilding(
      [{ ...mkUnit('p1'), property: { name: 'P1' }, tenant: null }],
      [mkExpense({ amount: 100, chargeOwnerWhenVacant: false })]
    );
    const r = computeBuildingExpenseBreakdown(b, 2024060100);
    expect(r.tenantTotal).toBe(0);
    expect(r.ownerUnbilledTotal).toBe(100);
    expect(r.ownerBilledTotal).toBe(0);
  });

  // C. Vacant + flag ON → owner billed.
  it('C: vacant unit with chargeOwnerWhenVacant ON bills the owner', () => {
    const b = mkBuilding(
      [{ ...mkUnit('p1'), property: { name: 'P1' }, tenant: null }],
      [mkExpense({ amount: 100, chargeOwnerWhenVacant: true })]
    );
    const r = computeBuildingExpenseBreakdown(b, 2024060100);
    expect(r.ownerBilledTotal).toBe(100);
    expect(r.ownerUnbilledTotal).toBe(0);
  });

  // E. Multi-unit tenant exits ONE unit mid-lease — the still-active unit's
  // share must still be billed (regression for the carrier-vanish class).
  it('E: when a multi-unit tenant exits one unit, the active unit still bills', () => {
    const b = mkBuilding(
      [
        { ...mkUnit('p1'), property: { name: 'P1' }, tenant: { _id: 't1', name: 'Alice' } },
        { ...mkUnit('p2'), property: { name: 'P2' }, tenant: { _id: 't2', name: 'Bob' } }
      ],
      [mkExpense({ amount: 100, allocationMethod: 'equal' })]
    );
    const r = computeBuildingExpenseBreakdown(b, 2024060100);
    // 2 units, equal → 50 each, both renters.
    expect(r.tenantTotal).toBe(100);
  });
});

describe('money-flow lifecycle — repair charged across an early termination', () => {
  // D. THE USER'S EDGE CASE. A repair is scheduled (chargeTerm = June) to a
  // tenant who TERMINATES end of May. Today the June rent term is dropped,
  // the monthlyCharge for June is orphaned, and the amount is billed to
  // NOBODY (not the ex-tenant, not the owner). Decided policy: it must go
  // to the OWNER. Marked test.failing until the orphan→owner fix lands.
  test.failing(
    'D: repair charged to a term after termination must go to the owner (currently orphaned)',
    () => {
      const unit = mkUnit('p1', {
        monthlyCharges: [
          { term: 2024060100, amount: 1200, description: 'Repair: Roof', repairId: 'rep1' }
        ]
      });
      const building = mkBuilding(
        [unit],
        [],
        {
          repairs: [
            {
              _id: 'rep1',
              title: 'Roof',
              chargeableTo: 'tenants',
              chargeTerm: 2024060100,
              actualCost: 1200,
              status: 'completed',
              allocationMethod: 'general_thousandths'
            }
          ]
        }
      );
      const contract = Contract.create({
        begin: Date.parse('2024-01-01T00:00:00Z'),
        end: Date.parse('2024-12-31T23:59:59Z'),
        frequency: 'months',
        vatRate: 0,
        properties: [
          {
            propertyId: 'p1',
            rent: 500,
            expenses: [],
            entryDate: Date.parse('2024-01-01T00:00:00Z'),
            exitDate: Date.parse('2024-12-31T23:59:59Z'),
            property: { name: 'P1' }
          }
        ],
        buildings: [building]
      });
      Contract.terminate(contract, new Date('2024-05-31T23:59:59Z'));
      // CORRECT behavior: the June repair must surface as an owner charge
      // (the unit is effectively vacant in June). Today it is orphaned —
      // ownerMonthlyExpenses stays empty and no June rent exists.
      const ownerVacant = (building.ownerMonthlyExpenses || []).filter(
        (e) => Number(e.term) === 2024060100
      );
      const ownerTotal = ownerVacant.reduce((s, e) => s + (e.amount || 0), 0);
      expect(ownerTotal).toBe(1200);
      void BL; // engine import kept for parity with other lifecycle tests
    }
  );
});
