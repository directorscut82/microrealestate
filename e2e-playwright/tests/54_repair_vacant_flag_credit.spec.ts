/**
 * §2 chargeOwnerWhenVacant on repairs + the inert-credit money model, verified
 * on a DEDICATED mongo-seeded building (the shared rich building in spec 51 is
 * polluted by prior runs — RichUnit thousandths drift, propertyId-less units —
 * so it can't deterministically exercise vacant-unit routing). Seeds via direct
 * mongo insert (mongoExec), drives the REAL _distributeRepairCharge via the API,
 * reads back via mongo. Mirrors spec 49's pattern.
 *
 * Covers the 59b36000 batch:
 *  - §2 flag ON  → a vacant unit's repair share routes to the owner (repair-vacant).
 *  - §2 flag OFF → the share is Αχρέωτα (no owner row).
 *  - inert credit: cancel a PAID owners-repair → credit survives (money kept);
 *    un-cancel → credit + re-opened liability reconcile to €0 net outstanding.
 */
import { expect, request, test } from '@playwright/test';
import { mongoExec } from './lib/mongoExec';
import { getAccessToken } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const ORG_NAME = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';

const B_NAME = 'E2E54-RepairFlag-Building';
const BID = 'aa0000000000000000000054';
const P_OCC = 'aa0000000000000000005401'; // occupied
const P_VAC = 'aa0000000000000000005402'; // vacant

const now = new Date();
const YEAR = now.getFullYear();
const MM = String(now.getMonth() + 1).padStart(2, '0');
const TERM = Number(`${YEAR}${MM}0100`);

let realmId = '';
let token = '';
let auth: Record<string, string> = {};

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

function q(s: string) {
  return s.replace(/"/g, '\\"');
}

// A clean 2-unit building: one occupied (P_OCC, tenant linked), one vacant
// (P_VAC). Equal thousandths so a 100%-tenant repair splits 50/50: the occupied
// half bills the tenant, the vacant half is the §2 routing decision.
function seedBuilding() {
  return mongoExec(`
    var r = db.realms.findOne({name: "${q(ORG_NAME)}"});
    if (!r) { print("NO_REALM"); quit(); }
    var rid = String(r._id.valueOf());
    db.buildings.deleteOne({_id: ObjectId("${BID}")});
    db.occupants.deleteMany({name: /^E2E54-/});
    db.buildings.insertOne({
      _id: ObjectId("${BID}"),
      realmId: rid,
      name: "${B_NAME}",
      atakPrefix: "E2E54",
      address: { street1: "T", city: "T", zipCode: "00000" },
      units: [
        { _id: ObjectId(), atakNumber: "E2E54-UOcc", isManaged: true, occupancyType: "rented", propertyId: "${P_OCC}", generalThousandths: 500, heatingThousandths: 0, elevatorThousandths: 0, surface: 50, monthlyCharges: [] },
        { _id: ObjectId(), atakNumber: "E2E54-UVac", isManaged: true, occupancyType: "vacant", propertyId: "${P_VAC}", generalThousandths: 500, heatingThousandths: 0, elevatorThousandths: 0, surface: 50, monthlyCharges: [] }
      ],
      expenses: [],
      repairs: [],
      ownerMonthlyExpenses: [],
      createdDate: new Date(), updatedDate: new Date(), __v: 0
    });
    db.occupants.insertOne({
      realmId: rid, name: "E2E54-Tenant", isCompany: false,
      beginDate: new Date(${YEAR}, 0, 1), endDate: new Date(${YEAR}, 11, 31),
      terminationDate: null,
      properties: [{ propertyId: "${P_OCC}", entryDate: new Date(${YEAR},0,1), exitDate: new Date(${YEAR},11,31), property: { name: "E2E54-POcc" } }],
      rents: []
    });
    print(rid);
  `);
}

function readOwnerRows() {
  const out = mongoExec(`
    var b = db.buildings.findOne({_id: ObjectId("${BID}")});
    if (!b) { print("null"); quit(); }
    print(JSON.stringify((b.ownerMonthlyExpenses||[]).map(function(e){
      var paid = (e.payments||[]).reduce(function(s,p){return s+(Number(p.amount)||0);},0);
      return { expenseId: String(e.expenseId), term: e.term, amount: e.amount, source: e.source, propertyId: e.propertyId, paidSum: paid };
    })));
  `);
  if (!out || out === 'null') return null;
  return JSON.parse(
    String(out).split('\n').map((l) => l.trim()).filter(Boolean).pop()!
  ) as Array<{
    expenseId: string;
    term: number;
    amount: number;
    source: string;
    propertyId: string | null;
    paidSum: number;
  }>;
}

async function createRepair(data: Record<string, any>): Promise<any> {
  const resp = await request
    .newContext()
    .then((c) =>
      c.post(`${GATEWAY}/api/v2/buildings/${BID}/repairs`, {
        headers: auth,
        data
      })
    );
  expect(resp.status(), `create repair ${data.title}`).toBe(200);
  const json = await resp.json();
  return json.repairs?.find((r: any) => r.title === data.title);
}

async function patchRepair(repairId: string, data: Record<string, any>) {
  const ctx = await request.newContext();
  const resp = await ctx.patch(
    `${GATEWAY}/api/v2/buildings/${BID}/repairs/${repairId}`,
    { headers: auth, data }
  );
  expect(resp.status(), `patch repair ${repairId}`).toBe(200);
  return resp.json();
}

test.beforeAll(async () => {
  const probe = mongoExec('print("ok")');
  test.skip(probe === null, 'portainer-token absent — cannot reach NAS mongo');
  const apiCtx = await request.newContext();
  token = await getAccessToken(apiCtx);
  await apiCtx.dispose();
  const raw = seedBuilding();
  const last = String(raw).split('\n').map((l) => l.trim()).filter(Boolean).pop()!;
  expect(last, 'realm found').not.toBe('NO_REALM');
  const m = last.match(/[a-f0-9]{24}/i);
  expect(m, `realmId in: ${last}`).toBeTruthy();
  realmId = m![0];
  auth = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    organizationid: realmId
  };
});

test.afterAll(async () => {
  mongoExec(`
    db.buildings.deleteOne({_id: ObjectId("${BID}")});
    db.occupants.deleteMany({name: /^E2E54-/});
    print("cleaned");
  `);
});

test('54.1 §2 flag ON — vacant unit repair share routes to the owner (repair-vacant)', async () => {
  const repair = await createRepair({
    title: 'E2E54-FlagOn',
    category: 'plumbing',
    chargeableTo: 'tenants',
    tenantSharePercentage: 100,
    chargeTerm: TERM,
    actualCost: 200,
    allocationMethod: 'general_thousandths',
    status: 'planned',
    chargeOwnerWhenVacant: true
  });
  expect(repair).toBeDefined();
  const rows = readOwnerRows()!;
  const rv = rows.filter(
    (e) => e.source === 'repair-vacant' && e.expenseId === repair._id
  );
  expect(rv.length, 'repair-vacant row created for the vacant unit').toBe(1);
  // 50/50 split of €200 → €100 to the vacant unit's owner.
  expect(rv[0].amount).toBeCloseTo(100, 1);
  expect(String(rv[0].propertyId)).toBe(P_VAC);
  await patchRepair(repair._id, { status: 'cancelled' }); // tidy
});

test('54.2 §2 flag OFF (default) — vacant unit share becomes Αχρέωτα, NO owner row', async () => {
  const repair = await createRepair({
    title: 'E2E54-FlagOff',
    category: 'plumbing',
    chargeableTo: 'tenants',
    tenantSharePercentage: 100,
    chargeTerm: TERM,
    actualCost: 200,
    allocationMethod: 'general_thousandths',
    status: 'planned'
    // chargeOwnerWhenVacant omitted → default false
  });
  expect(repair).toBeDefined();
  const rows = readOwnerRows()!;
  const rv = rows.filter(
    (e) => e.source === 'repair-vacant' && e.expenseId === repair._id
  );
  expect(rv.length, 'NO repair-vacant row when flag off (share → Αχρέωτα)').toBe(
    0
  );
  await patchRepair(repair._id, { status: 'cancelled' });
});

test('54.3 inert credit — cancel a PAID owners-repair keeps the money; un-cancel nets to €0', async () => {
  // owners-only repair → full €300 owner-portion (building-wide).
  const repair = await createRepair({
    title: 'E2E54-Credit',
    category: 'roof',
    chargeableTo: 'owners',
    chargeTerm: TERM,
    actualCost: 300,
    allocationMethod: 'general_thousandths',
    status: 'planned'
  });
  expect(repair).toBeDefined();
  let rows = readOwnerRows()!;
  const liab = rows.find(
    (e) => e.source === 'repair' && e.expenseId === repair._id
  );
  expect(liab, 'owner-portion repair row').toBeDefined();
  expect(liab!.amount).toBeCloseTo(300, 1);

  // Owner pays the €300 in full (direct mongo — the payment dialog fan-out).
  mongoExec(`
    db.buildings.updateOne(
      { _id: ObjectId("${BID}"), "ownerMonthlyExpenses.expenseId": "${repair._id}", "ownerMonthlyExpenses.source": "repair" },
      { $set: { "ownerMonthlyExpenses.$.payments": [{ amount: 300, date: new Date(), type: "transfer" }], "ownerMonthlyExpenses.$.paid": true } }
    );
    print("paid");
  `);

  // CANCEL → the paid row must survive as an inert credit (money preserved).
  await patchRepair(repair._id, { status: 'cancelled' });
  rows = readOwnerRows()!;
  const creditAfterCancel = rows.filter(
    (e) => e.source === 'credit' && e.expenseId === repair._id
  );
  expect(creditAfterCancel.length, 'credit remnant kept on cancel').toBe(1);
  expect(creditAfterCancel[0].paidSum).toBeCloseTo(300, 1); // money survived

  // UN-CANCEL → inert credit stays + a fresh €300 liability re-opens; the two
  // reconcile (owed €300 === paid €300). Assert via the owner ledger API that
  // the owner shows €0 net outstanding (the netting fix), not a phantom €300.
  await patchRepair(repair._id, { status: 'planned' });
  rows = readOwnerRows()!;
  const totalPaid = rows
    .filter((e) => e.expenseId === repair._id)
    .reduce((s, e) => s + e.paidSum, 0);
  const totalOwed = rows
    .filter((e) => e.expenseId === repair._id)
    .reduce((s, e) => s + e.amount, 0);
  expect(totalPaid, 'recorded €300 preserved across cancel→un-cancel').toBeCloseTo(
    300,
    1
  );
  expect(totalOwed, 're-opened liability €300').toBeCloseTo(300, 1);

  // Owner ledger (GET /owners) must net it to €0 outstanding for the owner,
  // not surface a phantom collectible debt.
  const ctx = await request.newContext();
  const ownersResp = await ctx.get(`${GATEWAY}/api/v2/owners`, {
    headers: { Authorization: `Bearer ${token}`, organizationid: realmId }
  });
  expect(ownersResp.status()).toBe(200);
  const owners = (await ownersResp.json()) as Array<{
    totalOutstanding?: number;
    charges?: Array<{ expenseId?: string; outstanding?: number }>;
  }>;
  // The owner(s) of this building: their charges for this repair must net to 0.
  let repairOutstanding = 0;
  for (const o of owners) {
    for (const c of o.charges || []) {
      if (String(c.expenseId) === repair._id) {
        repairOutstanding += Number(c.outstanding) || 0;
      }
    }
  }
  expect(
    repairOutstanding,
    'cancel→un-cancel nets to €0 outstanding (no phantom debt)'
  ).toBeCloseTo(0, 1);

  await patchRepair(repair._id, { status: 'cancelled' });
});
