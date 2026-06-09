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
// NOTE: this test deliberately mocks @microrealestate/common BEFORE
// importing the contract manager. Without the mock, the import chain
// transitively pulls in `services/common/dist/utils/service.js` which
// requires express-winston — a CommonJS module that calls require()
// against a winston mock declared as ESM. Jest with VM Modules cannot
// satisfy that require() and the entire suite fails to load. The
// businesslogic layer (contract.ts → tasks/1_base.ts) only consumes
// `logger` from @microrealestate/common; mocking just that surface
// keeps the unit test self-contained.

import { jest } from '@jest/globals';

jest.unstable_mockModule('@microrealestate/common', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    silly: jest.fn()
  }
}));

const Contract = await import('../../managers/contract.js');

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
  Contract.payTerm(contract, '202601010000', {
    payments: [{ amount: 400 }]
  });
  Contract.payTerm(contract, '202603010000', {
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
