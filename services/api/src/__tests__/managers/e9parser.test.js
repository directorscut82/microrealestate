// T2.P1.22: E9 parser unit tests.
//
// TWO fixture sources:
//   1. The 5 user-submitted PDF text dumps under /tmp/e9-reaudit (full
//      owner PII) drive the broad invariant suite. These SKIP wherever
//      the local dumps are absent (e.g. CI) — by design, to avoid
//      committing tax IDs. Do NOT treat their green as coverage in CI.
//   2. A committed, REDACTED ΟΔΟΣ ΕΨΙΛΟΝ fixture (owner taxId scrubbed,
//      structural rows intact) at fixtures/e9/odos-epsilon-redacted.txt
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
import { fileURLToPath } from 'url';
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
    expectOwnerTaxId: '999000006',
    expectOwnerLast: 'ΔΟΚΙΜΗ',
    expectOwnerFirst: 'ΛΑΜΔΑ',
    expectMinBuildings: 2
  },
  {
    file: 'PeriousiakiKatastasi2027-1.txt',
    expectOwnerTaxId: '999000020',
    expectOwnerLast: 'ΔΟΚΙΜΗ',
    expectOwnerFirst: 'ΓΕΩΡΓΙΟΣ',
    expectMinBuildings: 1
  },
  {
    file: 'PeriousiakiKatastasi2027-2.txt',
    expectOwnerTaxId: '999000031',
    expectOwnerLast: 'ΔΟΚΙΜΗ',
    expectOwnerFirst: 'ΒΗΤΑ',
    expectMinBuildings: 2
  },
  {
    file: 'PeriousiakiKatastasi2027-4.txt',
    expectOwnerTaxId: '999000020',
    expectOwnerLast: 'ΔΟΚΙΜΗ',
    expectOwnerFirst: 'ΓΕΩΡΓΙΟΣ',
    expectMinBuildings: 1
  },
  {
    file: 'PeriousiakiKatastasi2027-5.txt',
    expectOwnerTaxId: '999000018',
    expectOwnerLast: 'ΔΟΚΙΜΗ',
    expectOwnerFirst: 'ΚΑΠΠΑ',
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
  // T2.P1.3 (REVISED): the ΠΕΡΙΟΧΗ ΘΗΤΑ row in 2027-1 (ATAK 00112233393,
  // 410.18 m²) is a bare PLOT, not a building — AADE stamps it
  // ΚΑΤΗΓΟΡΙΑ ΑΚΙΝΗΤΟΥ 0 with NO electricity meter, whereas the genuine
  // apartments on the same filing carry category 1 + a DEH number. The
  // settlement-block-plot address pattern still PARSES the row (so a real
  // block-plot BUILDING with a κτίσμα would be importable), but
  // isRealBuildingUnit now rejects a category-0/no-DEH row as land. So the
  // row must NOT surface as a building and must be counted in
  // skippedLandPlots. (Earlier this test asserted the opposite — that
  // mistaken expectation is what let a 410 m² οικόπεδο import as a building;
  // the owner flagged it. Real AADE type code, not a surface heuristic.)
  test('T2.P1.3: settlement block-plot PLOT (category 0, no DEH) is skipped as land, not a building', () => {
    const text = readFixture('PeriousiakiKatastasi2027-1.txt');
    if (!text) return; // fixture missing — handled at suite level
    const parsed = parseE9(text);
    const allUnits = parsed.buildings.flatMap((b) => b.units);
    const plot = allUnits.find(
      (u) =>
        u.atakNumber === '00112233393' || Math.abs(u.surface - 410.18) < 0.01
    );
    expect(plot).toBeFalsy(); // not imported as a building unit
    expect(parsed.skippedLandPlots).toBeGreaterThan(0);
    // The genuine apartments on the same filing (ΟΔΟΣ ΖΗΤΑ 9, category 1
    // + DEH) MUST still import — the guard rejects ONLY category-0/no-DEH.
    const realUnits = allUnits.filter((u) => u.electricitySupplyNumber);
    expect(realUnits.length).toBeGreaterThan(0);
  });

  // T2.P1.4 spot-check: a row with a 50,0 ownership fraction (ΟΔΟΣ ΔΟΚΙΜΗΣ
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
    // Fixture has 5 ΟΔΟΣ ΗΤΑ 24 units at 50% each.
    expect(halfOwned.length).toBeGreaterThanOrEqual(1);
  });
});

// ───────────────────────────────────────────────────────────────────────
// AADE category → property-type mapping. THIS BLOCK EXISTS BECAUSE THE
// WHOLE SUITE PREVIOUSLY ASSERTED EVERYTHING EXCEPT category and the
// resulting type — so a real building (ΟΔΟΣ ΕΨΙΛΟΝ 28) imported with
// 7 basement units silently classified ALL of them 'storage' when 3 are
// actually category-6 PARKING. A user found it by eye; no test did.
//
// We assert the full chain on the real PDF dump: the parser must extract
// the category digit per row, AND inferPropertyType must map it to the
// right type. 5→storage (αποθήκη), 6→parking, 1→apartment.
// ───────────────────────────────────────────────────────────────────────
// This block does NOT use skipIfNoFixtures: the ΟΔΟΣ ΕΨΙΛΟΝ rows are
// committed (redacted: owner taxId scrubbed to 000000000, structural row
// data intact) at fixtures/e9/odos-epsilon-redacted.txt, so the category→type
// regression runs in CI — unlike the /tmp/e9-reaudit suite above, which
// silently skips wherever those local dumps are absent (the gap that let
// the parking misclassification ship). Falls back to the /tmp dump if the
// committed one is somehow missing.
// This package is `type: module`, so `__dirname` is not defined — derive the
// test-file directory from import.meta.url instead.
const __testDir = path.dirname(fileURLToPath(import.meta.url));
const COMMITTED_E9 = path.resolve(
  __testDir,
  '../fixtures/e9/odos-epsilon-redacted.txt'
);
function readOdosepsilon() {
  if (fs.existsSync(COMMITTED_E9)) return fs.readFileSync(COMMITTED_E9, 'utf8');
  const tmp = path.join(FIXTURE_DIR, 'PeriousiakiKatastasi2027-2.txt');
  return fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : null;
}

describe('parseE9 — AADE category → type', () => {
  // The ΟΔΟΣ ΕΨΙΛΟΝ building lives in fixture 2027-2.
  const OdosEpsilon = {
    // ATAK → { category, type } expected from the real E9 rows.
    '00998877730': { category: 5, type: 'storage' },
    '00998877756': { category: 5, type: 'storage' },
    '00998877799': { category: 5, type: 'storage' },
    '00998877801': { category: 5, type: 'storage' },
    '00998877810': { category: 6, type: 'parking' },
    '00998877852': { category: 6, type: 'parking' },
    '00998877772': { category: 6, type: 'parking' },
    '00998877780': { category: 1, type: 'apartment' },
    '00998877705': { category: 1, type: 'apartment' },
    '00998877828': { category: 1, type: 'apartment' }
  };

  test('parser extracts the AADE category digit for every ΟΔΟΣ ΕΨΙΛΟΝ row', () => {
    const text = readOdosepsilon();
    if (!text) return;
    const parsed = parseE9(text);
    const byAtak = new Map(
      parsed.buildings.flatMap((b) => b.units).map((u) => [u.atakNumber, u])
    );
    for (const [atak, expected] of Object.entries(OdosEpsilon)) {
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

  test('inferPropertyType maps every ΟΔΟΣ ΕΨΙΛΟΝ category to the right type (3 parking, 4 storage, 3 apartment)', () => {
    const text = readOdosepsilon();
    if (!text) return;
    const parsed = parseE9(text);
    const byAtak = new Map(
      parsed.buildings.flatMap((b) => b.units).map((u) => [u.atakNumber, u])
    );
    const counts = { storage: 0, parking: 0, apartment: 0 };
    for (const [atak, expected] of Object.entries(OdosEpsilon)) {
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

// ───────────────────────────────────────────────────────────────────────
// BARE-PLOT GUARD (isRealBuildingUnit ↔ AADE ΚΑΤΗΓΟΡΙΑ ΑΚΙΝΗΤΟΥ). Runs in
// CI off the committed redacted ΟΔΟΣ ΕΨΙΛΟΝ fixture (no /tmp dependency).
// A 410 m² ΠΕΡΙΟΧΗ ΘΗΤΑ parcel (category 0, no DEH meter) was wrongly imported
// as a building; the guard must reject category-0/no-DEH rows as land WHILE
// keeping every genuine unit (category ≥ 1 OR a DEH meter). These assertions
// pin the invariant on real data so the guard can't silently regress.
// ───────────────────────────────────────────────────────────────────────
describe('parseE9 — bare-plot guard (AADE category 0 + no DEH = land)', () => {
  test('every imported ΟΔΟΣ ΕΨΙΛΟΝ unit is a genuine building unit (category≥1 OR has a DEH meter)', () => {
    const text = readOdosepsilon();
    if (!text) return;
    const parsed = parseE9(text);
    const units = parsed.buildings.flatMap((b) => b.units);
    expect(units.length).toBeGreaterThan(0);
    for (const u of units) {
      const kept =
        (typeof u.category === 'number' && u.category >= 1) ||
        !!u.electricitySupplyNumber ||
        u.isElectrified;
      if (!kept) {
        throw new Error(
          `unit ${u.atakNumber} survived the guard but is category=${u.category} with no DEH — would be a bare plot`
        );
      }
    }
  });
});
