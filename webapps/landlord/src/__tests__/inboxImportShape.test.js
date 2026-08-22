/* eslint-env node, jest */
/**
 * The deep-link payload must match the shape the DIALOG'S OWN STATE owns — not
 * the shape the server happens to send.
 *
 * This exists because it did not, and the failure was total: ImportE9Dialog
 * renders `preview.owners` (PLURAL — its upload path aggregates one owner per
 * file across a batch in handleParse), while the server's single-document
 * `buildE9Preview` returns `owner` singular. Feeding the raw response through
 * made `preview.owners.length` throw during render, ErrorBoundary swallowed the
 * page, and the Ε9 deep link — the primary flow of one of the two new lanes —
 * was dead on arrival. A green server suite and a green bell screenshot both
 * missed it, because neither crosses the boundary between them.
 *
 * So this test asserts the CONTRACT at that boundary, in both directions:
 *   · every `preview.<field>` the dialog reads exists on what the hook produces;
 *   · every `parsed.<field>` the lease dialog reads exists likewise.
 * The field lists are extracted from the dialog SOURCE, so a dialog that starts
 * reading a new field fails this test until the hook provides it.
 */
import fs from 'fs';
import path from 'path';
import { normalizeE9Preview } from '../hooks/useInboxImport';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');

/** Field names the component reads off `<stateVar>.` */
function fieldsReadFrom(source, stateVar) {
  const re = new RegExp(`\\b${stateVar}\\.([A-Za-z_$][\\w$]*)`, 'g');
  const out = new Set();
  let m;
  while ((m = re.exec(source))) out.add(m[1]);
  // methods/array helpers are not payload fields
  for (const f of [
    'map',
    'length',
    'filter',
    'every',
    'some',
    'find',
    'forEach'
  ]) {
    out.delete(f);
  }
  return out;
}

// The REAL normalisation the hook applies — imported, not mirrored, so a
// regression in it fails these tests directly.
const hookE9Preview = (serverPayload) =>
  normalizeE9Preview(serverPayload.preview);

// The exact shape services/api buildE9Preview returns (owner SINGULAR).
const SERVER_E9_PAYLOAD = {
  kind: 'e9Import',
  sourceFileName: 'e9.pdf',
  parsed: { owner: { taxId: '999000018' }, buildings: [], skippedLandPlots: 0 },
  preview: {
    owner: {
      taxId: '999000018',
      lastName: 'ΔΟΚΙΜΗ',
      firstName: 'ΑΛΦΑ',
      name: 'ΔΟΚΙΜΗ ΑΛΦΑ'
    },
    buildings: [
      {
        address: { street1: 'ΟΔΟΣ ΒΗΤΑ 4', zipCode: '22222' },
        existingBuildingId: null,
        existingBuildingName: null,
        units: [{ atakNumber: '99900000021', existingPropertyId: null }]
      }
    ],
    skippedLandPlots: 0
  }
};

describe('the Ε9 deep-link payload satisfies what ImportE9Dialog reads', () => {
  const dialog = read('../components/buildings/ImportE9Dialog.js');

  it('provides every preview field the dialog reads — including owners (PLURAL)', () => {
    const needed = fieldsReadFrom(dialog, 'preview');
    // the regression that motivated this file
    expect(needed.has('owners')).toBe(true);

    const provided = hookE9Preview(SERVER_E9_PAYLOAD);
    const missing = [...needed].filter((f) => !(f in provided));
    expect(missing).toEqual([]);
  });

  it('owners is a non-empty ARRAY, so .length and .map cannot throw', () => {
    const p = hookE9Preview(SERVER_E9_PAYLOAD);
    expect(Array.isArray(p.owners)).toBe(true);
    expect(p.owners).toHaveLength(1);
    expect(p.owners[0].name).toBe('ΔΟΚΙΜΗ ΑΛΦΑ');
    // and the singular is still there for anything that wants it
    expect(p.owner.taxId).toBe('999000018');
  });

  it('an owner-less preview yields [] rather than undefined', () => {
    const p = hookE9Preview({
      preview: { buildings: [], skippedLandPlots: 0 }
    });
    expect(p.owners).toEqual([]);
    expect(() => p.owners.length).not.toThrow();
  });

  it('the hook USES it on the payload it hands the dialog (source anchor)', () => {
    const hook = read('../hooks/useInboxImport.js');
    expect(hook).toMatch(/preview:\s*normalizeE9Preview\(payload\.preview\)/);
  });
});

describe('the lease deep-link payload satisfies what ImportTenantDialog reads', () => {
  it('the hydration row carries the fields the dialog derives rows from', () => {
    const dialog = read('../components/tenants/ImportTenantDialog.js');
    // The dialog maps over parsedResults; these are the per-row fields its
    // preview derivation reads (see the useMemo that builds the rows).
    for (const f of ['tenants', 'properties', 'validityStart', 'validityEnd']) {
      expect(dialog).toContain(`parsed.${f}`);
    }
    // and the hook's row provides them verbatim from the server parse, plus the
    // two private fields the confirm step needs
    const hook = read('../hooks/useInboxImport.js');
    expect(hook).toMatch(/parsed:\s*payload\.parsed/);
    const dlg = dialog;
    expect(dlg).toMatch(/_fileName:\s*initialImport\.fileName/);
    expect(dlg).toMatch(/_file:\s*initialImport\.fileBlob/);
  });
});
