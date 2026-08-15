/* eslint-env node */
// Regression for the save-time guard that blocks a thousandths allocation method
// when the building has no thousandths for that dimension — else the tenant/split
// share evaporates (found live: ΟΔΟΣ ΗΤΑ general_thousandths repair, 180€ → nobody).
// type: module → jest.unstable_mockModule + dynamic import (mirror ownerPaymentCarry).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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

describe('the guard and the ENGINE must compute the same denominator', () => {
  /**
   * WHY THIS EXISTS. The guard's own comment claimed it summed «the SAME denominator the
   * tenant engine uses» while computing a different one: it reduced
   * `Number(u[field]) || 0` RAW, so a negative χιλιοστό counted AGAINST the total here,
   * whereas 1_base normalises a negative to 0 on both sides of its division (the
   * over-billing fix). They disagreed in both directions:
   *
   *   500/500/−1000  raw 0    → save REFUSED as "no χιλιοστά"
   *                  norm 1000 → engine would have split it perfectly well
   *   500/−400       raw 100  → save allowed
   *                  norm 500  → engine's denominator is 5× the guard's
   *
   * One money rule computed twice is this repo's most-repeated defect, so the guard now
   * calls the shared normaliser. These cases are the ones where that matters.
   */
  const vec = (values) =>
    values.map((v, i) => ({ propertyId: `p${i}`, generalThousandths: v }));

  it('ACCEPTS a vector the engine can split, even with a large negative present', () => {
    // The raw sum is 0 here, which used to read as "this building has no χιλιοστά" and
    // blocked a save the engine would have handled.
    expect(() =>
      _assertThousandthsAvailable({ units: vec([500, 500, -1000]) }, 'general_thousandths')
    ).not.toThrow();
  });

  it('still REFUSES a building with genuinely no χιλιοστά', () => {
    // The guard's actual purpose, unchanged: a zero vector means the amount would land
    // on no surface at all (MONEY_SURFACE_MATRIX's absent-representation shape).
    expect(() =>
      _assertThousandthsAvailable({ units: vec([0, 0, 0]) }, 'general_thousandths')
    ).toThrow(/thousandths/i);
  });

  it('REFUSES a vector that is only negative — nothing to split by', () => {
    // Normalised total is 0, so there is no denominator; refusing is right, and now both
    // sides agree on why.
    expect(() =>
      _assertThousandthsAvailable({ units: vec([-100, -50]) }, 'general_thousandths')
    ).toThrow(/thousandths/i);
  });

  it('the healthy case is untouched', () => {
    expect(() =>
      _assertThousandthsAvailable({ units: vec([400, 300, 200, 100]) }, 'general_thousandths')
    ).not.toThrow();
  });
});

describe('the OWNER side uses the same ‰ rule as the tenant side', () => {
  /**
   * GATE 8 finding. ffc9cc02 normalised the ‰ denominator on the tenant side and left the
   * owner allocator (buildingmanager `_ownerPerUnit`) summing RAW. Because that allocator
   * has a carrier-remainder, the TOTAL was always conserved — so this never over-collected.
   * What it did was move money BETWEEN owners: on 500/400/−100 over a €200 expense the raw
   * denominator of 800 bills 125,00 / 75,00 where the normalised 900 bills 111,11 / 88,89.
   * €13,89 taken from one owner and handed to the other, and the tenant-side split of the
   * SAME vector disagreed with it.
   *
   * Asserted at source because the allocator is a closure inside a 400-line handler and not
   * separately exported; the arithmetic itself is pinned by the shared normaliser's own
   * tests plus the engine probe.
   */
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../managers/buildingmanager.ts'),
    'utf8'
  );

  it('the owner allocator sums through the shared normaliser, not raw', () => {
    const at = src.indexOf('const totalT = ');
    expect(at).toBeGreaterThan(-1);
    const line = src.slice(at, src.indexOf(';', at));
    expect(line).toContain('ShareBasis.thousandthsTotal');
    // The raw form must be gone from this computation.
    expect(line).not.toMatch(/Number\(u\[key\]\)\s*\|\|\s*0/);
  });

  it('its numerator is normalised too — one side is not enough', () => {
    // Normalising only the denominator would still bill a negative unit a negative share,
    // which every `share > 0` gate downstream then discards.
    const at = src.indexOf('const raw = (amt *');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, src.indexOf(';', at))).toContain(
      'ShareBasis.unitThousandths'
    );
  });

  it('the printed owner basis divides by the SAME set as the allocator', () => {
    // The equation is the landlord's only window into the arithmetic. It summed raw ‰ over
    // ALL units while the allocator divides over MANAGED ones, so the printed whole
    // disagreed with the divisor that produced the euro beside it — and the panel's
    // consistency backstop then suppressed the sub-line, costing the explanation.
    const at = src.indexOf("kind: 'thousandths',");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(Math.max(0, at - 700), at + 300);
    expect(block).toContain(
      'ShareBasis.thousandthsTotal(_managedUnitsForBasis, key)'
    );
    expect(block).toContain('ShareBasis.unitThousandths(unit, key)');
  });

  it('the frontend blocker uses the same normalisation as the server guard', () => {
    // A dialog that says «the units have no thousandths» about a vector the server accepts
    // is worse than either behaviour on its own.
    const dialog = fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../../webapps/landlord/src/components/buildings/ExpenseFormDialog.js'
      ),
      'utf8'
    );
    expect(dialog).toContain('const _sumThousandths =');
    expect(dialog).toContain('_sumThousandths(units, THOUSANDTHS[m])');
  });

  it('the carrier id list is deduped, so a repeated propertyId cannot be ambiguous', () => {
    const base = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../businesslogic/tasks/1_base.ts'),
      'utf8'
    );
    const at = base.indexOf('const _orderedIds =');
    expect(at).toBeGreaterThan(-1);
    expect(base.slice(at, at + 260)).toContain('new Set(');
  });
});
