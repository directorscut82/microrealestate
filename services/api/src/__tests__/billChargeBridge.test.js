/**
 * Slice 2e — the C6/C7 NO-CLOBBER guard for the bill→saveMonthlyStatement bridge.
 *
 * saveMonthlyStatement STRIPS every monthlyCharge for a term and rebuilds from
 * the entries it is passed. So when a confirmed bill charges tenants, the bridge
 * MUST resend EVERY existing expense entry for that term plus the bill's — or the
 * month's sibling charges are silently wiped (data loss). buildStatementEntries
 * is the pure function that assembles that full set; these tests lock its
 * behavior.
 */
import { jest } from '@jest/globals';

// billmanager imports @microrealestate/common (Collections/Service) + axios at
// module load; mock common so the import doesn't touch mongoose/redis. We only
// exercise the pure buildStatementEntries, which uses none of it.
jest.unstable_mockModule('@microrealestate/common', () => ({
  Collections: { Building: {}, Bill: {} },
  Service: { getInstance: () => ({}) },
  logger: { error() {}, debug() {}, warn() {}, info() {} },
  ServiceError: class ServiceError extends Error {
    constructor(message, code) {
      super(message);
      this.statusCode = code;
    }
  }
}));

const { buildStatementEntries } = await import('../managers/billmanager.js');

const TERM = 2026070100;

// A building with TWO existing variable charges for the term (Νερό, Ρεύμα),
// each materialised per-unit with inputAmount = the landlord-typed full figure.
const buildingWithTwoCharges = () => ({
  units: [
    {
      propertyId: 'p1',
      monthlyCharges: [
        { expenseId: 'water', term: TERM, amount: 25, inputAmount: 50, description: 'Νερό' },
        { expenseId: 'power', term: TERM, amount: 40, inputAmount: 80, description: 'Ρεύμα' }
      ]
    },
    {
      propertyId: 'p2',
      monthlyCharges: [
        { expenseId: 'water', term: TERM, amount: 25, inputAmount: 50, description: 'Νερό' },
        { expenseId: 'power', term: TERM, amount: 40, inputAmount: 80, description: 'Ρεύμα' }
      ]
    }
  ]
});

describe('buildStatementEntries — C6/C7 no-clobber', () => {
  it('CRITICAL: adding a 3rd expense keeps the 2 existing term charges (no clobber)', () => {
    const entries = buildStatementEntries(
      buildingWithTwoCharges(),
      'elevator', // new bill expense
      120, // full amount
      'Ασανσέρ',
      TERM
    );
    const byId = Object.fromEntries(entries.map((e) => [e.expenseId, e]));
    // all THREE must be present
    expect(entries).toHaveLength(3);
    expect(byId.water.amount).toBe(50); // preserved (inputAmount, not per-unit 25)
    expect(byId.power.amount).toBe(80); // preserved
    expect(byId.elevator.amount).toBe(120); // the new bill
    expect(byId.elevator.description).toBe('Ασανσέρ');
  });

  it('uses inputAmount (full figure), never the per-unit slice', () => {
    const entries = buildStatementEntries(buildingWithTwoCharges(), 'x', 10, 'X', TERM);
    const water = entries.find((e) => e.expenseId === 'water');
    expect(water.amount).toBe(50); // NOT 25 (the per-unit share)
  });

  it('dedupes per-expense across units (one entry per expense, not per unit)', () => {
    const entries = buildStatementEntries(buildingWithTwoCharges(), 'x', 10, 'X', TERM);
    const waterEntries = entries.filter((e) => e.expenseId === 'water');
    expect(waterEntries).toHaveLength(1);
  });

  it('REPLACES (not duplicates) when the bill expense already has a term charge', () => {
    const entries = buildStatementEntries(
      buildingWithTwoCharges(),
      'water', // same as an existing charge
      75, // new amount
      'Νερό (updated)',
      TERM
    );
    const waterEntries = entries.filter((e) => e.expenseId === 'water');
    expect(waterEntries).toHaveLength(1);
    expect(waterEntries[0].amount).toBe(75); // replaced with the new amount
    expect(entries).toHaveLength(2); // water (replaced) + power (kept)
  });

  it('ignores charges from OTHER terms', () => {
    const b = {
      units: [
        {
          propertyId: 'p1',
          monthlyCharges: [
            { expenseId: 'water', term: TERM, amount: 25, inputAmount: 50 },
            { expenseId: 'old', term: 2026060100, amount: 99, inputAmount: 99 }
          ]
        }
      ]
    };
    const entries = buildStatementEntries(b, 'new', 10, 'N', TERM);
    const ids = entries.map((e) => e.expenseId).sort();
    expect(ids).toEqual(['new', 'water']); // 'old' (June) excluded
  });

  it('falls back to amount when inputAmount is absent (fixed expense)', () => {
    const b = {
      units: [
        {
          propertyId: 'p1',
          monthlyCharges: [{ expenseId: 'fix', term: TERM, amount: 30 }] // no inputAmount
        }
      ]
    };
    const entries = buildStatementEntries(b, 'new', 10, 'N', TERM);
    expect(entries.find((e) => e.expenseId === 'fix').amount).toBe(30);
  });

  it('handles an empty building (only the bill entry)', () => {
    const entries = buildStatementEntries({ units: [] }, 'solo', 42, 'Solo', TERM);
    expect(entries).toEqual([{ expenseId: 'solo', amount: 42, description: 'Solo' }]);
  });

  // H1 — repair charges carry repairId + expenseId=null; they must be SKIPPED,
  // never echoed as {expenseId:'null'} (which 422s saveMonthlyStatement).
  it('H1: skips repair charges (expenseId null / repairId set)', () => {
    const b = {
      units: [
        {
          propertyId: 'p1',
          monthlyCharges: [
            { expenseId: 'water', term: TERM, amount: 25, inputAmount: 50 },
            { expenseId: null, repairId: 'r1', term: TERM, amount: 70, description: 'Επισκευή' }
          ]
        }
      ]
    };
    const entries = buildStatementEntries(b, 'power', 35, 'Ρεύμα', TERM);
    const ids = entries.map((e) => e.expenseId).sort();
    expect(ids).toEqual(['power', 'water']); // repair (null/repairId) excluded
    expect(entries.find((e) => e.expenseId === null)).toBeUndefined();
    expect(entries.find((e) => e.expenseId === 'null')).toBeUndefined();
  });

  // M1 — a legacy sibling with NO inputAmount, materialised per-unit across N
  // units, must reconstruct the FULL figure by summing shares — not fall back to
  // one unit's per-unit slice (which would halve a 2-unit statement).
  it('M1: legacy null-inputAmount sibling reconstructs full amount by summing shares', () => {
    const b = {
      units: [
        { propertyId: 'p1', monthlyCharges: [{ expenseId: 'water', term: TERM, amount: 25 }] },
        { propertyId: 'p2', monthlyCharges: [{ expenseId: 'water', term: TERM, amount: 25 }] }
      ]
    };
    const entries = buildStatementEntries(b, 'power', 35, 'Ρεύμα', TERM);
    const water = entries.find((e) => e.expenseId === 'water');
    expect(water.amount).toBe(50); // 25+25 summed — NOT 25 (single-unit slice)
  });

  // M1 — inputAmount, when present, wins over the share-sum (the landlord-typed
  // full figure is authoritative; don't double via summing per-unit rows).
  it('M1: inputAmount wins over share-sum when present', () => {
    const b = {
      units: [
        { propertyId: 'p1', monthlyCharges: [{ expenseId: 'water', term: TERM, amount: 25, inputAmount: 50 }] },
        { propertyId: 'p2', monthlyCharges: [{ expenseId: 'water', term: TERM, amount: 25, inputAmount: 50 }] }
      ]
    };
    const entries = buildStatementEntries(b, 'power', 35, 'Ρεύμα', TERM);
    expect(entries.find((e) => e.expenseId === 'water').amount).toBe(50); // inputAmount, not 100
  });
});
