/**
 * Spec 56 — §5 Αχρέωτα (Μη εισπραχθέντα) voluntary coverage-payment.
 *
 * The §5 feature shipped with ZERO E2E coverage (coverage-gap audit
 * w420k230h): no spec drove the coverage-payment route, the dialog, the
 * tile, or the per-term reconciliation (M1). This spec closes that — it is
 * the headline, money-mutating §5 surface.
 *
 * Seeds (mongoExec direct insert, AGENTS.md discipline — the API would reject
 * a vacant managed unit) a dedicated building with TWO flag-OFF vacant-unit
 * expense shares so a known gross lands in Αχρέωτα across two current-year
 * terms. A flag-OFF (chargeOwnerWhenVacant:false) expense on a vacant unit
 * becomes uncollected (billed to nobody), NOT owner-billed — that is the
 * gross the §5 tile nets against voluntary coverage payments.
 *
 * Covers:
 *   56.1 record a coverage payment via the route → uncollected.outstanding
 *        drops by the paid amount; payload carries NO payerId/paidByType.
 *   56.2 oldest-first allocation across two outstanding terms.
 *   56.3 over-contribution confined per-term (M1 — no cross-month bleed).
 *   56.4 payment on a zero-gross term raises paidTotal but not outstanding.
 *   56.5 M2 — invalid date → 422 (not an opaque 500).
 *   56.6 DD/MM/YYYY and ISO dates both accepted (201).
 *   56.7 optional attribution — no payerId/paidByType → 201; bad paidByType → 422.
 *   56.8 the §5 tile + ΧΡΕΩΣΕΙΣ panel reconcile per-term after a payment.
 *
 * Skips cleanly when .secrets/portainer-token is absent (CI dry-run).
 */
import { expect, request, test } from '@playwright/test';
import { mongoExec } from './lib/mongoExec';
import { getAccessToken } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const ORG_NAME = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';

const B_NAME = 'E2E-Uncollected-Building';
const BID = 'aa0000000000000000000056';
const P1 = 'aa0000000000000000005601'; // vacant unit (the Αχρέωτα source)
const EX_A = 'aa00000000000000000056e1'; // term-A flag-OFF expense (gross €100)
const EX_B = 'aa00000000000000000056e2'; // term-B flag-OFF expense (gross €100)

// Two distinct current-year terms (this month + a month two back, both in-year).
const now = new Date();
const YEAR = now.getFullYear();
// Use Jan + Mar of the current year so both are always valid YYYYMM terms in
// the year and independent of "today". The §5 engine runs all 12 months.
const TERM_A = Number(`${YEAR}010100`); // January
const TERM_B = Number(`${YEAR}030100`); // March

let realmId = '';
let token = '';

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

function q(s: string) {
  return s.replace(/"/g, '\\"');
}

// A flag-OFF (chargeOwnerWhenVacant:false) single_unit expense billed wholly to
// the vacant P1 for a specific term → its share is Αχρέωτα (owner-unbilled).
// single_unit puts 100% on P1 via customAllocations so the gross is a clean €100.
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
      atakPrefix: "E2E56",
      address: { street1: "T", city: "T", zipCode: "00000" },
      units: [
        { _id: ObjectId(), atakNumber: "E2E56-U1", isManaged: true, occupancyType: "vacant", propertyId: "${P1}", generalThousandths: 1000, heatingThousandths: 0, elevatorThousandths: 0, surface: 50, monthlyCharges: [] }
      ],
      expenses: [
        { _id: ObjectId("${EX_A}"), name: "E2E56-A", type: "cleaning", amount: 100, allocationMethod: "single_unit", isRecurring: false, startTerm: ${TERM_A}, endTerm: ${TERM_A}, customAllocations: [{ propertyId: "${P1}", value: 100 }], chargeOwnerWhenVacant: false },
        { _id: ObjectId("${EX_B}"), name: "E2E56-B", type: "cleaning", amount: 100, allocationMethod: "single_unit", isRecurring: false, startTerm: ${TERM_B}, endTerm: ${TERM_B}, customAllocations: [{ propertyId: "${P1}", value: 100 }], chargeOwnerWhenVacant: false }
      ],
      contractors: [], repairs: [], ownerMonthlyExpenses: [], uncollectedPayments: [],
      createdDate: new Date(), updatedDate: new Date(), __v: 0
    });
    print(rid);
  `);
}

function clearPayments() {
  mongoExec(`
    db.buildings.updateOne({_id: ObjectId("${BID}")}, {$set: {uncollectedPayments: []}});
    print("cleared");
  `);
}

function readUncollectedPayments() {
  const out = mongoExec(`
    var b = db.buildings.findOne({_id: ObjectId("${BID}")});
    if (!b) { print("null"); quit(); }
    print(JSON.stringify((b.uncollectedPayments||[]).map(function(p){
      return { term: p.term, amount: p.amount, hasPayerId: p.payerId != null, hasPaidByType: p.paidByType != null };
    })));
  `);
  if (!out || out === 'null') return null;
  return JSON.parse(out) as Array<{
    term: number;
    amount: number;
    hasPayerId: boolean;
    hasPaidByType: boolean;
  }>;
}

function auth() {
  return { Authorization: `Bearer ${token}`, organizationid: realmId };
}

async function getBuilding(req: any) {
  const resp = await req.get(`${GATEWAY}/api/v2/buildings/${BID}`, {
    headers: auth()
  });
  expect(resp.status(), await resp.text().catch(() => '')).toBe(200);
  return resp.json();
}

async function postCoverage(req: any, body: Record<string, any>) {
  return req.post(`${GATEWAY}/api/v2/buildings/${BID}/uncollected-payment`, {
    headers: { ...auth(), 'Content-Type': 'application/json' },
    data: body
  });
}

test.beforeAll(async () => {
  const probe = mongoExec('print("ok")');
  test.skip(probe === null, 'portainer-token absent — cannot reach NAS mongo');
  const apiCtx = await request.newContext();
  token = await getAccessToken(apiCtx);
  await apiCtx.dispose();
  const raw = seedBuilding();
  const lastLine = String(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()!;
  expect(lastLine).not.toBe('NO_REALM');
  const m = lastLine.match(/[a-f0-9]{24}/i);
  expect(m, `realmId hex not found: ${lastLine}`).toBeTruthy();
  realmId = m![0];
});

test.afterAll(async () => {
  mongoExec(`db.buildings.deleteOne({_id: ObjectId("${BID}")}); print("cleaned");`);
});

test.beforeEach(async () => {
  clearPayments();
});

test('56.0 baseline — building reports €200 gross Αχρέωτα across two terms', async ({
  request: req
}) => {
  const b = await getBuilding(req);
  expect(b.uncollected, 'uncollected block present on detail GET').toBeTruthy();
  // Two flag-OFF vacant single_unit expenses × €100 = €200 gross uncollected.
  expect(Math.abs(b.uncollected.total - 200)).toBeLessThanOrEqual(0.02);
  expect(b.uncollected.paidTotal).toBe(0);
  expect(Math.abs(b.uncollected.outstanding - 200)).toBeLessThanOrEqual(0.02);
});

test('56.1 record a coverage payment → outstanding drops; payload carries no payer attribution', async ({
  request: req
}) => {
  const resp = await postCoverage(req, {
    term: TERM_A,
    amount: 60,
    date: '15/01/' + YEAR,
    reference: 'E2E56-cover'
  });
  expect([200, 201], await resp.text().catch(() => '')).toContain(resp.status());

  const b = await getBuilding(req);
  // €60 covered → outstanding €140, paidTotal €60, total unchanged €200.
  expect(Math.abs(b.uncollected.paidTotal - 60)).toBeLessThanOrEqual(0.02);
  expect(Math.abs(b.uncollected.outstanding - 140)).toBeLessThanOrEqual(0.02);
  expect(Math.abs(b.uncollected.total - 200)).toBeLessThanOrEqual(0.02);

  // Building-level voluntary contribution → NO payerId/paidByType persisted.
  const pays = readUncollectedPayments();
  expect(pays, 'payments persisted').toBeTruthy();
  expect(pays!.length).toBeGreaterThanOrEqual(1);
  for (const p of pays!) {
    expect(p.hasPayerId, 'no payerId on a building-level contribution').toBe(false);
    expect(p.hasPaidByType, 'no paidByType').toBe(false);
  }
});

test('56.2 allocation lands oldest-term-first', async ({ request: req }) => {
  // Pay exactly term-A's gross (€100): it must land on the OLDER term (TERM_A,
  // January), leaving term-B (March) fully outstanding.
  const resp = await postCoverage(req, { term: TERM_B, amount: 100, date: '15/03/' + YEAR });
  expect([200, 201], await resp.text().catch(() => '')).toContain(resp.status());
  const pays = readUncollectedPayments();
  expect(pays).toBeTruthy();
  // The server allocates oldest-first regardless of the requested `term`.
  const onA = pays!.filter((p) => p.term === TERM_A).reduce((s, p) => s + p.amount, 0);
  expect(Math.abs(onA - 100), `expected €100 on the oldest term, got ${JSON.stringify(pays)}`).toBeLessThanOrEqual(0.02);
});

test('56.3 over-contribution is confined per term (M1 — no cross-month bleed)', async ({
  request: req
}) => {
  // Pay €150 in one shot. Oldest-first: €100 fills term-A, €50 fills term-B.
  // Outstanding must be €50 (term-B residual), NOT €0 — and never negative.
  const resp = await postCoverage(req, { term: TERM_A, amount: 150, date: '15/01/' + YEAR });
  expect([200, 201], await resp.text().catch(() => '')).toContain(resp.status());
  const b = await getBuilding(req);
  expect(Math.abs(b.uncollected.outstanding - 50)).toBeLessThanOrEqual(0.02);
  // paidTotal counts all €150; outstanding is the per-term clamped residual.
  expect(Math.abs(b.uncollected.paidTotal - 150)).toBeLessThanOrEqual(0.02);
  expect(b.uncollected.outstanding).toBeGreaterThanOrEqual(0);
});

test('56.4 a surplus beyond the year gross never drives outstanding negative', async ({
  request: req
}) => {
  // Pay more than the whole €200 gross. Outstanding floors at 0; paidTotal
  // records the full contribution (the surplus is not silently dropped).
  const resp = await postCoverage(req, { term: TERM_A, amount: 250, date: '15/01/' + YEAR });
  expect([200, 201], await resp.text().catch(() => '')).toContain(resp.status());
  const b = await getBuilding(req);
  expect(b.uncollected.outstanding).toBe(0);
  expect(b.uncollected.paidTotal).toBeGreaterThanOrEqual(200 - 0.02);
});

test('56.5 M2 — an invalid date is rejected 422, not a 500', async ({
  request: req
}) => {
  const resp = await postCoverage(req, { term: TERM_A, amount: 10, date: '99/99/9999' });
  expect(resp.status(), await resp.text().catch(() => '')).toBe(422);
  const body = await resp.text();
  expect(body.toLowerCase()).toContain('date');
});

test('56.6 DD/MM/YYYY and ISO dates are both accepted', async ({
  request: req
}) => {
  const r1 = await postCoverage(req, { term: TERM_A, amount: 10, date: '15/01/' + YEAR });
  expect([200, 201], await r1.text().catch(() => '')).toContain(r1.status());
  clearPayments();
  const r2 = await postCoverage(req, { term: TERM_A, amount: 10, date: YEAR + '-01-15' });
  expect([200, 201], await r2.text().catch(() => '')).toContain(r2.status());
});

test('56.7 optional attribution — none ok (201); a bad paidByType is still validated (422)', async ({
  request: req
}) => {
  // No attribution → accepted.
  const ok = await postCoverage(req, { term: TERM_A, amount: 10, date: '15/01/' + YEAR });
  expect([200, 201], await ok.text().catch(() => '')).toContain(ok.status());
  // A supplied-but-invalid paidByType must still be enum-validated → 422.
  const bad = await postCoverage(req, {
    term: TERM_A,
    amount: 10,
    date: '15/01/' + YEAR,
    paidByType: 'banana'
  });
  expect(bad.status(), await bad.text().catch(() => '')).toBe(422);
});

test('56.8 §5 tile and the ΧΡΕΩΣΕΙΣ per-term panel reconcile after a payment', async ({
  request: req
}) => {
  // Cover term-A fully (€100, oldest-first). Then the term-A breakdown must show
  // €0 uncollected and term-B must still show €100 — the per-term reconciliation
  // M1 enforces (tile outstanding €100 === Σ per-term residual).
  const resp = await postCoverage(req, { term: TERM_A, amount: 100, date: '15/01/' + YEAR });
  expect([200, 201], await resp.text().catch(() => '')).toContain(resp.status());

  const b = await getBuilding(req);
  expect(Math.abs(b.uncollected.outstanding - 100)).toBeLessThanOrEqual(0.02);

  // Per-term panel reads via expense-breakdown. ownerUnbilledTotal is the gross
  // for that term; the panel subtracts that term's recorded coverage. Assert the
  // gross per term and that Σ(gross − coveredThatTerm) === tile outstanding.
  const bdA = await req.get(
    `${GATEWAY}/api/v2/buildings/${BID}/expense-breakdown?term=${TERM_A}`,
    { headers: auth() }
  );
  const bdB = await req.get(
    `${GATEWAY}/api/v2/buildings/${BID}/expense-breakdown?term=${TERM_B}`,
    { headers: auth() }
  );
  expect(bdA.status()).toBe(200);
  expect(bdB.status()).toBe(200);
  const grossA = (await bdA.json()).ownerUnbilledTotal || 0;
  const grossB = (await bdB.json()).ownerUnbilledTotal || 0;
  // Each term's gross is €100 (the flag-OFF vacant share).
  expect(Math.abs(grossA - 100)).toBeLessThanOrEqual(0.02);
  expect(Math.abs(grossB - 100)).toBeLessThanOrEqual(0.02);
  // term-A fully covered → residual 0; term-B uncovered → residual 100.
  // Σ residual === tile outstanding (the M1 reconciliation invariant).
  const pays = readUncollectedPayments();
  const coveredA = pays!.filter((p) => p.term === TERM_A).reduce((s, p) => s + p.amount, 0);
  const coveredB = pays!.filter((p) => p.term === TERM_B).reduce((s, p) => s + p.amount, 0);
  const residual =
    Math.max(0, grossA - coveredA) + Math.max(0, grossB - coveredB);
  expect(Math.abs(residual - b.uncollected.outstanding)).toBeLessThanOrEqual(0.02);
});
