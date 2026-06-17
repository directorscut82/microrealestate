/* eslint-env node, jest */
/**
 * Round-1 audit H5: _isSettledByCarryForward double-credited a settlement
 * discount. monthlyBill = grandTotal − balance is ALREADY net of the discount
 * (7_total subtracts ALL rent.discounts into grandTotal), yet cashIn =
 * paymentsSum + settlementDiscounts re-added the discount → the running deficit
 * dropped by the discount TWICE → an underpaid month wrongly flipped to "paid"
 * (the row left the In-arrears list). These tests assert the CORRECT behavior.
 */
import { _isSettledByCarryForward } from '../managers/frontdata.js';

// rent shape as persisted on tenant.rents[].
const mkRent = ({ term, grandTotal, balance = 0, payments = [], discounts = [] }) => ({
  term,
  total: { grandTotal, balance },
  payments,
  discounts
});

describe('_isSettledByCarryForward — settlement discount must not be double-credited (H5)', () => {
  it('rent 1000, settlement discount 100 (→ grandTotal 900), payment 800 → NOT settled (100 still owed)', () => {
    // grandTotal already nets the discount: 1000 − 100 = 900. Paid 800 → owes 100.
    const rents = [
      mkRent({
        term: 2026060100,
        grandTotal: 900,
        balance: 0,
        payments: [{ amount: 800 }],
        discounts: [{ origin: 'settlement', amount: 100 }]
      })
    ];
    expect(_isSettledByCarryForward(2026060100, rents)).toBe(false);
  });

  it('rent 1000, settlement discount 100, payment 900 → settled (paid the full discounted bill)', () => {
    const rents = [
      mkRent({
        term: 2026060100,
        grandTotal: 900,
        payments: [{ amount: 900 }],
        discounts: [{ origin: 'settlement', amount: 100 }]
      })
    ];
    expect(_isSettledByCarryForward(2026060100, rents)).toBe(true);
  });

  it('contract (standing) discount behaves the same — already in grandTotal, not re-added', () => {
    // origin:'contract' discount was never in cashIn (the bug was settlement-
    // origin only), but assert the discounted bill still needs full payment.
    const rents = [
      mkRent({
        term: 2026060100,
        grandTotal: 450, // 500 − 50 standing discount
        payments: [{ amount: 400 }],
        discounts: [{ origin: 'contract', amount: 50 }]
      })
    ];
    expect(_isSettledByCarryForward(2026060100, rents)).toBe(false); // owes 50
  });

  it('no discount, full payment → settled (regression guard)', () => {
    const rents = [
      mkRent({ term: 2026060100, grandTotal: 500, payments: [{ amount: 500 }] })
    ];
    expect(_isSettledByCarryForward(2026060100, rents)).toBe(true);
  });
});
