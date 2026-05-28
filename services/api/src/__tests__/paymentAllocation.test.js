/* eslint-env node, mocha */
/**
 * Wave-25: payment-by-category allocation
 *
 * Verifies that the rent-pipeline payment task threads allocation arrays
 * onto persisted payments. End-to-end validation (the `payments[i].allocation`
 * shape + 422s on bad input) is in rentmanager.ts and exercised by Playwright;
 * here we test the computeRent ↔ pipeline integration that happens after
 * validation has already passed.
 */

import * as BL from '../businesslogic/index.js';
import moment from 'moment';

const baseProperty = {
  entryDate: moment('01/01/2025', 'DD/MM/YYYY').toDate(),
  exitDate: moment('31/12/2025', 'DD/MM/YYYY').toDate(),
  property: { name: 'apt-1', price: 500 },
  rent: 500,
  expenses: [
    { title: 'building-fee', amount: 80, beginDate: '01/01/2025', endDate: '31/12/2025' }
  ]
};

const baseContract = {
  begin: '01/05/2025',
  end: '31/05/2026',
  discount: 0,
  vatRate: 0,
  properties: [baseProperty]
};

describe('Wave-25: payment allocation in rent pipeline', () => {
  it('persists payment.allocation when provided in settlements', () => {
    const settlements = {
      payments: [
        {
          amount: 200,
          date: '15/05/2025',
          type: 'transfer',
          reference: 'ref-1',
          allocation: [
            { category: 'rent', amount: 150 },
            { category: 'expenses', amount: 50 }
          ]
        }
      ]
    };
    const computed = BL.computeRent(baseContract, '01/05/2025', null, settlements);
    expect(computed.payments).toHaveLength(1);
    expect(computed.payments[0].amount).toBe(200);
    expect(computed.payments[0].allocation).toEqual([
      { category: 'rent', amount: 150 },
      { category: 'expenses', amount: 50 }
    ]);
  });

  it('omits allocation field when settlement payment has none (legacy/auto-spread)', () => {
    const settlements = {
      payments: [
        {
          amount: 200,
          date: '15/05/2025',
          type: 'transfer',
          reference: 'ref-1'
        }
      ]
    };
    const computed = BL.computeRent(baseContract, '01/05/2025', null, settlements);
    expect(computed.payments).toHaveLength(1);
    expect(computed.payments[0].amount).toBe(200);
    expect(computed.payments[0].allocation).toBeUndefined();
  });

  it('rounds allocation amounts to 2 decimals', () => {
    const settlements = {
      payments: [
        {
          amount: 100,
          date: '15/05/2025',
          type: 'cash',
          allocation: [
            { category: 'rent', amount: 33.333 },
            { category: 'expenses', amount: 66.666 }
          ]
        }
      ]
    };
    const computed = BL.computeRent(baseContract, '01/05/2025', null, settlements);
    expect(computed.payments[0].allocation).toEqual([
      { category: 'rent', amount: 33.33 },
      { category: 'expenses', amount: 66.67 }
    ]);
  });

  it('drops empty-array allocation so legacy "allocation present" reads dont trip', () => {
    const settlements = {
      payments: [
        {
          amount: 50,
          date: '15/05/2025',
          type: 'cash',
          allocation: []
        }
      ]
    };
    const computed = BL.computeRent(baseContract, '01/05/2025', null, settlements);
    expect(computed.payments[0].allocation).toBeUndefined();
  });

  it('does not affect payment total (allocation is metadata, not balance math)', () => {
    const allocated = BL.computeRent(baseContract, '01/05/2025', null, {
      payments: [
        {
          amount: 200,
          date: '15/05/2025',
          type: 'transfer',
          allocation: [{ category: 'rent', amount: 150 }, { category: 'expenses', amount: 50 }]
        }
      ]
    });
    const unallocated = BL.computeRent(baseContract, '01/05/2025', null, {
      payments: [
        { amount: 200, date: '15/05/2025', type: 'transfer' }
      ]
    });
    expect(allocated.total.payment).toBe(unallocated.total.payment);
    expect(allocated.total.grandTotal).toBe(unallocated.total.grandTotal);
  });

  it('allows surplus allocation (sum < amount): the remainder becomes carried-forward credit via balance task', () => {
    // Tenant owes 580 (rent 500 + expenses 80), pays 700 with full allocation
    // to rent only. The pipeline still sees payment total=700 and grandTotal
    // reflects what's owed; the surplus carry-forward is computed downstream
    // (frontdata + balance task in subsequent terms).
    const computed = BL.computeRent(baseContract, '01/05/2025', null, {
      payments: [
        {
          amount: 700,
          date: '15/05/2025',
          type: 'transfer',
          allocation: [{ category: 'rent', amount: 700 }]
        }
      ]
    });
    expect(computed.payments[0].amount).toBe(700);
    expect(computed.payments[0].allocation).toEqual([
      { category: 'rent', amount: 700 }
    ]);
    // Pipeline keeps payment total=700, grandTotal stays at owed amount.
    expect(computed.total.payment).toBe(700);
    // newBalance = payment - grandTotal -> negative means carry-forward credit.
    const newBalance = computed.total.payment - computed.total.grandTotal;
    expect(newBalance).toBeGreaterThan(0);
  });
});
