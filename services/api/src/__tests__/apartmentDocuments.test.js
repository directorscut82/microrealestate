/**
 * An apartment can hold its own documents.
 *
 * WHY THIS EXISTS. `Document` had `tenantId | buildingId | ownerKey` and nothing
 * else, and `POST /documents` refused any payload that did not carry EXACTLY ONE
 * of those three. So an apartment's own papers — a private ΔΕΗ/ΕΥΔΑΠ bill, an
 * energy certificate, photos of a unit — had nowhere to be stored, and the
 * property page had no documents surface at all. The building tab was not a
 * substitute: those are the κοινόχρηστα papers, shared by every unit.
 *
 * The assertions read the sources, because the failure mode here is a field added
 * in one layer and missing from the next — the shape that has bitten this feature
 * on every commit (a type with no provider, a provider with no field, a field with
 * no matcher). Five layers have to agree: schema, index, TS type, the create
 * guard's entity count + cross-realm check, the list filter, and the panel.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');

const SCHEMA = read('../../../common/src/collections/document.ts');
const ROUTE = read('../../../pdfgenerator/src/routes/documents.ts');
const TYPES = read('../../../../types/src/common/collections.ts');
const PANEL = read(
  '../../../../webapps/landlord/src/components/documents/DocumentsPanel.js'
);
const PAGE = read(
  '../../../../webapps/landlord/src/pages/[organization]/properties/[id].js'
);

describe('Document.propertyId — the storage layer', () => {
  it('the schema declares the field', () => {
    expect(SCHEMA).toMatch(/propertyId: \{ type: String \}/);
  });

  it('it is indexed per realm, like every other entity key', () => {
    // Without the index, the apartment panel's query is a realm-wide collection
    // scan on every mount — the same cost the other three avoid.
    expect(SCHEMA).toContain(
      'DocumentSchema.index({ realmId: 1, propertyId: 1 });'
    );
  });

  it('the TS type carries it, so a handler cannot silently drop it', () => {
    // `export type Document = {` — a type alias, not an interface. Anchoring on
    // the wrong keyword made this assertion read an empty slice and it would
    // have passed vacuously for the negative case.
    const at = TYPES.indexOf('export type Document = {');
    expect(at).toBeGreaterThan(-1);
    const block = TYPES.slice(at, TYPES.indexOf('};', at));
    expect(block).toContain('propertyId?: string;');
    // The other three must still be there — this is an addition, not a swap.
    for (const f of ['tenantId?: string;', 'buildingId?: string;', 'ownerKey?: string;']) {
      expect({ field: f, present: block.includes(f) }).toEqual({
        field: f,
        present: true
      });
    }
  });
});

describe('POST /documents — the create path', () => {
  it('counts propertyId as an entity, so the payload is accepted', () => {
    // The guard demands exactly one. A propertyId-only payload was previously
    // counted as ZERO entities and rejected 422 — after its bytes had already
    // been uploaded, orphaning the file.
    const at = ROUTE.indexOf('const entityCount = [');
    // Terminate on `].filter(`, NOT on `];` — this array has no `];` at all, so
    // slicing to the next `];` swallowed 150 lines and matched the propertyId in
    // the cross-realm check below. The assertion passed with the entry deleted;
    // mutation-testing it is the only reason that was caught.
    const block = ROUTE.slice(at, ROUTE.indexOf('].filter(', at));
    expect(block).toContain('dataSet.propertyId');
    // All four, and only four.
    expect(block.match(/dataSet\.\w+/g)).toEqual([
      'dataSet.tenantId',
      'dataSet.buildingId',
      'dataSet.propertyId',
      'dataSet.ownerKey'
    ]);
    // Still exactly one: propertyId + buildingId together must remain a 422, or
    // a document would belong to two entities and appear on two surfaces.
    expect(ROUTE).toContain('if (entityCount !== 1)');
  });

  it('verifies the apartment belongs to THIS realm before minting the record', () => {
    // Same cross-realm guard the tenant/building/owner branches carry. The ids
    // come from the request body; without this an attacker could attach a
    // document to another realm's apartment.
    const at = ROUTE.indexOf('if (dataSet.propertyId) {');
    expect(at).toBeGreaterThan(-1);
    const block = ROUTE.slice(at, at + 500);
    expect(block).toContain('Collections.Property.exists');
    expect(block).toMatch(/_id: dataSet\.propertyId/);
    expect(block).toContain('realmId');
    expect(block).toMatch(/404/);
  });

  it('persists the field (a guard that accepts but does not store is worse than a refusal)', () => {
    expect(ROUTE).toContain(
      '...(dataSet.propertyId ? { propertyId: dataSet.propertyId } : {}),'
    );
  });

  it('the guard error names the field it now accepts', () => {
    // The log line is the only diagnostic when this 422s in production.
    expect(ROUTE).toContain(
      'document requires exactly one of tenantId/buildingId/propertyId/ownerKey'
    );
  });
});

describe('GET /documents — the list path', () => {
  it('filters by ?propertyId=', () => {
    // Absent this, the panel would fall back to the unfiltered query and show
    // EVERY file in the realm under one apartment.
    expect(ROUTE).toContain('if (req.query.propertyId)');
    expect(ROUTE).toContain('filter.propertyId = String(req.query.propertyId);');
  });
});

describe('the CLIENT actually sends the filter', () => {
  const RESTCALLS = read('../../../../webapps/landlord/src/utils/restcalls.js');

  it('fetchDocuments forwards propertyId', () => {
    // The route filter is useless if the query string never carries the key.
    // `fetchDocuments` is an ALLOW-LIST and an unknown key FAILS OPEN: with
    // propertyId missing the params came out empty and the request meant "every
    // document in the realm", so the apartment tab listed every file the landlord
    // owns under one flat. Nothing errored and the list looked populated — caught
    // only by opening the screen and comparing it to what mongo held (0 documents
    // with a propertyId, 1 file rendered).
    const at = RESTCALLS.indexOf('export async function fetchDocuments');
    const block = RESTCALLS.slice(at, RESTCALLS.indexOf('\n}', at));
    expect(block).toContain("params.set('propertyId', entityFilter.propertyId)");
  });

  it('forwards all four entity keys — none may be dropped', () => {
    const at = RESTCALLS.indexOf('export async function fetchDocuments');
    const block = RESTCALLS.slice(at, RESTCALLS.indexOf('\n}', at));
    for (const k of ['tenantId', 'buildingId', 'propertyId', 'ownerKey']) {
      expect({ key: k, sent: block.includes(`params.set('${k}'`) }).toEqual({
        key: k,
        sent: true
      });
    }
  });
});

describe('DocumentsPanel — the UI contract', () => {
  it('resolves propertyId BEFORE buildingId', () => {
    // An apartment panel legitimately knows both. If buildingId won, the tab
    // would list the building's κοινόχρηστα papers under the apartment.
    const at = PANEL.indexOf('const entityFilter = useMemo');
    const block = PANEL.slice(at, PANEL.indexOf('}, [entity]);', at));
    const iProp = block.indexOf('entity?.propertyId');
    const iBldg = block.indexOf('entity?.buildingId');
    expect({ propertyFirst: iProp > -1 && iProp < iBldg }).toEqual({
      propertyFirst: true
    });
  });

  it('the create sends ONE entity id, not a spread of whatever it was given', () => {
    // `{...entity}` would forward propertyId AND buildingId together, uploading
    // the bytes and then 422-ing the record — a paid-for orphan in B2.
    expect(PANEL).toContain('...createEntity,');
    expect(PANEL).not.toContain('...entity,\n          type:');
  });

  it('the tenant branch still carries leaseId (its create requires it)', () => {
    const at = PANEL.indexOf('const createEntity = useMemo');
    const block = PANEL.slice(at, PANEL.indexOf('}, [entityFilter, entity]);', at));
    expect(block).toContain('leaseId');
  });
});

describe('the property page mounts it', () => {
  it('has a documents tab', () => {
    expect(PAGE).toContain('<TabsTrigger value="documents"');
    expect(PAGE).toContain('data-cy="documentsTab"');
  });

  it('passes propertyId alone', () => {
    expect(PAGE).toContain('entity={{ propertyId: property?._id }}');
    // Belt and braces on the orphan trap: no buildingId anywhere in the mount.
    const at = PAGE.indexOf('<DocumentsPanel');
    const mount = PAGE.slice(at, PAGE.indexOf('/>', at));
    expect(mount).not.toContain('buildingId');
  });

  it('keeps the details form reachable (the tab must not replace it)', () => {
    expect(PAGE).toContain('<TabsTrigger value="details"');
    expect(PAGE).toContain('<PropertyForm property={property} onSubmit={onSubmit} />');
  });
});
