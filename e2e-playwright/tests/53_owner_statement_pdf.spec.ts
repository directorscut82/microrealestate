/**
 * 53 — Owner expense statement PDF (Εκκαθαριστικό εξόδων ιδιοκτήτη).
 * End-to-end proof the new owner_statement document renders: seed an owner
 * with two owner-direct charges via mongoExec, then GET the deployed
 * /documents/owner-statement/:ownerKey/:term endpoint and assert a real PDF
 * (%PDF header, non-trivial size) comes back. This exercises the full chain:
 * route → buildOwnerStatement (common) → data picker → EJS template →
 * puppeteer/chromium. Skips gracefully if portainer-token (mongoExec) is
 * absent locally.
 */
import { expect, test } from '@playwright/test';
import { getAccessToken } from './lib/api';
import { mongoExec } from './lib/mongoExec';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const ORG_NAME = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';

const BID = 'aa0000000000000000000053';
const P1 = 'aa00000000000000000053p1';
const EXP_A = 'aa00000000000000000053a1';
const B_NAME = 'E2E53-Building';
const OWNER_NAME = 'E2E53 Owner';
const OWNER_TAX = '530530530';
const OWNER_KEY = `n:${OWNER_NAME.toLowerCase()}|${OWNER_TAX}`;
const YEAR = new Date().getFullYear();
const TERM = YEAR * 1000000 + 60100; // June this year

let token = '';
let orgId = '';

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

function q(s: string) {
  return s.replace(/"/g, '\\"');
}

function seed() {
  return mongoExec(`
    var r = db.realms.findOne({name: "${q(ORG_NAME)}"});
    if (!r) { print("NO_REALM"); quit(); }
    var rid = String(r._id.valueOf());
    db.buildings.deleteOne({_id: ObjectId("${BID}")});
    db.buildings.insertOne({
      _id: ObjectId("${BID}"),
      realmId: rid,
      name: "${B_NAME}",
      atakPrefix: "E2E53",
      address: { street1: "T", city: "T", zipCode: "00000" },
      units: [
        { _id: ObjectId(), atakNumber: "E2E53-U1", isManaged: true, occupancyType: "owner_occupied", propertyId: "${P1}", generalThousandths: 1000, surface: 60, monthlyCharges: [],
          owners: [{ type: "external", percentage: 100, name: "${OWNER_NAME}", taxId: "${OWNER_TAX}" }] }
      ],
      expenses: [
        { _id: ObjectId("${EXP_A}"), name: "E2E53-Mgmt", type: "management_fee", amount: 0, allocationMethod: "equal", isRecurring: true, startTerm: ${TERM}, customAllocations: [], trackOwnerExpense: true, ownerAmount: 0 }
      ],
      ownerMonthlyExpenses: [
        { _id: ObjectId(), expenseId: "${EXP_A}", term: ${TERM}, amount: 120, source: "expense", description: "E2E53-Mgmt", paid: false, paidDate: null, payments: [] }
      ],
      repairs: [],
      createdDate: new Date(), updatedDate: new Date(), __v: 0
    });
    print(rid);
  `);
}

test.beforeAll(async ({ request }) => {
  token = await getAccessToken(request);
  const rid = seed();
  test.skip(!rid || rid === 'NO_REALM', 'mongoExec unavailable or realm missing');
  orgId = String(rid);
});

test.afterAll(() => {
  mongoExec(`db.buildings.deleteOne({_id: ObjectId("${BID}")});`);
});

test('53.1 — owner statement endpoint returns a valid PDF for the seeded owner', async ({
  request
}) => {
  const resp = await request.get(
    `${GATEWAY}/api/v2/documents/owner-statement/${encodeURIComponent(
      OWNER_KEY
    )}/${YEAR}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        organizationid: orgId
      }
    }
  );
  expect(resp.status(), 'owner-statement PDF status').toBe(200);
  const ct = resp.headers()['content-type'] || '';
  // res.download sets application/pdf (or octet-stream); the body must be a PDF.
  const body = await resp.body();
  expect(body.length, 'PDF non-trivial size').toBeGreaterThan(1000);
  expect(body.subarray(0, 5).toString('latin1'), 'PDF magic header').toBe('%PDF-');
  // content-type sanity (download sets it from the file extension)
  expect(ct.toLowerCase()).toContain('pdf');
});

test('53.2 — unknown owner / empty statement returns 404 (not a blank PDF)', async ({
  request
}) => {
  const resp = await request.get(
    `${GATEWAY}/api/v2/documents/owner-statement/${encodeURIComponent(
      'n:nobody here|000'
    )}/${YEAR}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        organizationid: orgId
      }
    }
  );
  expect(resp.status(), 'unknown owner → 404').toBe(404);
});
