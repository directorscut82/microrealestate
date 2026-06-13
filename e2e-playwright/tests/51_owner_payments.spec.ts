/**
 * Spec 51 — owner καταβολές (owner-debt ledger backend, Batch 2 sub-batch 1).
 *
 * Verifies the owner-payment API on the DEPLOYED NAS:
 *   51.1 — GET /owners aggregates an owner with outstanding from a seeded
 *          building's ownerMonthlyExpenses; the owner appears with the right
 *          total outstanding.
 *   51.2 — POST /owners/:ownerKey/payment (auto-spread) records a καταβολή;
 *          mongo readback confirms the payment landed on the oldest charge's
 *          payments[] and its derived paid flips; the owner's outstanding
 *          drops by the paid amount.
 *   51.3 — the recorded payment SURVIVES a building recompute (trigger an
 *          expense edit) — payments[] is carried forward (not wiped).
 *   51.4 — custom allocation exceeding a charge's outstanding is rejected 422
 *          (the per-charge cap); duplicate-entry overpay also rejected.
 *
 * Seeds a DEDICATED building (unique id/name) via direct mongo insert and
 * drops it in afterAll — never touches canonical fixtures. Skips cleanly when
 * portainer-token is absent (mongoExec null).
 */
import { expect, request, test } from '@playwright/test';
import { mongoExec } from './lib/mongoExec';
import { getAccessToken } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const ORG_NAME = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';

const B_NAME = 'E2E-OwnerPay-Building';
const BID = 'aa0000000000000000000051';
const P1 = 'aa0000000000000000005101';
const EXP_A = 'aa00000000000000000051a1'; // older charge
const EXP_B = 'aa00000000000000000051b1'; // newer charge
const OWNER_NAME = 'E2E51-Owner-Smith';
const OWNER_TAX = '519999519';
// owner key: no memberId → n:<lowercased name>|<taxId>
const OWNER_KEY = `n:${OWNER_NAME.toLowerCase()}|${OWNER_TAX}`;

const now = new Date();
const YEAR = now.getFullYear();
const TERM_OLD = (YEAR - 1) * 1000000 + 110100; // last year Nov — oldest
const TERM_NEW = YEAR * 1000000 + 10100; // this year Jan

let realmId = '';
let token = '';

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

function q(s: string) {
  return s.replace(/"/g, '\\"');
}

// A building with one managed unit owned by OWNER, and TWO owner-direct
// charges (source:'expense') — €100 @ TERM_OLD and €50 @ TERM_NEW.
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
      atakPrefix: "E2E51",
      address: { street1: "T", city: "T", zipCode: "00000" },
      units: [
        { _id: ObjectId(), atakNumber: "E2E51-U1", isManaged: true, occupancyType: "owner_occupied", propertyId: "${P1}", generalThousandths: 1000, surface: 60, monthlyCharges: [],
          owners: [{ type: "external", percentage: 100, name: "${OWNER_NAME}", taxId: "${OWNER_TAX}" }] }
      ],
      expenses: [
        { _id: ObjectId("${EXP_A}"), name: "E2E51-Mgmt", type: "management_fee", amount: 0, allocationMethod: "equal", isRecurring: true, startTerm: ${TERM_OLD}, customAllocations: [], trackOwnerExpense: true, ownerAmount: 0 }
      ],
      ownerMonthlyExpenses: [
        { _id: ObjectId(), expenseId: "${EXP_A}", term: ${TERM_OLD}, amount: 100, source: "expense", description: "E2E51-Mgmt-old", paid: false, paidDate: null, payments: [] },
        { _id: ObjectId(), expenseId: "${EXP_B}", term: ${TERM_NEW}, amount: 50,  source: "expense", description: "E2E51-Mgmt-new", paid: false, paidDate: null, payments: [] }
      ],
      createdDate: new Date(), updatedDate: new Date(), __v: 0
    });
    print(rid);
  `);
}

function readOwnerRows() {
  const out = mongoExec(`
    var b = db.buildings.findOne({_id: ObjectId("${BID}")});
    if (!b) { print("null"); quit(); }
    print(JSON.stringify((b.ownerMonthlyExpenses||[]).map(function(e){
      return { expenseId: String(e.expenseId), term: e.term, amount: e.amount,
        paid: !!e.paid, payCount: (e.payments||[]).length,
        paySum: (e.payments||[]).reduce(function(s,p){return s+(Number(p.amount)||0)},0) };
    })));
  `);
  if (!out || out === 'null') return null;
  return JSON.parse(out) as Array<{
    expenseId: string; term: number; amount: number;
    paid: boolean; payCount: number; paySum: number;
  }>;
}

test.beforeAll(async () => {
  const probe = mongoExec('print("ok")');
  test.skip(probe === null, 'portainer-token absent — cannot reach NAS mongo');
  const apiCtx = await request.newContext();
  token = await getAccessToken(apiCtx);
  await apiCtx.dispose();
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

const headers = () => ({
  Authorization: `Bearer ${token}`,
  organizationid: realmId,
  'Content-Type': 'application/json'
});

test('51.1 — GET /owners aggregates the owner with €150 outstanding', async ({
  request: req
}) => {
  const resp = await req.get(`${GATEWAY}/api/v2/owners`, { headers: headers() });
  expect(resp.status(), await resp.text().catch(() => '')).toBe(200);
  const list = (await resp.json()) as Array<{
    ownerKey: string; name: string; totalOutstanding: number; totalAmount: number;
  }>;
  const owner = list.find((o) => o.ownerKey === OWNER_KEY);
  expect(owner, 'seeded owner present in /owners').toBeTruthy();
  expect(Math.abs(owner!.totalOutstanding - 150)).toBeLessThanOrEqual(0.01);
});

test('51.2 — POST payment (auto-spread) settles oldest charge first; readback confirms', async ({
  request: req
}) => {
  // Pay €100 — auto-spread should fully settle the €100 TERM_OLD charge.
  const resp = await req.post(
    `${GATEWAY}/api/v2/owners/${encodeURIComponent(OWNER_KEY)}/payment`,
    {
      headers: headers(),
      data: {
        payment: { date: `${YEAR}-06-15`, amount: 100, type: 'transfer', reference: 'E2E51-RF' }
      }
    }
  );
  expect(resp.status(), await resp.text().catch(() => '')).toBe(200);

  const rows = readOwnerRows();
  expect(rows, 'owner rows readable').toBeTruthy();
  const oldRow = rows!.find((r) => r.expenseId === EXP_A && r.term === TERM_OLD);
  const newRow = rows!.find((r) => r.expenseId === EXP_B && r.term === TERM_NEW);
  // Oldest charge fully paid (payment landed on it), derived paid true.
  expect(oldRow!.payCount, 'payment recorded on oldest charge').toBe(1);
  expect(Math.abs(oldRow!.paySum - 100)).toBeLessThanOrEqual(0.01);
  expect(oldRow!.paid, 'oldest charge derived paid').toBe(true);
  // Newer charge untouched.
  expect(newRow!.payCount).toBe(0);
  expect(newRow!.paid).toBe(false);

  // Owner outstanding dropped to €50.
  const ownerResp = await req.get(
    `${GATEWAY}/api/v2/owners/${encodeURIComponent(OWNER_KEY)}`,
    { headers: headers() }
  );
  expect(ownerResp.status()).toBe(200);
  const owner = (await ownerResp.json()) as { totalOutstanding: number };
  expect(Math.abs(owner.totalOutstanding - 50)).toBeLessThanOrEqual(0.01);
});

test('51.3 — recorded payment SURVIVES a building recompute (expense edit)', async ({
  request: req
}) => {
  // Touch the building expense (PATCH name) → triggers _recomputeVacantOwnerCharges.
  // The owner καταβολή recorded in 51.2 must persist (carry-forward).
  const patch = await req.patch(
    `${GATEWAY}/api/v2/buildings/${BID}/expenses/${EXP_A}`,
    { headers: headers(), data: { name: 'E2E51-Mgmt' } }
  );
  expect([200, 201]).toContain(patch.status());
  await new Promise((r) => setTimeout(r, 1500));

  const rows = readOwnerRows();
  const oldRow = rows!.find((r) => r.expenseId === EXP_A && r.term === TERM_OLD);
  expect(oldRow, 'oldest charge still present').toBeTruthy();
  expect(
    oldRow!.payCount,
    'payment SURVIVES the recompute (carry-forward)'
  ).toBe(1);
  expect(oldRow!.paid, 'derived paid survives').toBe(true);
});

test('51.4 — custom allocation over a charge outstanding is rejected 422', async ({
  request: req
}) => {
  // The €50 TERM_NEW charge is unpaid; try to allocate €80 to it → 422.
  // First find its ownerExpenseId via the owner detail.
  const ownerResp = await req.get(
    `${GATEWAY}/api/v2/owners/${encodeURIComponent(OWNER_KEY)}`,
    { headers: headers() }
  );
  const owner = (await ownerResp.json()) as {
    charges: Array<{ ownerExpenseId: string; expenseId: string; outstanding: number }>;
  };
  const newCharge = owner.charges.find((c) => c.expenseId === EXP_B);
  expect(newCharge, 'unpaid €50 charge present').toBeTruthy();

  const over = await req.post(
    `${GATEWAY}/api/v2/owners/${encodeURIComponent(OWNER_KEY)}/payment`,
    {
      headers: headers(),
      data: {
        payment: {
          date: `${YEAR}-06-16`, amount: 80, type: 'cash',
          allocation: [{ ownerExpenseId: newCharge!.ownerExpenseId, amount: 80 }]
        }
      }
    }
  );
  expect(
    over.status(),
    `over-allocation must be 422, got ${over.status()}`
  ).toBe(422);

  // Duplicate-entry overpay (40+40 on a €50 row) must also 422 (fold-then-cap).
  const dup = await req.post(
    `${GATEWAY}/api/v2/owners/${encodeURIComponent(OWNER_KEY)}/payment`,
    {
      headers: headers(),
      data: {
        payment: {
          date: `${YEAR}-06-16`, amount: 80, type: 'cash',
          allocation: [
            { ownerExpenseId: newCharge!.ownerExpenseId, amount: 40 },
            { ownerExpenseId: newCharge!.ownerExpenseId, amount: 40 }
          ]
        }
      }
    }
  );
  expect(
    dup.status(),
    `duplicate-entry overpay must be 422 (fold-then-cap), got ${dup.status()}`
  ).toBe(422);
});
