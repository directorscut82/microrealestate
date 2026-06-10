/**
 * Wave-26 round-3s: helper to read live mongo state via Portainer
 * exec API. Used by E2E specs to verify UI writes round-trip into the
 * database correctly. Inline (no local script files) so other team
 * members don't need to copy a Python helper.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORTAINER_TOKEN = (() => {
  try {
    return fs
      .readFileSync(
        path.resolve(__dirname, '../../../.secrets/portainer-token'),
        'utf8'
      )
      .trim();
  } catch {
    return '';
  }
})();

const PY_HELPER = `
import json, os, sys, urllib.request, ssl
ctx = ssl._create_unverified_context()
base = "http://192.168.0.96:9000"
ptoken = os.environ['PTOKEN']
cid = os.environ['CID']
cmd = sys.argv[1]
req = urllib.request.Request(
  f"{base}/api/endpoints/3/docker/containers/{cid}/exec",
  method="POST",
  headers={"X-API-Key": ptoken, "Content-Type": "application/json"},
  data=json.dumps({"AttachStdout": True, "AttachStderr": True, "Cmd": ["sh","-c",cmd]}).encode(),
)
exec_id = json.loads(urllib.request.urlopen(req, context=ctx).read())["Id"]
req2 = urllib.request.Request(
  f"{base}/api/endpoints/3/docker/exec/{exec_id}/start",
  method="POST",
  headers={"X-API-Key": ptoken, "Content-Type": "application/json"},
  data=json.dumps({"Detach": False, "Tty": False}).encode(),
)
resp = urllib.request.urlopen(req2, context=ctx).read()
out = b""; i = 0
while i < len(resp):
  if i + 8 > len(resp): break
  sz = int.from_bytes(resp[i+4:i+8], 'big')
  out += resp[i+8:i+8+sz]
  i += 8 + sz
sys.stdout.buffer.write(out)
`;

let _cachedCid: string | null = null;
function _resolveMongoCid(): string {
  if (_cachedCid) return _cachedCid;
  const listCmd = `python3 -c "
import json, urllib.request, ssl
ctx = ssl._create_unverified_context()
req = urllib.request.Request('http://192.168.0.96:9000/api/endpoints/3/docker/containers/json', headers={'X-API-Key': '${PORTAINER_TOKEN}'})
data = json.loads(urllib.request.urlopen(req, context=ctx).read())
for c in data:
  if 'mongo' in c.get('Names', [''])[0]:
    print(c['Id'][:12]); break
"`;
  _cachedCid = execSync(listCmd, { encoding: 'utf8' }).trim();
  return _cachedCid;
}

/**
 * Run a mongo shell `--eval` against the NAS mongo container. Returns
 * trimmed stdout. Throws on non-zero exit. Skip the test (return null)
 * if portainer-token isn't available locally — keeps the CI dry-run
 * happy.
 */
export function mongoExec(script: string): string | null {
  if (!PORTAINER_TOKEN) return null;
  const cid = _resolveMongoCid();
  // Escape both " (for the --eval double-quoted wrapper) AND $ (the inner
  // shell that runs the docker exec sees the script and would expand
  // $set as variable-substitution → syntax error in mongo shell).
  const escaped = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
  const cmd = `mongo mongodb://localhost:27017/mredb --quiet --eval "${escaped}"`;
  return execSync(
    `python3 -c "${PY_HELPER.replace(/"/g, '\\"')}" '${cmd.replace(/'/g, "'\\''")}'`,
    {
      encoding: 'utf8',
      env: { ...process.env, PTOKEN: PORTAINER_TOKEN, CID: cid }
    }
  ).trim();
}

export interface MongoPayment {
  amount: number;
  date: string;
  type: string;
  reference?: string;
  description?: string;
  promo?: number;
  notepromo?: string;
  extracharge?: number;
  noteextracharge?: string;
  allocation?: { category: string; amount: number }[];
}

export interface MongoRentSnapshot {
  payments: MongoPayment[];
  total: {
    grandTotal: number;
    payment: number;
    balance: number;
    preTaxAmount: number;
  };
  discounts: any[];
  debts: any[];
}

export function readRent(
  tenantName: string,
  term: number
): MongoRentSnapshot | null {
  const out = mongoExec(`
    var t = db.occupants.findOne({name: "${tenantName.replace(/"/g, '\\"')}"});
    if (!t) { print("null"); quit(); }
    var r = (t.rents || []).find(function(r){ return r.term === ${term}; });
    if (!r) { print("null"); quit(); }
    print(JSON.stringify({
      payments: r.payments || [],
      total: r.total || {},
      discounts: r.discounts || [],
      debts: r.debts || []
    }));
  `);
  if (!out || out === 'null') return null;
  return JSON.parse(out);
}

/**
 * Direct-insert a tenant via mongo, bypassing API validators. Used by
 * specs that need to test the UI's bad-data handling — e.g.,
 * TenantListItem missing-fields warning badges. The API correctly
 * rejects taxId='123' (not a valid AFM), so the only way to test the
 * "tenant exists with bad data" UI path is to put bad data directly in
 * mongo, simulating a legacy import or partially-completed entry.
 *
 * Returns the inserted _id (string), or null if portainer-token is
 * missing locally (graceful skip — tests should `test.skip(!id, '...')`
 * not throw).
 */
export interface MongoTenantSeed {
  realmId: string;
  name: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  legalForm?: string;
  isCompany?: boolean;
  taxId?: string;
  archived?: boolean;
  beginDate?: Date | string;
  endDate?: Date | string;
  terminationDate?: Date | string;
}

export function insertTenantDirect(seed: MongoTenantSeed): string | null {
  const doc = {
    realmId: seed.realmId,
    name: seed.name,
    firstName: seed.firstName ?? '',
    lastName: seed.lastName ?? '',
    company: seed.company ?? '',
    legalForm: seed.legalForm ?? '',
    isCompany: seed.isCompany ?? false,
    taxId: seed.taxId ?? '',
    archived: seed.archived ?? false,
    properties: [],
    rents: [],
    contacts: [],
    leaseHistory: [],
    expiryNoticesSent: [],
    stepperMode: false,
    __v: 0
  };
  if (seed.beginDate)
    (doc as any).beginDate = new Date(seed.beginDate as any);
  if (seed.endDate) (doc as any).endDate = new Date(seed.endDate as any);
  if (seed.terminationDate)
    (doc as any).terminationDate = new Date(seed.terminationDate as any);
  // Mongo legacy collection name is `occupants`.
  const out = mongoExec(`
    var doc = ${JSON.stringify(doc)};
    var r = db.occupants.insertOne(doc);
    print(r.insertedId.valueOf ? r.insertedId.valueOf() : r.insertedId);
  `);
  if (!out) return null;
  // mongo 4.4 prints ObjectId("...") — strip the wrapper.
  const m = out.match(/[a-f0-9]{24}/);
  return m ? m[0] : null;
}

/**
 * Delete a tenant by _id via direct mongo. Used to clean up
 * bad-data fixtures inserted via insertTenantDirect since the API
 * tenant-delete endpoint requires a valid taxId for some checks.
 */
export function deleteTenantDirect(id: string): boolean {
  const out = mongoExec(`
    var r = db.occupants.deleteOne({_id: ObjectId("${id}")});
    print(r.deletedCount);
  `);
  return out === '1';
}

/**
 * Read a tenant doc by name (in a given realm) — for round-trip
 * assertions on schema-only fields like expiryNoticesSent that the
 * API doesn't surface in the JSON response.
 */
export function readTenant(
  realmId: string,
  name: string
): Record<string, any> | null {
  const out = mongoExec(`
    var t = db.occupants.findOne({realmId: "${realmId}", name: "${name.replace(/"/g, '\\"')}"});
    if (!t) { print("null"); quit(); }
    print(JSON.stringify(t));
  `);
  if (!out || out === 'null') return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * Read a building doc by name + realmId — used for verifying
 * customAllocations[0].propertyId, monthlyCharges, etc. on the
 * persisted shape.
 */
export function readBuilding(
  realmId: string,
  name: string
): Record<string, any> | null {
  const out = mongoExec(`
    var b = db.buildings.findOne({realmId: "${realmId}", name: "${name.replace(/"/g, '\\"')}"});
    if (!b) { print("null"); quit(); }
    print(JSON.stringify(b));
  `);
  if (!out || out === 'null') return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}
