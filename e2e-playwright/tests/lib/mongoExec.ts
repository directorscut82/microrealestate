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
  const escaped = script.replace(/"/g, '\\"');
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
