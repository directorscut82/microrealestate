/* eslint-env node */
// Regression for the save-time guard that blocks a thousandths allocation method
// when the building has no thousandths for that dimension — else the tenant/split
// share evaporates (found live: ΟΔΟΣ ΗΤΑ general_thousandths repair, 180€ → nobody).
// type: module → jest.unstable_mockModule + dynamic import (mirror ownerPaymentCarry).
import { jest } from '@jest/globals';

let _assertThousandthsAvailable;

beforeAll(async () => {
  const OwnerStatement = await import('../../../common/src/utils/ownerstatement.ts');
  const ShareBasis = await import('../../../common/src/utils/sharebasis.ts');
  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: {},
      // billmanager + telegramInboxScanner now take the charge month and the
      // bill-term fit from the shared rule, so this factory must provide it.
      // unstable_mockModule replaces the WHOLE module: an export the graph consumes
      // but the factory omits is `undefined` at call time, which surfaces as a
      // TypeError deep inside rather than a resolution error.
      BillTerm: {
        billTermFitsExpense: () => ({ fits: true }),
        billTermIsOutsideExpense: () => false,
        computeChargeTerm: (b) => {
          const d = new Date(b?.issueDate || b?.periodEnd);
          return Number.isFinite(d.getTime())
            ? d.getUTCFullYear() * 1000000 + (d.getUTCMonth() + 1) * 10000 + 100
            : undefined;
        }
      },
    logger: { warn() {}, info() {}, error() {} },
    ServiceError: class ServiceError extends Error {
      constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
      }
    },
    OwnerStatement,
    ShareBasis
  }));
  jest.unstable_mockModule('../managers/occupantmanager.js', () => ({
    _attachTenantGroupsToBuildings: async () => {}
  }));
  const bm = await import('../managers/buildingmanager.js');
  _assertThousandthsAvailable = bm._assertThousandthsAvailable;
});

const mkBuilding = (units) => ({ units });

describe('_assertThousandthsAvailable', () => {
  it('throws 422 for general_thousandths when no unit has generalThousandths', () => {
    const b = mkBuilding([
      { propertyId: 'p1', generalThousandths: 0, surface: 50 },
      { propertyId: 'p2', surface: 80 } // generalThousandths undefined
    ]);
    expect(() => _assertThousandthsAvailable(b, 'general_thousandths')).toThrow(
      /thousandths/i
    );
  });

  it('passes for general_thousandths when at least one unit has a nonzero value', () => {
    const b = mkBuilding([
      { propertyId: 'p1', generalThousandths: 500 },
      { propertyId: 'p2', generalThousandths: 500 }
    ]);
    expect(() =>
      _assertThousandthsAvailable(b, 'general_thousandths')
    ).not.toThrow();
  });

  it('throws for heating_thousandths / elevator_thousandths independently', () => {
    const b = mkBuilding([
      { propertyId: 'p1', generalThousandths: 1000, heatingThousandths: 0, elevatorThousandths: 0 }
    ]);
    // general is fine, but heating/elevator are zero → each throws for its own method
    expect(() => _assertThousandthsAvailable(b, 'general_thousandths')).not.toThrow();
    expect(() => _assertThousandthsAvailable(b, 'heating_thousandths')).toThrow();
    expect(() => _assertThousandthsAvailable(b, 'elevator_thousandths')).toThrow();
  });

  it('is a NO-OP for non-thousandths methods (equal / by_surface / fixed / custom / single_unit)', () => {
    const b = mkBuilding([{ propertyId: 'p1' }]); // no thousandths at all
    for (const m of [
      'equal',
      'by_surface',
      'fixed',
      'custom_ratio',
      'custom_percentage',
      'single_unit',
      undefined
    ]) {
      expect(() => _assertThousandthsAvailable(b, m)).not.toThrow();
    }
  });

  it('counts ALL units (incl. vacant/unmanaged) in the denominator, matching the engine', () => {
    // one unmanaged unit carries the thousandths — the engine sums building.units
    // (not managed), so the denominator is nonzero → must pass.
    const b = mkBuilding([
      { propertyId: 'p1', generalThousandths: 0 },
      { generalThousandths: 1000 } // no propertyId (unmanaged) but has ‰
    ]);
    expect(() =>
      _assertThousandthsAvailable(b, 'general_thousandths')
    ).not.toThrow();
  });
});
