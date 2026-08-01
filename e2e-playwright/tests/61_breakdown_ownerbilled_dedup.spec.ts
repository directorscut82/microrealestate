/**
 * Spec 61 — H1 (section-2 ownerBilled) + H2 (legacy repair dedup) in the
 * building expense-breakdown engine.
 *
 * Coverage-gap audit (w420k230h) found these illusory-covered: the specs that
 * "cover" them seed monthlyCharges:[], so the exact section-2 / section-3
 * branches the H1/H2 fixes changed never execute. This spec seeds NON-EMPTY
 * monthlyCharges to drive them directly, against the deployed engine.
 *
 *   61.1 H1 — a PERSISTED owner-row charge sets ownerBilled correctly:
 *        - a vacant unit's persisted variable charge whose expense has
 *          chargeOwnerWhenVacant:true → ownerBilled:true (owner-billed, NOT
 *          Αχρέωτα);
 *        - an owner_occupied unit's persisted charge → ownerBilled:true;
 *        - a vacant unit's persisted charge whose expense is flag-OFF →
 *          ownerBilled:false (stays Αχρέωτα).
 *   61.2 H2 — a LEGACY repair monthlyCharge (description 'Repair: <title>',
 *        no repairId) on a now-vacant unit suppresses the §1.8 re-emit so the
 *        repair's Αχρέωτα appears ONCE (not doubled).
 *   61.3 H2-1 — a building-EXPENSE charge whose description collides with a
 *        repair title does NOT poison the dedup: the same-named repair's
 *        Αχρέωτα still emits (the !c.expenseId guard).
 *
 * Mongo-seeded dedicated building, dropped in afterAll.
 */
import { expect, request, test } from '@playwright/test';
import { mongoExec } from './lib/mongoExec';
import { getAccessToken } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const ORG = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';

const BID = 'aa0000000000000000000061';
const P_VAC_ON = 'aa0000000000000000006101'; // vacant, flag-ON expense charge
const P_OWN = 'aa0000000000000000006102'; // owner-occupied, persisted charge
const P_VAC_OFF = 'aa0000000000000000006103'; // vacant, flag-OFF expense charge
const P_VAC_REP = 'aa0000000000000000006104'; // vacant, legacy repair charge
const EX_ON = 'aa00000000000000000061e1'; // chargeOwnerWhenVacant:true
const EX_OFF = 'aa00000000000000000061e2'; // chargeOwnerWhenVacant:false
const EX_OWN = 'aa00000000000000000061e3'; // owner_occupied unit's expense
const REP_LEGACY = 'aa00000000000000000061d1'; // repair matching the legacy desc

const now = new Date();
const YEAR = now.getFullYear();
const MM = String(now.getMonth() + 1).padStart(2, '0');
const TERM = Number(`${YEAR}${MM}0100`);

let realmId = '';
let token = '';

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

function q(s: string) {
  return s.replace(/"/g, '\\"');
}

function seed() {
  return mongoExec(`
    var r = db.realms.findOne({name: "${q(ORG)}"});
    if (!r) { print("NO_REALM"); quit(); }
    var rid = String(r._id.valueOf());
    db.buildings.deleteOne({_id: ObjectId("${BID}")});
    db.buildings.insertOne({
      _id: ObjectId("${BID}"), realmId: rid, name: "E2E61-Building", atakPrefix: "E2E61",
      address: { street1:"T", city:"T", zipCode:"00000" },
      units: [
        { _id: new ObjectId(), atakNumber:"E2E61-VacOn", isManaged:true, occupancyType:"vacant", propertyId:"${P_VAC_ON}", generalThousandths:250, surface:50,
          owners:[{ type:"external", percentage:100, name:"E2E61-OwnerA", taxId:"611111111" }],
          monthlyCharges:[{ term:${TERM}, amount:40, description:"E2E61-VarOn", expenseId:"${EX_ON}" }] },
        { _id: new ObjectId(), atakNumber:"E2E61-Own", isManaged:true, occupancyType:"owner_occupied", propertyId:"${P_OWN}", generalThousandths:250, surface:50,
          owners:[{ type:"external", percentage:100, name:"E2E61-OwnerB", taxId:"612222222" }],
          monthlyCharges:[{ term:${TERM}, amount:30, description:"E2E61-VarOwn", expenseId:"${EX_OWN}" }] },
        { _id: new ObjectId(), atakNumber:"E2E61-VacOff", isManaged:true, occupancyType:"vacant", propertyId:"${P_VAC_OFF}", generalThousandths:250, surface:50,
          owners:[{ type:"external", percentage:100, name:"E2E61-OwnerC", taxId:"613333333" }],
          monthlyCharges:[{ term:${TERM}, amount:20, description:"E2E61-VarOff", expenseId:"${EX_OFF}" }] },
        { _id: new ObjectId(), atakNumber:"E2E61-VacRep", isManaged:true, occupancyType:"vacant", propertyId:"${P_VAC_REP}", generalThousandths:250, surface:50,
          owners:[{ type:"external", percentage:100, name:"E2E61-OwnerD", taxId:"614444444" }],
          monthlyCharges:[{ term:${TERM}, amount:50, description:"Repair: E2E61-LegacyElev" }] }
      ],
      expenses: [
        { _id: ObjectId("${EX_ON}"),  name:"E2E61-VarOn",  type:"cleaning", amount:0, allocationMethod:"equal", isRecurring:true, startTerm:${TERM}, customAllocations:[], chargeOwnerWhenVacant:true },
        { _id: ObjectId("${EX_OWN}"), name:"E2E61-VarOwn", type:"cleaning", amount:0, allocationMethod:"equal", isRecurring:true, startTerm:${TERM}, customAllocations:[], chargeOwnerWhenVacant:false },
        { _id: ObjectId("${EX_OFF}"), name:"E2E61-VarOff", type:"cleaning", amount:0, allocationMethod:"equal", isRecurring:true, startTerm:${TERM}, customAllocations:[], chargeOwnerWhenVacant:false }
      ],
      repairs: [
        { _id: ObjectId("${REP_LEGACY}"), title:"E2E61-LegacyElev", category:"elevator", status:"completed", urgency:"normal",
          actualCost:200, chargeableTo:"tenants", tenantSharePercentage:100, allocationMethod:"general_thousandths",
          chargeTerm:${TERM}, affectedUnitIds:["${P_VAC_REP}"], chargeOwnerWhenVacant:false }
      ],
      ownerMonthlyExpenses: [],
      createdDate:new Date(), updatedDate:new Date(), __v:0
    });
    print(rid);
  `);
}

function auth() {
  return { Authorization: `Bearer ${token}`, organizationid: realmId };
}

async function breakdown(req: any) {
  const resp = await req.get(
    `${GATEWAY}/api/v2/buildings/${BID}/expense-breakdown?term=${TERM}`,
    { headers: auth() }
  );
  expect(resp.status(), await resp.text().catch(() => '')).toBe(200);
  return resp.json();
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
});

test.afterAll(async () => {
  mongoExec(`db.buildings.deleteOne({_id: ObjectId("${BID}")}); print("clean");`);
});

test('61.1 H1 — persisted owner-row charges set ownerBilled correctly (not all into Αχρέωτα)', async ({
  request: req
}) => {
  const bd = await breakdown(req);
  const row = (pid: string) =>
    (bd.rows || []).find((r: any) => r.propertyId === pid && r.recipient === 'owner');

  const vacOn = row(P_VAC_ON);
  const own = row(P_OWN);
  const vacOff = row(P_VAC_OFF);

  expect(vacOn, 'vacant flag-ON persisted charge present').toBeTruthy();
  expect(own, 'owner-occupied persisted charge present').toBeTruthy();
  expect(vacOff, 'vacant flag-OFF persisted charge present').toBeTruthy();

  // flag-ON vacant → owner-billed (the H1 fix); owner-occupied → owner-billed;
  // flag-OFF vacant → uncollected (stays in Αχρέωτα).
  expect(vacOn.ownerBilled, 'flag-ON vacant persisted charge is owner-billed').toBe(true);
  expect(own.ownerBilled, 'owner-occupied persisted charge is owner-billed').toBe(true);
  expect(vacOff.ownerBilled, 'flag-OFF vacant persisted charge stays Αχρέωτα').toBe(false);

  // The €40 + €30 owner-billed land in ownerBilledTotal, NOT ownerUnbilledTotal.
  // Pre-H1, all three persisted owner charges fell into ownerUnbilledTotal.
  expect(Number(bd.ownerBilledTotal)).toBeGreaterThanOrEqual(70 - 0.02);
});

// The legacy 'Repair: <title>' Section-2 charge surfaces as an owner row with
// expenseType undefined (no repairId); a §1.8 DUPLICATE would be a SECOND owner
// row (expenseType 'repair') for the same unit/repair. The repair's vacant share
// = €200 × 250/1000 = €50, identical to the legacy charge amount — so the unit's
// total owner-unbilled is €50 when deduped, €100 when doubled.
const ownerUnbilledForUnit = (bd: any, pid: string) =>
  (bd.rows || [])
    .filter((r: any) => r.propertyId === pid && r.recipient === 'owner' && !r.ownerBilled)
    .reduce((s: number, r: any) => s + (Number(r.amount) || 0), 0);

test('61.2 H2 — a legacy (no-repairId) repair charge suppresses the §1.8 re-emit (Αχρέωτα once, not doubled)', async ({
  request: req
}) => {
  const bd = await breakdown(req);
  // The vacant P_VAC_REP carries a legacy 'Repair: E2E61-LegacyElev' monthlyCharge
  // (€50, no repairId). §1.8 must NOT also emit the same repair's €50 vacant share.
  const unbilled = ownerUnbilledForUnit(bd, P_VAC_REP);
  expect(
    Math.abs(unbilled - 50),
    `legacy repair Αχρέωτα must be €50 once (not €100 doubled), got €${unbilled}`
  ).toBeLessThanOrEqual(0.5);
  // And exactly ONE owner row for the unit (the legacy charge), no §1.8 twin.
  const ownerRows = (bd.rows || []).filter(
    (r: any) => r.propertyId === P_VAC_REP && r.recipient === 'owner'
  );
  expect(ownerRows.length, `one owner row for the unit, got ${JSON.stringify(ownerRows)}`).toBe(1);
});

test('61.3 H2-1 — a same-named building-EXPENSE charge does not poison the repair dedup', async ({
  request: req
}) => {
  // Add a building-expense monthlyCharge on a DIFFERENT vacant unit whose
  // description equals the repair's 'Repair: <title>' string but WITH an
  // expenseId. The !c.expenseId guard means it must NOT suppress the repair's
  // own Αχρέωτα on P_VAC_REP (which would drop to €0 if poisoned).
  mongoExec(`
    db.buildings.updateOne(
      {_id: ObjectId("${BID}"), "units.propertyId": "${P_VAC_OFF}"},
      {$push: {"units.$.monthlyCharges": {term:${TERM}, amount:15, description:"Repair: E2E61-LegacyElev", expenseId:"${EX_OFF}"}}}
    );
    print("ok");
  `);
  const bd = await breakdown(req);
  // The repair's legacy Αχρέωτα on P_VAC_REP still totals €50 — the
  // expense-named collision on P_VAC_OFF did not gate it out.
  const unbilled = ownerUnbilledForUnit(bd, P_VAC_REP);
  expect(
    Math.abs(unbilled - 50),
    `repair Αχρέωτα still €50 despite the same-named expense charge, got €${unbilled}`
  ).toBeLessThanOrEqual(0.5);
});
