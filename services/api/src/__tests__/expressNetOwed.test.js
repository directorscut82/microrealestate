/* eslint-env node, jest */
/**
 * Express-settle NET owed (round-1 H1/H6 + round-2 C1/C2, cross-confirmed by
 * both audit rounds): bulkExpressPayment recorded the GROSS owed-line sum,
 * ignoring (a) the standing lease discount and (b) any payment already made —
 * over-charging discounted/partially-paid tenants — and OVERWROTE existing
 * payments. _expressNetOwed mirrors ExpressPaymentDialog exactly:
 *   monthly  = (grandTotal − balance)   [discount already netted into grandTotal]
 *   previous = balance
 * minus already-paid (carry-in first, then monthly). These tests assert the
 * dialog and server agree (the bug was a server/dialog divergence).
 */
import { jest } from '@jest/globals';

let _expressNetOwed;

beforeAll(async () => {
  // rentmanager (+ transitive frontdata/occupantmanager) imports many symbols
  // from @microrealestate/common. Load the REAL module and spread it so every
  // export is present; only override the DB-touching Collections with a no-op
  // (these tests call the pure _expressNetOwed, which never hits the DB).
  const real = await import('@microrealestate/common');
  jest.unstable_mockModule('@microrealestate/common', () => ({
    ...real,
    Collections: {
      ...(real.Collections || {}),
      Tenant: { find: () => ({ lean: async () => [] }) }
    }
  }));
  ({ _expressNetOwed } = await import('../managers/rentmanager.js'));
});

// A rent shape as it sits on tenant.rents[] post-pipeline.
const mkRent = ({ grandTotal, balance = 0, payment = 0 }) => ({
  total: { grandTotal, balance, payment }
});

describe('_expressNetOwed (express settle = dialog)', () => {
  it('clean fully-unpaid month with NO discount → owes the full monthly', () => {
    // rent 500, no discount, no balance, nothing paid.
    const { monthlyOwed, previousOwed } = _expressNetOwed(
      mkRent({ grandTotal: 500 })
    );
    expect(monthlyOwed).toBe(500);
    expect(previousOwed).toBe(0);
  });

  it('DISCOUNTED tenant → owes the discounted total, NOT the gross', () => {
    // rent 500, standing discount 50 → grandTotal 450 (7_total nets it).
    // The OLD code summed gross owed lines (500) and over-charged by 50.
    const { monthlyOwed } = _expressNetOwed(mkRent({ grandTotal: 450 }));
    expect(monthlyOwed).toBe(450);
  });

  it('PARTIALLY-paid month → owes only the remaining, NOT the gross', () => {
    // rent 500, €200 already paid → owes €300. OLD code recorded €500.
    const { monthlyOwed } = _expressNetOwed(
      mkRent({ grandTotal: 500, payment: 200 })
    );
    expect(monthlyOwed).toBe(300);
  });

  it('DISCOUNTED + PARTIALLY-paid → owes discounted-minus-paid', () => {
    // rent 500, discount 50 → grandTotal 450; €100 paid → owes €350.
    const { monthlyOwed } = _expressNetOwed(
      mkRent({ grandTotal: 450, payment: 100 })
    );
    expect(monthlyOwed).toBe(350);
  });

  it('carry-in balance: already-paid is applied to balance FIRST, then monthly', () => {
    // grandTotal 700 (incl. 200 carry-in balance), so monthly = 500, previous = 200.
    // €250 paid → covers the 200 balance, then 50 of monthly → previous 0, monthly 450.
    const { monthlyOwed, previousOwed } = _expressNetOwed(
      mkRent({ grandTotal: 700, balance: 200, payment: 250 })
    );
    expect(previousOwed).toBe(0);
    expect(monthlyOwed).toBe(450);
  });

  it('fully-paid month → owes nothing (no phantom express charge)', () => {
    const { monthlyOwed, previousOwed } = _expressNetOwed(
      mkRent({ grandTotal: 500, payment: 500 })
    );
    expect(monthlyOwed).toBe(0);
    expect(previousOwed).toBe(0);
  });

  it('over-paid month → clamps at 0, never negative', () => {
    const { monthlyOwed } = _expressNetOwed(
      mkRent({ grandTotal: 500, payment: 650 })
    );
    expect(monthlyOwed).toBe(0);
  });
});
