/**
 * Spec 65 — owner-payment txnId idempotency (partial-commit retry safety).
 *
 * The client stamps a content-derived txnId on each καταβολή; the server
 * reconciles a retry by subtracting slices already recorded under the same
 * (txnId, ownerKey) so a replay after a multi-building partial commit can
 * NEVER double-record (mongo 4.4 standalone has no multi-doc transaction).
 * Verified against the DEPLOYED NAS:
 *
 *   65.1 — POST payment WITH txnId records normally; mongo readback shows the
 *          slice carries the txnId.
 *   65.2 — EXACT replay (same txnId, same payload) → alreadyRecorded:true,
 *          nothing written (payments count and paySum unchanged), outstanding
 *          unchanged. The double-record path is dead.
 *   65.3 — PARTIAL reconcile: replay same txnId with a LARGER amount → server
 *          records only the remainder, responds reconciledTotal = the
 *          already-landed part and allocatedTotal = the full cumulative sum;
 *          mongo shows no duplicate of the first slice.
 *   65.4 — a DIFFERENT txnId (genuine second payment) records normally on the
 *          remaining outstanding.
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

const B_NAME = 'E2E-OwnerTxn-Building';
const BID = 'aa0000000000000000000065';
const P1 = 'aa0000000000000000006501';
const EXP_A = 'aa00000000000000000065a1'; // older charge €100
const EXP_B = 'aa00000000000000000065b1'; // newer charge €80
const OWNER_NAME = 'E2E65-Owner-Txn';
const OWNER_TAX = '659999650';
const OWNER_KEY = `n:${OWNER_NAME.toLowerCase()}|${OWNER_TAX}`;

const TXN_1 = 'e2e65-txn-aaaabbbb';
const TXN_2 = 'e2e65-txn-ccccdddd';

const now = new Date();
const YEAR = now.getFullYear();
const TERM_OLD = (YEAR - 1) * 1000000 + 110100;
const TERM_NEW = YEAR * 1000000 + 10100;

let realmId = '';
let token = '';

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

function q(s: string) {
  return s.replace(/"/g, '\\"');
}

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
      atakPrefix: "E2E65",
      address: { street1: "T", city: "T", zipCode: "00000" },
      units: [
        { _id: ObjectId(), atakNumber: "E2E65-U1", isManaged: true, occupancyType: "owner_occupied", propertyId: "${P1}", generalThousandths: 1000, surface: 60, monthlyCharges: [],
          owners: [{ type: "external", percentage: 100, name: "${OWNER_NAME}", taxId: "${OWNER_TAX}" }] }
      ],
      expenses: [
        { _id: ObjectId("${EXP_A}"), name: "E2E65-Mgmt", type: "management_fee", amount: 0, allocationMethod: "equal", isRecurring: true, startTerm: ${TERM_OLD}, customAllocations: [], trackOwnerExpense: true, ownerAmount: 0 }
      ],
      ownerMonthlyExpenses: [
        { _id: ObjectId(), expenseId: "${EXP_A}", term: ${TERM_OLD}, amount: 100, source: "expense", description: "E2E65-old", paid: false, paidDate: null, payments: [] },
        { _id: ObjectId(), expenseId: "${EXP_B}", term: ${TERM_NEW}, amount: 80,  source: "expense", description: "E2E65-new", paid: false, paidDate: null, payments: [] }
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
        paySum: (e.payments||[]).reduce(function(s,p){return s+(Number(p.amount)||0)},0),
        txnIds: (e.payments||[]).map(function(p){return p.txnId||null}) };
    })));
  `);
  if (!out || out === 'null') return null;
  return JSON.parse(out) as Array<{
    expenseId: string; term: number; amount: number; paid: boolean;
    payCount: number; paySum: number; txnIds: (string | null)[];
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

test('65.1 — payment WITH txnId records; slice carries the txnId', async ({
  request: req
}) => {
  // €60 auto-spread → lands on the €100 TERM_OLD charge (partial).
  const resp = await req.post(
    `${GATEWAY}/api/v2/owners/${encodeURIComponent(OWNER_KEY)}/payment`,
    {
      headers: headers(),
      data: {
        payment: {
          date: `10/06/${YEAR}`, amount: 60, type: 'transfer',
          reference: 'E2E65-A', txnId: TXN_1
        }
      }
    }
  );
  expect(resp.status(), await resp.text().catch(() => '')).toBe(200);
  const body = (await resp.json()) as {
    allocatedTotal: number; alreadyRecorded?: boolean; reconciledTotal?: number;
  };
  expect(Math.abs(body.allocatedTotal - 60)).toBeLessThanOrEqual(0.01);
  expect(body.alreadyRecorded).toBeFalsy();
  expect(body.reconciledTotal).toBeFalsy();

  const rows = readOwnerRows()!;
  const oldRow = rows.find((r) => r.expenseId === EXP_A)!;
  expect(oldRow.payCount).toBe(1);
  expect(Math.abs(oldRow.paySum - 60)).toBeLessThanOrEqual(0.01);
  expect(oldRow.txnIds).toEqual([TXN_1]); // slice stamped with the txnId
});

test('65.2 — EXACT replay (same txnId) → alreadyRecorded, NOTHING re-recorded', async ({
  request: req
}) => {
  // The double-record scenario: identical payload replayed (e.g. after a
  // partial-commit 409 + dialog reopen). committed.total=60, remainder=0 →
  // idempotent success, zero writes.
  const resp = await req.post(
    `${GATEWAY}/api/v2/owners/${encodeURIComponent(OWNER_KEY)}/payment`,
    {
      headers: headers(),
      data: {
        payment: {
          date: `10/06/${YEAR}`, amount: 60, type: 'transfer',
          reference: 'E2E65-A', txnId: TXN_1
        }
      }
    }
  );
  expect(resp.status(), await resp.text().catch(() => '')).toBe(200);
  const body = (await resp.json()) as {
    allocatedTotal: number; alreadyRecorded?: boolean;
  };
  expect(body.alreadyRecorded, 'replay flagged alreadyRecorded').toBe(true);
  expect(Math.abs(body.allocatedTotal - 60)).toBeLessThanOrEqual(0.01);

  // Value-delta proof (not existence): still exactly ONE slice, sum 60.
  const rows = readOwnerRows()!;
  const oldRow = rows.find((r) => r.expenseId === EXP_A)!;
  expect(oldRow.payCount, 'no duplicate slice').toBe(1);
  expect(Math.abs(oldRow.paySum - 60)).toBeLessThanOrEqual(0.01);
});

test('65.3 — PARTIAL reconcile: same txnId, larger amount → only remainder recorded + reconciledTotal', async ({
  request: req
}) => {
  // Simulates the multi-building partial-commit retry: 60 already landed under
  // TXN_1; the client replays the submit with the full intended €100. Server
  // must record only the €40 remainder and surface reconciledTotal=60.
  const resp = await req.post(
    `${GATEWAY}/api/v2/owners/${encodeURIComponent(OWNER_KEY)}/payment`,
    {
      headers: headers(),
      data: {
        payment: {
          date: `10/06/${YEAR}`, amount: 100, type: 'transfer',
          reference: 'E2E65-A', txnId: TXN_1
        }
      }
    }
  );
  expect(resp.status(), await resp.text().catch(() => '')).toBe(200);
  const body = (await resp.json()) as {
    allocatedTotal: number; alreadyRecorded?: boolean; reconciledTotal?: number;
  };
  expect(body.alreadyRecorded).toBeFalsy();
  expect(body.reconciledTotal, 'partial reconcile surfaced').toBeTruthy();
  expect(Math.abs((body.reconciledTotal || 0) - 60)).toBeLessThanOrEqual(0.01);
  // allocatedTotal = full cumulative (60 already + 40 now).
  expect(Math.abs(body.allocatedTotal - 100)).toBeLessThanOrEqual(0.01);

  // Mongo: the old charge now fully paid (60 + 40 = 100), exactly 2 slices,
  // both under TXN_1 — no duplicate of the first 60.
  const rows = readOwnerRows()!;
  const oldRow = rows.find((r) => r.expenseId === EXP_A)!;
  expect(oldRow.payCount).toBe(2);
  expect(Math.abs(oldRow.paySum - 100)).toBeLessThanOrEqual(0.01);
  expect(oldRow.paid).toBe(true);
  expect(oldRow.txnIds).toEqual([TXN_1, TXN_1]);
  // Newer charge untouched by the reconcile.
  const newRow = rows.find((r) => r.expenseId === EXP_B)!;
  expect(newRow.payCount).toBe(0);
});

test('65.4 — a DIFFERENT txnId (genuine 2nd payment) records normally', async ({
  request: req
}) => {
  const resp = await req.post(
    `${GATEWAY}/api/v2/owners/${encodeURIComponent(OWNER_KEY)}/payment`,
    {
      headers: headers(),
      data: {
        payment: {
          date: `11/06/${YEAR}`, amount: 80, type: 'transfer',
          reference: 'E2E65-B', txnId: TXN_2
        }
      }
    }
  );
  expect(resp.status(), await resp.text().catch(() => '')).toBe(200);
  const body = (await resp.json()) as {
    allocatedTotal: number; alreadyRecorded?: boolean; reconciledTotal?: number;
  };
  expect(body.alreadyRecorded).toBeFalsy();
  expect(body.reconciledTotal).toBeFalsy();
  expect(Math.abs(body.allocatedTotal - 80)).toBeLessThanOrEqual(0.01);

  const rows = readOwnerRows()!;
  const newRow = rows.find((r) => r.expenseId === EXP_B)!;
  expect(newRow.payCount).toBe(1);
  expect(Math.abs(newRow.paySum - 80)).toBeLessThanOrEqual(0.01);
  expect(newRow.paid).toBe(true);
  expect(newRow.txnIds).toEqual([TXN_2]);
});
