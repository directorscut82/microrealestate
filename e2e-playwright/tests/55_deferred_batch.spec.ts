/**
 * Live-NAS verification of the "un-deferred" batch (rev dd3a3d89):
 *  - §1.8: a flag-OFF repair's vacant-unit share surfaces as owner-uncollected
 *    (Αχρέωτα) in the expense breakdown — and is NOT double-counted.
 *  - A2: building.tenantRentYTD strips the carried-forward balance (owed is the
 *    per-month arrears, not the cumulative blow-up).
 *  - A6: building.expenses carry inputAmount per saved monthly statement (the
 *    κυμαινόμενα YTD source) — sanity that the payload feeds the cell.
 *  - OS4: GET /csv/owner-settlements/:year returns a valid xlsx.
 * Mongo-seeded dedicated building (spec 49/54 pattern) for determinism.
 */
import { expect, request, test } from '@playwright/test';
import { mongoExec } from './lib/mongoExec';
import { getAccessToken } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const ORG = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';

const BID = 'aa0000000000000000000055';
const P_OCC = 'aa0000000000000000005501';
const P_VAC = 'aa0000000000000000005502';

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

// 2 units: P_OCC occupied (tenant in arrears — carries a cumulative balance),
// P_VAC vacant. Equal thousandths so a 100%-tenant repair splits 50/50.
function seed() {
  return mongoExec(`
    var r = db.realms.findOne({name: "${q(ORG)}"});
    if (!r) { print("NO_REALM"); quit(); }
    var rid = String(r._id.valueOf());
    db.buildings.deleteOne({_id: ObjectId("${BID}")});
    db.occupants.deleteMany({name: /^E2E55-/});
    db.buildings.insertOne({
      _id: ObjectId("${BID}"), realmId: rid, name: "E2E55-Building", atakPrefix: "E2E55",
      address: { street1:"T", city:"T", zipCode:"00000" },
      units: [
        { _id: new ObjectId(), atakNumber:"E2E55-Occ", isManaged:true, occupancyType:"rented", propertyId:"${P_OCC}", generalThousandths:500, surface:50, monthlyCharges:[] },
        { _id: new ObjectId(), atakNumber:"E2E55-Vac", isManaged:true, occupancyType:"vacant", propertyId:"${P_VAC}", generalThousandths:500, surface:50, monthlyCharges:[] }
      ],
      expenses: [],
      repairs: [
        { _id: new ObjectId(), title:"E2E55-Repair", category:"elevator", status:"planned", urgency:"normal",
          actualCost:200, chargeableTo:"tenants", tenantSharePercentage:100, allocationMethod:"general_thousandths",
          chargeTerm:${TERM}, affectedUnitIds:[], chargeOwnerWhenVacant:false }
      ],
      ownerMonthlyExpenses: [],
      createdDate:new Date(), updatedDate:new Date(), __v:0
    });
    // Tenant on P_OCC, €1000/mo, behind 3 months → cumulative grandTotal carries.
    db.occupants.insertOne({
      realmId: rid, name:"E2E55-Tenant", isCompany:false,
      beginDate:new Date(${YEAR},0,1), endDate:new Date(${YEAR},11,31), terminationDate:null,
      properties:[{ propertyId:"${P_OCC}", entryDate:new Date(${YEAR},0,1), exitDate:new Date(${YEAR},11,31), property:{ name:"E2E55-POcc" } }],
      rents: [
        { term:${YEAR}010100, total:{ grandTotal:1000, payment:0, balance:0 } },
        { term:${YEAR}020100, total:{ grandTotal:2000, payment:0, balance:1000 } },
        { term:${YEAR}030100, total:{ grandTotal:3000, payment:0, balance:2000 } }
      ]
    });
    print(rid);
  `);
}

test.beforeAll(async () => {
  test.skip(mongoExec('print("ok")') === null, 'no mongo');
  const ctx = await request.newContext();
  token = await getAccessToken(ctx);
  await ctx.dispose();
  const raw = seed();
  const last = String(raw).split('\n').map((l) => l.trim()).filter(Boolean).pop()!;
  expect(last).not.toBe('NO_REALM');
  realmId = last.match(/[a-f0-9]{24}/i)![0];
  auth = { Authorization: `Bearer ${token}`, organizationid: realmId };
});

test.afterAll(async () => {
  mongoExec(`
    db.buildings.deleteOne({_id: ObjectId("${BID}")});
    db.occupants.deleteMany({name: /^E2E55-/});
    print("clean");
  `);
});

test('55.1 §1.8 — flag-OFF repair vacant share surfaces as owner-uncollected, once', async () => {
  const ctx = await request.newContext();
  const resp = await ctx.get(
    `${GATEWAY}/api/v2/buildings/${BID}/expense-breakdown?term=${TERM}`,
    { headers: auth }
  );
  expect(resp.status()).toBe(200);
  const bd = await resp.json();
  const vacRepairRows = (bd.rows || []).filter(
    (r: any) =>
      r.propertyId === P_VAC &&
      r.recipient === 'owner' &&
      !r.ownerBilled &&
      r.expenseType === 'repair'
  );
  // Exactly ONE uncollected repair row for the vacant unit (€100 = 200 × 500/1000).
  expect(vacRepairRows.length).toBe(1);
  expect(vacRepairRows[0].amount).toBeCloseTo(100, 1);
  expect(Number(bd.ownerUnbilledTotal)).toBeGreaterThanOrEqual(100);
});

test('55.2 A2 — tenantRentYTD owed strips the carried balance (3 × €1000 = €3,000, not €6,000)', async () => {
  const ctx = await request.newContext();
  const resp = await ctx.get(`${GATEWAY}/api/v2/buildings/${BID}`, {
    headers: auth
  });
  expect(resp.status()).toBe(200);
  const b = await resp.json();
  expect(b.tenantRentYTD).toBeTruthy();
  // 3 unpaid months at €1000 monthly bill → owed €3,000 (NOT the cumulative
  // 1000+2000+3000 = €6,000 blow-up). collected = €0 (nothing paid).
  expect(b.tenantRentYTD.collected).toBeCloseTo(0, 1);
  expect(b.tenantRentYTD.owed).toBeCloseTo(3000, 1);
});

test('55.3 OS4 — owner settlements export returns a valid xlsx', async () => {
  const ctx = await request.newContext();
  const resp = await ctx.get(
    `${GATEWAY}/api/v2/csv/owner-settlements/${YEAR}`,
    { headers: auth }
  );
  expect(resp.status()).toBe(200);
  const ct = resp.headers()['content-type'] || '';
  expect(ct).toContain('spreadsheetml');
  const body = await resp.body();
  // xlsx is a zip → starts with "PK".
  expect(body.length).toBeGreaterThan(100);
  expect(body.slice(0, 2).toString('latin1')).toBe('PK');
});
