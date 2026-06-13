// Tier I-1 (June 2026): past-unpaid rents must freeze too.
//
// Prior to this fix, Contract.update only restored past rents that
// had _isPayment(rent) === true (some recorded payment, settlement
// debt, or settlement discount). A past-unpaid month therefore fell
// through to the freshly-recomputed Contract.create() output and
// silently absorbed any new building expense added in the update.
//
// The Greek tax norm treats closed months as immutable; arrears get
// adjusted via explicit credit/debit notes, not by retroactively
// re-pricing an unpaid bill. This spec pins the new behavior so a
// later regression can't quietly thaw past-unpaid rents again.
//
// Imports the contract manager directly (same plain-import pattern as the
// passing managers/contract.test.js). The previous top-level `await
// import()` + jest.unstable_mockModule pattern could not be parsed by this
// project's @swc/jest transform ("await is only valid in async functions"),
// so this entire suite SILENTLY FAILED TO LOAD — it never actually ran.
// contract.ts → businesslogic → tasks/1_base.ts pulls `logger` from
// @microrealestate/common, which resolves fine via the built dist in jest
// (the same chain contract.test.js imports without any mock).
// `type: module` package → `jest` is not a global under ESM; import it
// (this suite uses jest.useFakeTimers()).
import { jest } from '@jest/globals';
import * as Contract from '../../managers/contract.js';

const FEB_TERM = 2026020100;
const APR_TERM = 2026040100;
const DEC_TERM = 2026120100;

function buildInputContract() {
  // Anchor system time AFTER Mar 2026 so Jan/Feb/Mar are unambiguously
  // past terms when Contract.update runs. April is the current term.
  jest.useFakeTimers().setSystemTime(new Date('2026-04-15T12:00:00Z'));

  const property = {
    propertyId: 'prop1',
    rent: 400,
    expenses: [],
    entryDate: new Date('2026-01-01'),
    exitDate: new Date('2026-12-31'),
    property: {
      name: 'Apt A',
      price: 400
    }
  };

  const contract = Contract.create({
    begin: Date.parse('2026-01-01T00:00:00Z'),
    end: Date.parse('2026-12-31T23:59:59Z'),
    frequency: 'months',
    properties: [property]
  });

  // Pay Jan and Mar fully so the only past-unpaid term is Feb. This
  // keeps the carry-in chain simple: Apr's frozen-aware balance comes
  // from Mar (paid → balance 0 going into Apr) plus Feb's unpaid
  // 400€ that still walks forward through the carry-in sweep.
  Contract.payTerm(contract, '2026010100', {
    payments: [{ amount: 400 }]
  });
  Contract.payTerm(contract, '2026030100', {
    payments: [{ amount: 400 }]
  });

  return { contract, property };
}

function buildBuilding(extraExpenseAmount) {
  const unit = {
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
  };

  const expense = {
    _id: 'exp1',
    name: 'Cleaning',
    type: 'cleaning',
    amount: extraExpenseAmount,
    allocationMethod: 'general_thousandths',
    isRecurring: true,
    // A recurring expense MUST carry a startTerm — the rent engine (and the
    // write-time validators) now reject a falsy startTerm rather than
    // billing back to epoch. Jan 2026 keeps it active for the Feb/Apr/Dec
    // terms this test asserts. (Previously omitted, which modeled exactly
    // the misconfigured row the validators reject; that no-anchor design
    // was itself stale.)
    startTerm: 2026010100,
    customAllocations: []
  };

  return {
    _id: 'building1',
    name: 'Building A',
    atakPrefix: '011172',
    units: [unit],
    expenses: [expense],
    address: {},
    blockStreets: [],
    hasElevator: false,
    hasCentralHeating: false,
    contractors: [],
    repairs: []
  };
}

describe('Contract.update — past-unpaid freeze (Tier I-1)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('past-unpaid Feb rent stays frozen when a new building expense is added later', () => {
    const { contract, property } = buildInputContract();

    // Snapshot the original Feb (past-unpaid) and Apr (current) totals
    // BEFORE update so we can assert freeze vs. re-pricing precisely.
    const originalFebRent = contract.rents.find((r) => r.term === FEB_TERM);
    const originalAprRent = contract.rents.find((r) => r.term === APR_TERM);
    expect(originalFebRent).toBeDefined();
    expect(originalAprRent).toBeDefined();

    // Sanity: Feb truly has no payments, debts, or settlement discounts.
    // Without those, the pre-Tier I-1 freeze-restore loop never visited
    // this rent, so the new expense would have leaked in.
    expect(originalFebRent.payments).toHaveLength(0);
    expect(originalFebRent.debts).toHaveLength(0);
    expect(
      originalFebRent.discounts.filter((d) => d.origin === 'settlement')
    ).toHaveLength(0);

    const originalFebGrandTotal = originalFebRent.total.grandTotal;
    const originalFebCharges = originalFebRent.total.charges;
    const originalFebPreTax = originalFebRent.total.preTaxAmount;

    // Now mutate the contract: introduce a building whose expense adds
    // €50 to every active rent's buildingCharges via the
    // general_thousandths allocator (single managed unit → full €50).
    const building = buildBuilding(50);
    const updatedContract = Contract.update(contract, {
      properties: [property],
      buildings: [building]
    });

    const updatedFebRent = updatedContract.rents.find(
      (r) => r.term === FEB_TERM
    );
    const updatedAprRent = updatedContract.rents.find(
      (r) => r.term === APR_TERM
    );
    const updatedDecRent = updatedContract.rents.find(
      (r) => r.term === DEC_TERM
    );

    // FEB (past, unpaid) MUST be frozen — every billed value pinned to
    // what was originally computed. Crucially, no €50 buildingCharge
    // line should have leaked in.
    expect(updatedFebRent.total.grandTotal).toBe(originalFebGrandTotal);
    expect(updatedFebRent.total.charges).toBe(originalFebCharges);
    expect(updatedFebRent.total.preTaxAmount).toBe(originalFebPreTax);
    expect(updatedFebRent.buildingCharges || []).toHaveLength(0);

    // APR (current term, unpaid) is NOT frozen — the new building
    // expense must take effect. Apr's own preTaxAmount + buildingCharges
    // should now total 400 + 50 = 450 (pre-balance). The carry-in from
    // Feb's still-unpaid 400€ propagates forward through the sweep but
    // is independent of Apr's own bill.
    expect(updatedAprRent.total.preTaxAmount).toBe(400);
    expect(updatedAprRent.buildingCharges).toBeDefined();
    const aprBuildingChargesSum = updatedAprRent.buildingCharges.reduce(
      (sum, c) => sum + (Number(c.amount) || 0),
      0
    );
    expect(aprBuildingChargesSum).toBe(50);

    // DEC (future) likewise reflects the new pricing.
    expect(updatedDecRent.total.preTaxAmount).toBe(400);
    const decBuildingChargesSum = (updatedDecRent.buildingCharges || []).reduce(
      (sum, c) => sum + (Number(c.amount) || 0),
      0
    );
    expect(decBuildingChargesSum).toBe(50);
  });
});
