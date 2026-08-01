/**
 * Spec 57 — C2 / C2-1 co-owner payment attribution (deployed NAS).
 *
 * The C2 fix + its two Step-7-caught follow-ons (C2-1) had ZERO E2E coverage
 * (gap audit w420k230h): every existing owner-payment spec seeds a SINGLE
 * 100%-owner unit, so the multi-owner re-split branch the fix lives in is
 * structurally unreachable. This spec seeds a CO-OWNED building-wide charge
 * (ALPHA 50% + BETA 50%) — the first such fixture — and exercises:
 *
 *   57.1 a payment tagged to ALPHA (POST /owners/<ALPHA key>/payment) settles
 *        ONLY ALPHA; BETA is untouched (no cross-owner credit) — C2.
 *   57.2 both co-owners pay their own slice → both settle, no double-credit.
 *   57.3 attribution SURVIVES a building recompute — the ownerKey carry
 *        (C2-1) keeps ALPHA settled / BETA owing after a recompute that
 *        strips+rebuilds the row via carryOwnerPayments.
 *   57.4 money is CONSERVED when a payer's identity goes stale (taxId edited
 *        so the tagged ownerKey maps to no current slice) — Σ paid unchanged,
 *        degrades to the lossless proportional split (C2-1 round-2).
 *
 * Mongo-seeded dedicated building, dropped in afterAll. Skips when
 * portainer-token absent.
 */
import { expect, request, test } from '@playwright/test';
import { mongoExec } from './lib/mongoExec';
import { getAccessToken } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const ORG_NAME = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';

const B_NAME = 'E2E-CoOwner-Building';
const BID = 'aa0000000000000000000057';
const P1 = 'aa0000000000000000005701'; // ALPHA's unit
const P2 = 'aa0000000000000000005702'; // BETA's unit
const EXP_A = 'aa00000000000000000057e1';
const ALPHA = 'E2E57-Alpha';
const ALPHA_TAX = '571111111';
const BETA = 'E2E57-Beta';
const BETA_TAX = '572222222';
const ALPHA_KEY = `n:${ALPHA.toLowerCase()}|${ALPHA_TAX}`;
const BETA_KEY = `n:${BETA.toLowerCase()}|${BETA_TAX}`;

const now = new Date();
const YEAR = now.getFullYear();
const TERM = Number(`${YEAR}010100`);

let realmId = '';
let token = '';

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

function q(s: string) {
  return s.replace(/"/g, '\\"');
}

// One building-wide co-owned owner charge (propertyId null) of €100, co-owned
// ALPHA 50% / BETA 50% (two managed owner-occupied units, one owner each). The
// charge is source:'expense' so a building-expense recompute carries it.
function seedBuilding() {
  return mongoExec(`
    var r = db.realms.findOne({name: "${q(ORG_NAME)}"});
    if (!r) { print("NO_REALM"); quit(); }
    var rid = String(r._id.valueOf());
    db.buildings.deleteOne({_id: ObjectId("${BID}")});
    db.buildings.insertOne({
      _id: ObjectId("${BID}"),
      realmId: rid,
      name: "${B_NAME}",
      atakPrefix: "E2E57",
      address: { street1: "T", city: "T", zipCode: "00000" },
      units: [
        { _id: ObjectId(), atakNumber: "E2E57-U1", isManaged: true, occupancyType: "owner_occupied", propertyId: "${P1}", generalThousandths: 500, surface: 50, monthlyCharges: [],
          owners: [{ type: "external", percentage: 50, name: "${ALPHA}", taxId: "${ALPHA_TAX}" }] },
        { _id: ObjectId(), atakNumber: "E2E57-U2", isManaged: true, occupancyType: "owner_occupied", propertyId: "${P2}", generalThousandths: 500, surface: 50, monthlyCharges: [],
          owners: [{ type: "external", percentage: 50, name: "${BETA}", taxId: "${BETA_TAX}" }] }
      ],
      expenses: [
        { _id: ObjectId("${EXP_A}"), name: "E2E57-Mgmt", type: "management_fee", amount: 0, allocationMethod: "equal", isRecurring: true, startTerm: ${TERM}, customAllocations: [], trackOwnerExpense: true, ownerAmount: 0 }
      ],
      ownerMonthlyExpenses: [
        { _id: ObjectId(), expenseId: "${EXP_A}", term: ${TERM}, amount: 100, source: "expense", description: "E2E57-Mgmt", paid: false, paidDate: null, payments: [] }
      ],
      createdDate: new Date(), updatedDate: new Date(), __v: 0
    });
    print(rid);
  `);
}

function setOwnerTax(propertyId: string, newTax: string) {
  mongoExec(`
    db.buildings.updateOne(
      {_id: ObjectId("${BID}"), "units.propertyId": "${propertyId}"},
      {$set: {"units.$.owners.0.taxId": "${newTax}"}}
    );
    print("ok");
  `);
}

function headers() {
  return {
    Authorization: `Bearer ${token}`,
    organizationid: realmId,
    'Content-Type': 'application/json'
  };
}

async function getAllOwners(req: any) {
  const resp = await req.get(`${GATEWAY}/api/v2/owners`, { headers: headers() });
  expect(resp.status(), await resp.text().catch(() => '')).toBe(200);
  return (await resp.json()) as Array<{
    ownerKey: string;
    name: string;
    totalPaid: number;
    totalOutstanding: number;
  }>;
}

async function pay(req: any, key: string, amount: number) {
  return req.post(
    `${GATEWAY}/api/v2/owners/${encodeURIComponent(key)}/payment`,
    {
      headers: headers(),
      data: { payment: { date: `15/01/${YEAR}`, amount, type: 'transfer', reference: 'E2E57' } }
    }
  );
}

test.beforeAll(async () => {
  const probe = mongoExec('print("ok")');
  test.skip(probe === null, 'portainer-token absent — cannot reach NAS mongo');
  const apiCtx = await request.newContext();
  token = await getAccessToken(apiCtx);
  await apiCtx.dispose();
});

test.beforeEach(async () => {
  // Fresh fixture per test (serial) so payments/identity edits don't leak.
  const raw = seedBuilding();
  const lastLine = String(raw).split('\n').map((l) => l.trim()).filter(Boolean).pop()!;
  expect(lastLine).not.toBe('NO_REALM');
  const m = lastLine.match(/[a-f0-9]{24}/i);
  expect(m, `realmId hex not found: ${lastLine}`).toBeTruthy();
  realmId = m![0];
});

test.afterAll(async () => {
  mongoExec(`db.buildings.deleteOne({_id: ObjectId("${BID}")}); print("cleaned");`);
});

test('57.1 — a payment tagged to ALPHA settles ONLY ALPHA (no cross-owner credit)', async ({
  request: req
}) => {
  // €100 charge co-owned 50/50 → each owes €50. ALPHA pays their €50 slice.
  const resp = await pay(req, ALPHA_KEY, 50);
  expect([200, 201], await resp.text().catch(() => '')).toContain(resp.status());

  const owners = await getAllOwners(req);
  const a = owners.find((o) => o.ownerKey === ALPHA_KEY);
  const b = owners.find((o) => o.ownerKey === BETA_KEY);
  expect(a, 'ALPHA present').toBeTruthy();
  expect(b, 'BETA present').toBeTruthy();
  // ALPHA settled; BETA still owes their full €50 (NOT re-split to €25/€25).
  expect(Math.abs(a!.totalOutstanding - 0)).toBeLessThanOrEqual(0.02);
  expect(Math.abs(a!.totalPaid - 50)).toBeLessThanOrEqual(0.02);
  expect(Math.abs(b!.totalOutstanding - 50)).toBeLessThanOrEqual(0.02);
  expect(Math.abs(b!.totalPaid - 0)).toBeLessThanOrEqual(0.02);
});

test('57.2 — both co-owners pay their own slice → both settle, no double-credit', async ({
  request: req
}) => {
  expect([200, 201]).toContain((await pay(req, ALPHA_KEY, 50)).status());
  expect([200, 201]).toContain((await pay(req, BETA_KEY, 50)).status());
  const owners = await getAllOwners(req);
  const a = owners.find((o) => o.ownerKey === ALPHA_KEY);
  const b = owners.find((o) => o.ownerKey === BETA_KEY);
  expect(Math.abs(a!.totalOutstanding - 0)).toBeLessThanOrEqual(0.02);
  expect(Math.abs(b!.totalOutstanding - 0)).toBeLessThanOrEqual(0.02);
  // Together €100 paid — not €200 (no double-credit).
  expect(Math.abs(a!.totalPaid + b!.totalPaid - 100)).toBeLessThanOrEqual(0.02);
});

test('57.3 — attribution SURVIVES a building recompute (C2-1 ownerKey carry)', async ({
  request: req
}) => {
  expect([200, 201]).toContain((await pay(req, ALPHA_KEY, 50)).status());
  // Trigger a recompute that strips+rebuilds owner rows through carryOwnerPayments.
  const patch = await req.patch(
    `${GATEWAY}/api/v2/buildings/${BID}/expenses/${EXP_A}`,
    { headers: headers(), data: { name: 'E2E57-Mgmt' } }
  );
  expect([200, 201]).toContain(patch.status());
  await new Promise((r) => setTimeout(r, 1500));

  const owners = await getAllOwners(req);
  const a = owners.find((o) => o.ownerKey === ALPHA_KEY);
  const b = owners.find((o) => o.ownerKey === BETA_KEY);
  // Pre-C2-1, the recompute dropped ownerKey → re-split 25/25, re-opening
  // ALPHA's debt. The carry must keep ALPHA settled and BETA owing €50.
  expect(Math.abs(a!.totalOutstanding - 0), 'ALPHA stays settled after recompute').toBeLessThanOrEqual(0.02);
  expect(Math.abs(b!.totalOutstanding - 50), 'BETA still owes €50').toBeLessThanOrEqual(0.02);
});

test('57.4 — money is CONSERVED when the payer identity goes stale (C2-1 round-2)', async ({
  request: req
}) => {
  expect([200, 201]).toContain((await pay(req, ALPHA_KEY, 50)).status());
  // Correct ALPHA's taxId so the tagged ownerKey ('n:e2e57-alpha|571111111')
  // no longer matches the current owner slice ('n:e2e57-alpha|<new>').
  setOwnerTax(P1, '579999999');
  // Trigger a recompute so the stale-tagged payment is carried + re-read.
  const patch = await req.patch(
    `${GATEWAY}/api/v2/buildings/${BID}/expenses/${EXP_A}`,
    { headers: headers(), data: { name: 'E2E57-Mgmt' } }
  );
  expect([200, 201]).toContain(patch.status());
  await new Promise((r) => setTimeout(r, 1500));

  const owners = await getAllOwners(req);
  // The €50 must NOT vanish. Pre-fix, the stale key zeroed it (Σ paid 0);
  // the guard degrades to the lossless proportional split → Σ paid stays €50.
  const totalPaid = owners
    .filter((o) => o.ownerKey === ALPHA_KEY || o.ownerKey === BETA_KEY || o.name === ALPHA || o.name === BETA)
    .reduce((s, o) => s + (Number(o.totalPaid) || 0), 0);
  expect(totalPaid, `Σ owner paid must be conserved (€50), got ${JSON.stringify(owners)}`).toBeGreaterThanOrEqual(50 - 0.02);
});
