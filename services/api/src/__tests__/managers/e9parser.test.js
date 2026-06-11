// T2.P1.22: E9 parser unit tests.
//
// TWO fixture sources:
//   1. The 5 user-submitted PDF text dumps under /tmp/e9-reaudit (full
//      owner PII) drive the broad invariant suite. These SKIP wherever
//      the local dumps are absent (e.g. CI) — by design, to avoid
//      committing tax IDs. Do NOT treat their green as coverage in CI.
//   2. A committed, REDACTED ΑΝΑΡΓΥΡΩΝ fixture (owner taxId scrubbed,
//      structural rows intact) at fixtures/e9/anargyron-redacted.txt
//      drives the AADE category→type regression block at the bottom,
//      which therefore DOES run in CI. That block exists because the
//      whole /tmp suite asserted everything EXCEPT category — letting a
//      category-6 (parking) unit ship misclassified as storage.
//
// The /tmp suite asserts stable invariants (owner identity, building
// counts, atakNumber, surface, ownershipPercentage, coOwners, rightType,
// block-plot rows surfacing as buildings) rather than byte-for-byte
// snapshots, since the snapshot JSONs in that dir are pre-T2 stale.

import fs from 'fs';
import path from 'path';
import { parseE9 } from '../../managers/e9parser.ts';
import { inferPropertyType } from '../../businesslogic/inferPropertyType.ts';

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

// ───────────────────────────────────────────────────────────────────────
// AADE category → property-type mapping. THIS BLOCK EXISTS BECAUSE THE
// WHOLE SUITE PREVIOUSLY ASSERTED EVERYTHING EXCEPT category and the
// resulting type — so a real building (ΑΓ. ΑΝΑΡΓΥΡΩΝ 28) imported with
// 7 basement units silently classified ALL of them 'storage' when 3 are
// actually category-6 PARKING. A user found it by eye; no test did.
//
// We assert the full chain on the real PDF dump: the parser must extract
// the category digit per row, AND inferPropertyType must map it to the
// right type. 5→storage (αποθήκη), 6→parking, 1→apartment.
// ───────────────────────────────────────────────────────────────────────
// This block does NOT use skipIfNoFixtures: the ΑΝΑΡΓΥΡΩΝ rows are
// committed (redacted: owner taxId scrubbed to 000000000, structural row
// data intact) at fixtures/e9/anargyron-redacted.txt, so the category→type
// regression runs in CI — unlike the /tmp/e9-reaudit suite above, which
// silently skips wherever those local dumps are absent (the gap that let
// the parking misclassification ship). Falls back to the /tmp dump if the
// committed one is somehow missing.
const COMMITTED_E9 = path.resolve(
  __dirname,
  '../fixtures/e9/anargyron-redacted.txt'
);
function readAnargyron() {
  if (fs.existsSync(COMMITTED_E9)) return fs.readFileSync(COMMITTED_E9, 'utf8');
  const tmp = path.join(FIXTURE_DIR, 'PeriousiakiKatastasi2027-2.txt');
  return fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : null;
}

describe('parseE9 — AADE category → type', () => {
  // The ΑΝΑΡΓΥΡΩΝ building lives in fixture 2027-2.
  const ANARGYRON = {
    // ATAK → { category, type } expected from the real E9 rows.
    '00849565730': { category: 5, type: 'storage' },
    '00849565756': { category: 5, type: 'storage' },
    '00849565799': { category: 5, type: 'storage' },
    '00849565801': { category: 5, type: 'storage' },
    '00849565810': { category: 6, type: 'parking' },
    '00849565852': { category: 6, type: 'parking' },
    '00849565772': { category: 6, type: 'parking' },
    '00849565780': { category: 1, type: 'apartment' },
    '00849565705': { category: 1, type: 'apartment' },
    '00849565828': { category: 1, type: 'apartment' }
  };

  test('parser extracts the AADE category digit for every ΑΝΑΡΓΥΡΩΝ row', () => {
    const text = readAnargyron();
    if (!text) return;
    const parsed = parseE9(text);
    const byAtak = new Map(
      parsed.buildings.flatMap((b) => b.units).map((u) => [u.atakNumber, u])
    );
    for (const [atak, expected] of Object.entries(ANARGYRON)) {
      const u = byAtak.get(atak);
      // (this jest config's expect() takes no message arg — encode the
      // ATAK in a thrown error instead so a failure is still legible)
      if (!u) throw new Error(`unit ${atak} was not parsed`);
      if (u.category !== expected.category) {
        throw new Error(
          `category for ${atak}: expected ${expected.category}, got ${u.category}`
        );
      }
    }
  });

  test('inferPropertyType maps every ΑΝΑΡΓΥΡΩΝ category to the right type (3 parking, 4 storage, 3 apartment)', () => {
    const text = readAnargyron();
    if (!text) return;
    const parsed = parseE9(text);
    const byAtak = new Map(
      parsed.buildings.flatMap((b) => b.units).map((u) => [u.atakNumber, u])
    );
    const counts = { storage: 0, parking: 0, apartment: 0 };
    for (const [atak, expected] of Object.entries(ANARGYRON)) {
      const u = byAtak.get(atak);
      if (!u) continue;
      const type = inferPropertyType({
        category: u.category,
        floor: u.floor,
        name: null
      });
      if (type !== expected.type) {
        throw new Error(
          `type for ${atak} (category ${u.category}): expected ${expected.type}, got ${type}`
        );
      }
      counts[type] = (counts[type] || 0) + 1;
    }
    // The bug was "all 7 basement units → storage". Guard the exact split.
    expect(counts.parking).toBe(3);
    expect(counts.storage).toBe(4);
    expect(counts.apartment).toBe(3);
  });

  test('category 6 must NOT classify as storage (the specific regression)', () => {
    expect(inferPropertyType({ category: 6, floor: -1, name: null })).toBe(
      'parking'
    );
    expect(inferPropertyType({ category: 5, floor: -1, name: null })).toBe(
      'storage'
    );
    // Floor fallback only when category is null — a basement with no
    // category is storage, but a basement WITH category 6 is parking.
    expect(inferPropertyType({ category: null, floor: -1, name: null })).toBe(
      'storage'
    );
  });
});
