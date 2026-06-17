// Round-1 audit H4: recording a payment on a CLOSED PAST term must NOT
// re-price that month's building/property charges at CURRENT rates.
//
// payTerm's settlement loop exempts the term being paid from the freeze guard
// (`rent.term !== targetTerm`), so the target term falls through to
// BL.computeRent against the LIVE contract.buildings. If a recurring building
// expense was raised after that month closed, paying a late arrears in the
// closed month re-prices its buildingCharges to today's amount — flipping a
// settled month into phantom arrears / wrong grandTotal.
//
// Contract.update already freezes past terms correctly (proven by
// contract-freeze-past-unpaid.test.js); payTerm's target-term branch is the
// lone outlier. This spec pins: paying a past term applies the payment but
// keeps the month's billed line-items frozen.
//
// Plain-import pattern (same as contract-freeze-past-unpaid.test.js).
import { jest } from '@jest/globals';
import * as Contract from '../../managers/contract.js';

const FEB_TERM = 2026020100;

function buildBuilding(expenseAmount) {
  return {
    _id: 'building1',
    name: 'Building A',
    atakPrefix: '011172',
    units: [
      {
        _id: 'unit1',
        propertyId: 'prop1',
        atakNumber: '01234567890',
        isManaged: true,
        surface: 80,
        generalThousandths: 1000,
        heatingThousandths: 0,
        elevatorThousandths: 0,
        owners: [],
        monthlyCharges: []
      }
    ],
    expenses: [
      {
        _id: 'exp1',
        name: 'Cleaning',
        type: 'cleaning',
        amount: expenseAmount,
        allocationMethod: 'general_thousandths',
        isRecurring: true,
        startTerm: 2026010100,
        customAllocations: []
      }
    ],
    address: {},
    blockStreets: [],
    hasElevator: false,
    hasCentralHeating: false,
    contractors: [],
    repairs: []
  };
}

describe('Contract.payTerm — past-term freeze on the TARGET term (H4)', () => {
  afterEach(() => jest.useRealTimers());

  test('paying a closed past term does NOT re-price its building charges at current rates', () => {
    // System time = April → Jan/Feb/Mar are closed past terms.
    jest.useFakeTimers().setSystemTime(new Date('2026-04-15T12:00:00Z'));

    const property = {
      propertyId: 'prop1',
      rent: 400,
      expenses: [],
      entryDate: new Date('2026-01-01'),
      exitDate: new Date('2026-12-31'),
      property: { name: 'Apt A', price: 400 }
    };

    // Build the contract with a €50 building expense ALREADY in place when Feb
    // was billed (so Feb's billed buildingCharges = €50).
    const contract = Contract.create({
      begin: Date.parse('2026-01-01T00:00:00Z'),
      end: Date.parse('2026-12-31T23:59:59Z'),
      frequency: 'months',
      properties: [property],
      buildings: [buildBuilding(50)]
    });

    const febBilled = contract.rents.find((r) => r.term === FEB_TERM);
    const febBilledBC = (febBilled.buildingCharges || []).reduce(
      (s, c) => s + (Number(c.amount) || 0),
      0
    );
    expect(febBilledBC).toBe(50); // Feb was billed €50 of building charges
    const febBilledGrand = febBilled.total.grandTotal;

    // Now the landlord RAISES the cleaning expense to €200 (in place — this is
    // what updateExpense does), then records a late payment on the CLOSED Feb
    // term. contract.buildings carries the LIVE (raised) amount, exactly as
    // rentmanager._updateByTerm injects it.
    contract.buildings = [buildBuilding(200)];
    const paid = Contract.payTerm(contract, '2026020100', {
      payments: [{ amount: 400, type: 'cash', date: '10/02/2026' }]
    });

    const febAfter = paid.rents.find((r) => r.term === FEB_TERM);
    const febAfterBC = (febAfter.buildingCharges || []).reduce(
      (s, c) => s + (Number(c.amount) || 0),
      0
    );

    // FAILING-FIRST: today payTerm re-prices Feb's building charges to €200.
    // After the fix Feb stays frozen at the €50 it was billed.
    expect(febAfterBC).toBe(50);
    expect(febAfter.total.grandTotal).toBe(febBilledGrand);
    // The payment IS recorded (the point of paying the term).
    expect(
      (febAfter.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0)
    ).toBe(400);
  });

  test('paying an UNPAID CURRENT-month term still re-prices (not frozen)', () => {
    // System time = Feb → Feb is the CURRENT term; an unpaid current term is
    // intentionally thawed so a mid-month expense edit takes effect.
    jest.useFakeTimers().setSystemTime(new Date('2026-02-15T12:00:00Z'));

    const property = {
      propertyId: 'prop1',
      rent: 400,
      expenses: [],
      entryDate: new Date('2026-01-01'),
      exitDate: new Date('2026-12-31'),
      property: { name: 'Apt A', price: 400 }
    };
    const contract = Contract.create({
      begin: Date.parse('2026-01-01T00:00:00Z'),
      end: Date.parse('2026-12-31T23:59:59Z'),
      frequency: 'months',
      properties: [property],
      buildings: [buildBuilding(50)]
    });

    // Raise the expense, then pay the CURRENT (Feb) term partially.
    contract.buildings = [buildBuilding(200)];
    const paid = Contract.payTerm(contract, '2026020100', {
      payments: [{ amount: 100, type: 'cash', date: '10/02/2026' }]
    });
    const febAfter = paid.rents.find((r) => r.term === FEB_TERM);
    const febAfterBC = (febAfter.buildingCharges || []).reduce(
      (s, c) => s + (Number(c.amount) || 0),
      0
    );
    // Current unpaid term re-prices to the live €200 (correct, unchanged
    // behavior — the freeze only applies to PAST and fully-paid-current terms).
    expect(febAfterBC).toBe(200);
  });

  // Step-7 H4 sibling: a CONTRACT discount reduced after a month was billed
  // must NOT re-price the closed month when arrears are paid. The first fix
  // restored preTax/charges but not discounts, leaving total.discount at the
  // live (smaller) value while keeping the billed discount-VAT → grandTotal
  // silently inflated by the discount delta.
  test('paying a closed past term keeps the BILLED contract discount frozen', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-15T12:00:00Z'));

    const property = {
      propertyId: 'prop1',
      rent: 1000,
      expenses: [],
      entryDate: new Date('2026-01-01'),
      exitDate: new Date('2026-12-31'),
      property: { name: 'Apt A', price: 1000 }
    };
    // Billed with a €100 standing discount.
    const contract = Contract.create({
      begin: Date.parse('2026-01-01T00:00:00Z'),
      end: Date.parse('2026-12-31T23:59:59Z'),
      frequency: 'months',
      properties: [property],
      discount: 100
    });

    const febBilled = contract.rents.find((r) => r.term === FEB_TERM);
    const febBilledDiscount = febBilled.total.discount;
    const febBilledGrand = febBilled.total.grandTotal;
    expect(febBilledDiscount).toBe(100);

    // Landlord shrinks the discount to €30 (live), then pays the CLOSED Feb.
    contract.discount = 30;
    const paid = Contract.payTerm(contract, '2026020100', {
      payments: [{ amount: 900, type: 'cash', date: '10/02/2026' }]
    });
    const febAfter = paid.rents.find((r) => r.term === FEB_TERM);

    // FAILING-FIRST (pre-discount-restore): febAfter.total.discount = 30 and
    // grandTotal inflated by €70. After the fix the billed €100 discount and
    // grandTotal stay frozen.
    expect(febAfter.total.discount).toBe(febBilledDiscount);
    expect(febAfter.total.grandTotal).toBe(febBilledGrand);
  });
});
