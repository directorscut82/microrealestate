// T2.P1.22: E9 parser unit tests. Uses the 5 user-submitted PDF text
// dumps under /tmp/e9-reaudit as inputs. Snapshot JSONs in that
// directory are STALE (pre-T2 — they predate coOwners/rightType), so
// these tests assert on stable invariants instead of byte-for-byte
// snapshots: owner identity, building counts, key per-row fields the
// importer relies on (atakNumber, surface, ownershipPercentage,
// electricitySupplyNumber). New T2 invariants (coOwners, rightType,
// settlement block-plot rows surfacing as buildings instead of being
// dropped as land plots) are asserted explicitly.

import fs from 'fs';
import path from 'path';
import { parseE9 } from '../../managers/e9parser.ts';

const FIXTURE_DIR = '/tmp/e9-reaudit';

function readFixture(name) {
  const p = path.join(FIXTURE_DIR, name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

const E9_FIXTURES = [
  {
    file: 'PeriousiakiKatastasi2026-3.txt',
    expectOwnerTaxId: '021301485',
    expectOwnerLast: 'ΕΠΙΤΡΟΠΟΥ',
    expectOwnerFirst: 'ΖΩΗ',
    expectMinBuildings: 2
  },
  {
    file: 'PeriousiakiKatastasi2027-1.txt',
    expectOwnerTaxId: '125479189',
    expectOwnerLast: 'ΕΠΙΤΡΟΠΟΥ',
    expectOwnerFirst: 'ΓΕΩΡΓΙΟΣ',
    expectMinBuildings: 1
  },
  {
    file: 'PeriousiakiKatastasi2027-2.txt',
    expectOwnerTaxId: '148152811',
    expectOwnerLast: 'ΕΠΙΤΡΟΠΟΥ',
    expectOwnerFirst: 'ΙΣΜΗΝΗ',
    expectMinBuildings: 2
  },
  {
    file: 'PeriousiakiKatastasi2027-4.txt',
    expectOwnerTaxId: '125479189',
    expectOwnerLast: 'ΕΠΙΤΡΟΠΟΥ',
    expectOwnerFirst: 'ΓΕΩΡΓΙΟΣ',
    expectMinBuildings: 1
  },
  {
    file: 'PeriousiakiKatastasi2027-5.txt',
    expectOwnerTaxId: '023691386',
    expectOwnerLast: 'ΕΠΙΤΡΟΠΟΥ',
    expectOwnerFirst: 'ΑΝΤΩΝΙΟΣ',
    expectMinBuildings: 2
  }
];

const skipIfNoFixtures = !fs.existsSync(FIXTURE_DIR) ? describe.skip : describe;

skipIfNoFixtures('parseE9 — fixture suite', () => {
  for (const fx of E9_FIXTURES) {
    describe(fx.file, () => {
      const text = readFixture(fx.file);
      if (!text) {
        test.skip(`fixture missing: ${fx.file}`, () => {});
        return;
      }
      const parsed = parseE9(text);

      test('parses owner identity', () => {
        expect(parsed.owner.taxId).toBe(fx.expectOwnerTaxId);
        expect(parsed.owner.lastName).toBe(fx.expectOwnerLast);
        expect(parsed.owner.firstName).toBe(fx.expectOwnerFirst);
      });

      test('emits at least the expected number of buildings', () => {
        expect(parsed.buildings.length).toBeGreaterThanOrEqual(
          fx.expectMinBuildings
        );
      });

      test('every building has at least one unit with a positive surface', () => {
        for (const b of parsed.buildings) {
          expect(Array.isArray(b.units)).toBe(true);
          expect(b.units.length).toBeGreaterThan(0);
          const positiveSurface = b.units.find((u) => u.surface > 0);
          expect(positiveSurface).toBeTruthy();
        }
      });

      test('every unit carries an 11-digit ATAK number', () => {
        for (const b of parsed.buildings) {
          for (const u of b.units) {
            expect(typeof u.atakNumber).toBe('string');
            expect(u.atakNumber).toMatch(/^\d{11}$/);
          }
        }
      });

      test('ownershipPercentage is bounded 0..100', () => {
        for (const b of parsed.buildings) {
          for (const u of b.units) {
            expect(u.ownershipPercentage).toBeGreaterThanOrEqual(0);
            expect(u.ownershipPercentage).toBeLessThanOrEqual(100);
          }
        }
      });

      // T2.P1.14: rightType field present and constrained.
      test('every unit has a rightType in {full, bare, usufruct}', () => {
        for (const b of parsed.buildings) {
          for (const u of b.units) {
            expect(['full', 'bare', 'usufruct']).toContain(u.rightType);
          }
        }
      });

      // T2.P1.4: coOwners array present (may be empty).
      test('every unit has a coOwners array', () => {
        for (const b of parsed.buildings) {
          for (const u of b.units) {
            expect(Array.isArray(u.coOwners)).toBe(true);
          }
        }
      });

      test('failedRows stays at 0 (parser handles every row)', () => {
        expect(parsed.failedRows).toBe(0);
      });
    });
  }
});

// Targeted regression tests for specific T2 fixes. These assert
// invariants that depend on parser internals — keep them tight so a
// future refactor surfaces a single failing test instead of a bag of
// "well it's different now" snapshot diffs.
skipIfNoFixtures('parseE9 — T2 regressions', () => {
  // T2.P1.3: the ΛΑΓΟΝΗΣΙ row in 2027-1 has a non-numeric block-plot id
  // ("831Α") and previously fell through the urban/rural patterns,
  // ending up dropped as a land plot. The 4th-pattern fallback should
  // surface it as a real building unit with a positive surface.
  test('T2.P1.3: settlement block-plot row surfaces as a building', () => {
    const text = readFixture('PeriousiakiKatastasi2027-1.txt');
    if (!text) return; // fixture missing — handled at suite level
    const parsed = parseE9(text);
    // The row carries surface 410.18 m² with ATAK 00557802393. Find
    // either by ATAK or by the recognizable surface.
    const allUnits = parsed.buildings.flatMap((b) => b.units);
    const row = allUnits.find(
      (u) => u.atakNumber === '00557802393' || Math.abs(u.surface - 410.18) < 0.01
    );
    expect(row).toBeTruthy();
    if (row) {
      expect(row.surface).toBeGreaterThan(0);
      // The block-plot identifier should round-trip as the streetNumber
      // so downstream importer can group/preview the building.
      expect(row.streetNumber).toMatch(/^\d+[Α-Ω]?$/);
    }
  });

  // T2.P1.4 spot-check: a row with a 50,0 ownership fraction (KAΛAMΩN
  // 24 in fixture 2027-5) should round-trip as 50 (or 50.0). Earlier
  // versions clamped this to 100.
  test('T2.P1.4: fractional ownership percentages round-trip', () => {
    const text = readFixture('PeriousiakiKatastasi2027-5.txt');
    if (!text) return;
    const parsed = parseE9(text);
    const allUnits = parsed.buildings.flatMap((b) => b.units);
    const halfOwned = allUnits.filter(
      (u) => u.ownershipPercentage >= 49 && u.ownershipPercentage <= 51
    );
    // Fixture has 5 ΚΑΛΑΜΩΝ 24 units at 50% each.
    expect(halfOwned.length).toBeGreaterThanOrEqual(1);
  });
});
