/**
 * The provider vocabulary is written out in FIVE places. They must agree.
 *
 * WHY THIS EXISTS. Adding telecom support meant touching, in order: the expense
 * `type` enum, the shared-meter `provider` enum, `ALLOWED_PROVIDERS` in
 * buildingmanager, `VALID_PROVIDERS` in billmanager, the UI select, and the
 * prefill's provider→type maps. Each commit added one and left the next
 * unreachable — a type with no provider, a provider with no field, a field with no
 * matcher. The last one was the worst, because it failed LATE: `Bill.provider`
 * still had the 4-value enum, so a NOVA bill passed every validator, ran ~50s of
 * OCR, and then died on `save()` with a mongoose ValidationError. The landlord
 * would have seen the OCR complete and the confirm fail.
 *
 * These assertions read the actual sources, so the next person to add a provider
 * gets told which list they missed instead of finding out at write time.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');

/**
 * The quoted literals of a `enum: [...]` / `const X = [...]` array.
 *
 * Parses the QUOTED STRINGS rather than splitting on commas: these arrays carry
 * explanatory comments, and a comment containing a comma silently split a value
 * in half the last time this was parsed by hand — the parse "succeeded" and
 * dropped `electricity_private`.
 */
function literalsOf(source, marker) {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const open = source.indexOf('[', at);
  const close = source.indexOf(']', open);
  if (open < 0 || close < 0) throw new Error(`no array after: ${marker}`);
  const body = source.slice(open + 1, close);
  return (body.match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
}

// The canonical vocabulary. `nova` is a BRAND the parser recognises on a
// document; `telecom` is the SERVICE the landlord picks in the UI. Both must be
// storable — a landlord on Cosmote picks the service, a NOVA document parses to
// the brand, and the same expense type serves both.
const PROVIDERS = ['deh', 'eydap', 'epa', 'telecom', 'nova', 'other'];

describe('provider vocabulary parity', () => {
  it('Bill.provider accepts every provider (the late-failing one)', () => {
    const got = literalsOf(read('../../../common/src/collections/bill.ts'), 'provider: {');
    expect(got.sort()).toEqual([...PROVIDERS].sort());
  });

  it('SharedMeterSchema.provider accepts every provider', () => {
    const src = read('../../../common/src/collections/building.ts');
    // The shared-meter enum, not the expense-type enum: anchor on the schema.
    const at = src.indexOf('SharedMeterSchema');
    expect(at).toBeGreaterThan(-1);
    const got = literalsOf(src.slice(at), 'provider: {');
    expect(got.sort()).toEqual([...PROVIDERS].sort());
  });

  it('billmanager VALID_PROVIDERS matches', () => {
    const got = literalsOf(
      read('../managers/billmanager.ts'),
      'const VALID_PROVIDERS'
    );
    expect(got.sort()).toEqual([...PROVIDERS].sort());
  });

  it('buildingmanager ALLOWED_PROVIDERS matches', () => {
    const got = literalsOf(
      read('../managers/buildingmanager.ts'),
      'const ALLOWED_PROVIDERS'
    );
    expect(got.sort()).toEqual([...PROVIDERS].sort());
  });

  it('the BillProvider TYPE matches, so TS cannot drift from the schema', () => {
    const src = read('../../../../types/src/common/collections.ts');
    const at = src.indexOf('export type BillProvider');
    expect(at).toBeGreaterThan(-1);
    const decl = src.slice(at, src.indexOf(';', at));
    const got = (decl.match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
    expect(got.sort()).toEqual([...PROVIDERS].sort());
  });

  it('every provider maps to an expense type on BOTH sides of the meter', () => {
    // The prefill decides the expense `type` from the provider AND whose meter it
    // is. A provider missing from either map falls back to `other`, which files a
    // utility bill under no cost category — and `other` is indistinguishable from
    // "we could not identify this bill".
    const src = read(
      '../../../../webapps/landlord/src/utils/billExpensePrefill.js'
    );
    for (const name of ['PROVIDER_TYPE_SHARED', 'PROVIDER_TYPE_PRIVATE']) {
      const at = src.indexOf(`const ${name}`);
      expect({ map: name, found: at > -1 }).toEqual({ map: name, found: true });
      const body = src.slice(at, src.indexOf('};', at));
      for (const p of PROVIDERS) {
        if (p === 'other') continue; // `other` IS the fallback; no entry needed.
        expect({ map: name, provider: p, mapped: new RegExp(`\\b${p}:`).test(body) }).toEqual(
          { map: name, provider: p, mapped: true }
        );
      }
    }
  });

  it('every provider has a Greek display label', () => {
    const src = read(
      '../../../../webapps/landlord/src/utils/billExpensePrefill.js'
    );
    const at = src.indexOf('const PROVIDER_LABEL');
    const body = src.slice(at, src.indexOf('};', at));
    for (const p of PROVIDERS) {
      if (p === 'other') continue;
      expect({ provider: p, labelled: new RegExp(`\\b${p}:`).test(body) }).toEqual({
        provider: p,
        labelled: true
      });
    }
  });

  it('the UI offers the SERVICE, never a lone brand as the axis', () => {
    // `nova` must be storable but must NOT be what the landlord picks: offering
    // one company as the kind of service left a landlord on Cosmote or Vodafone
    // unable to record a telecom line at all.
    const src = read('../../../../webapps/landlord/src/components/buildings/BuildingForm.js');
    expect(src).toContain('<SelectItem value="telecom">');
    expect(src).not.toContain('<SelectItem value="nova">');
  });
});
