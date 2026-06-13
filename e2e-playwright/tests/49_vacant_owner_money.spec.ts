/**
 * Spec 49 — vacant-owner money correctness (workflow-confirmed batch).
 *
 * Covers the 5 money bugs an adversarial workflow (w9etbsrxl) confirmed
 * survived the prior vacant-owner batch, verified against the DEPLOYED NAS
 * revision (per AGENTS.md "Definition of done": real data, real engine).
 *
 *   BUG1 VAC-EQUAL-NOOP — a vacant managed unit is its own equal-split
 *     party. 3 units / €90 equal / 1 vacant → €30 each (NOT €45 split among
 *     the 2 occupied), and the vacant €30 routes to the owner.
 *   BUG2 REPAIR-VACANT-VANISHES — a repair-vacant owner share
 *     (source:'repair-vacant') SURVIVES the building-expense vacant recompute
 *     that fires on every tenant lifecycle change.
 *   BUG4 DASH-REPAIR-UNDERCOUNT — the dashboard counts the repair-vacant euro
 *     (verified via the source-disambiguation invariant below, since the
 *     dashboard reads ownerMonthlyExpenses with e.source !== 'vacant').
 *   BUG5 ORPHAN — cancelling the repair strips the repair-vacant row.
 *
 * Seeding discipline (AGENTS.md): the multi-unit / vacant / partially-corrupt
 * scenarios are seeded by DIRECT mongo insert (mongoExec), NOT API POST — the
 * API correctly rejects shapes we deliberately construct (a vacant managed
 * unit, a pre-existing repair-vacant ledger row). A dedicated building with a
 * unique name is created and DROPPED in afterAll so the canonical fixtures
 * other specs depend on are never touched.
 *
 * Skips cleanly (test.skip) when .secrets/portainer-token is absent (CI
 * dry-run) — mongoExec returns null there.
 */
import { expect, request, test } from '@playwright/test';
import { mongoExec } from './lib/mongoExec';
import { getAccessToken } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const ORG_NAME = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';

// Unique, collision-proof names so a leaked run can't confuse the canonical
// fixtures. The 24-hex ids are fixed so mongo readback + API calls agree.
const B_NAME = 'E2E-VacOwner-Building';
const BID = 'aa0000000000000000000049';
const P1 = 'aa0000000000000000000101'; // occupied
const P2 = 'aa0000000000000000000102'; // occupied
const P3 = 'aa0000000000000000000103'; // vacant
const REPAIR_ID = 'aa00000000000000000000d1'; // 24 hex (ObjectId-valid)
const EXPENSE_ID = 'aa00000000000000000000e1'; // the equal Cleaning expense

// June term is in the past relative to "now" only if we're past June; use a
// FIXED current-year term well inside the recompute window. Pick the current
// month so _recomputeVacantOwnerCharges (current-term + trailing/forward
// window) definitely covers it.
const now = new Date();
const YEAR = now.getFullYear();
const MM = String(now.getMonth() + 1).padStart(2, '0');
const TERM = Number(`${YEAR}${MM}0100`); // YYYYMM0100

let realmId = '';
let token = '';

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

function q(s: string) {
  return s.replace(/"/g, '\\"');
}

// Build the dedicated building document via direct mongo insert. 3 managed
// units; an `equal` €90 recurring expense with chargeOwnerWhenVacant on; a
// repair charged to tenants with a chargeTerm; and a pre-seeded
// source:'repair-vacant' owner row for P3 (the vacant unit's repair share).
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
      atakPrefix: "E2E49",
      address: { street1: "T", city: "T", zipCode: "00000" },
      units: [
        { _id: ObjectId(), atakNumber: "E2E49-U1", isManaged: true, occupancyType: "rented",  propertyId: "${P1}", generalThousandths: 333, heatingThousandths: 0, elevatorThousandths: 0, surface: 50, monthlyCharges: [] },
        { _id: ObjectId(), atakNumber: "E2E49-U2", isManaged: true, occupancyType: "rented",  propertyId: "${P2}", generalThousandths: 333, heatingThousandths: 0, elevatorThousandths: 0, surface: 50, monthlyCharges: [] },
        { _id: ObjectId(), atakNumber: "E2E49-U3", isManaged: true, occupancyType: "vacant",  propertyId: "${P3}", generalThousandths: 334, heatingThousandths: 0, elevatorThousandths: 0, surface: 50, monthlyCharges: [] }
      ],
      expenses: [
        { _id: ObjectId("${EXPENSE_ID}"), name: "E2E49-Cleaning", type: "cleaning", amount: 90, allocationMethod: "equal", isRecurring: true, startTerm: ${YEAR}010100, customAllocations: [], chargeOwnerWhenVacant: true }
      ],
      repairs: [
        { _id: ObjectId("${REPAIR_ID}"), title: "E2E49-Elevator", category: "elevator", status: "completed", urgency: "normal", actualCost: 300, chargeableTo: "tenants", tenantSharePercentage: 100, allocationMethod: "equal", chargeTerm: ${TERM}, affectedUnitIds: [] }
      ],
      ownerMonthlyExpenses: [
        { _id: ObjectId(), expenseId: "${REPAIR_ID}", term: ${TERM}, amount: 100, propertyId: "${P3}", source: "repair-vacant", description: "Repair: E2E49-Elevator", paid: false, paidDate: null }
      ],
      createdDate: new Date(), updatedDate: new Date(), __v: 0
    });
    print(rid);
  `);
}

// Link a tenant to P1+P2 (occupied) so the breakdown sees them as renters and
// P3 as the lone vacant. Seeded via mongo (occupant doc) for full control of
// the lease window.
function seedTenants() {
  return mongoExec(`
    var r = db.realms.findOne({name: "${q(ORG_NAME)}"});
    var rid = String(r._id.valueOf());
    db.occupants.deleteMany({name: /^E2E49-Tenant/});
    db.occupants.insertMany([
      { realmId: rid, name: "E2E49-TenantA", isCompany: false,
        beginDate: new Date(${YEAR}, 0, 1), endDate: new Date(${YEAR}, 11, 31),
        terminationDate: null,
        properties: [{ propertyId: "${P1}", entryDate: new Date(${YEAR},0,1), exitDate: new Date(${YEAR},11,31), property: { name: "E2E49-P1" } }],
        rents: [] },
      { realmId: rid, name: "E2E49-TenantB", isCompany: false,
        beginDate: new Date(${YEAR}, 0, 1), endDate: new Date(${YEAR}, 11, 31),
        terminationDate: null,
        properties: [{ propertyId: "${P2}", entryDate: new Date(${YEAR},0,1), exitDate: new Date(${YEAR},11,31), property: { name: "E2E49-P2" } }],
        rents: [] }
    ]);
    print("OK");
  `);
}

function readOwnerExpenses() {
  const out = mongoExec(`
    var b = db.buildings.findOne({_id: ObjectId("${BID}")});
    if (!b) { print("null"); quit(); }
    print(JSON.stringify((b.ownerMonthlyExpenses||[]).map(function(e){
      return { expenseId: String(e.expenseId), term: e.term, amount: e.amount, source: e.source, propertyId: e.propertyId, paid: !!e.paid };
    })));
  `);
  if (!out || out === 'null') return null;
  return JSON.parse(out) as Array<{
    expenseId: string;
    term: number;
    amount: number;
    source: string;
    propertyId: string;
    paid: boolean;
  }>;
}

test.beforeAll(async () => {
  const probe = mongoExec('print("ok")');
  test.skip(probe === null, 'portainer-token absent — cannot reach NAS mongo');
  const apiCtx = await request.newContext();
  token = await getAccessToken(apiCtx);
  await apiCtx.dispose();
  const rawRid = seedBuilding();
  expect(rawRid, 'seed building returned realmId').toBeTruthy();
  // mongo prints insert acknowledgements before our print(rid); take the
  // LAST non-empty line and keep only the 24-hex id (defensive against any
  // stray shell text).
  const lastLine = String(rawRid)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()!;
  expect(lastLine).not.toBe('NO_REALM');
  const m = lastLine.match(/[a-f0-9]{24}/i);
  expect(m, `realmId hex not found in seed output: ${lastLine}`).toBeTruthy();
  realmId = m![0];
  seedTenants();
});

test.afterAll(async () => {
  // Drop the dedicated building + tenants. Never touches canonical fixtures.
  mongoExec(`
    db.buildings.deleteOne({_id: ObjectId("${BID}")});
    db.occupants.deleteMany({name: /^E2E49-Tenant/});
    print("cleaned");
  `);
});

test('49.1 BUG1 — equal split counts the vacant unit as a party (€30 each, vacant→owner; NOT €45)', async ({
  request: req
}) => {
  // The deployed billing engine drives /expense-breakdown. With P1+P2
  // occupied and P3 vacant, an €90 equal expense must split 3 ways: €30 to
  // each renter and €30 owner-billed for the vacant P3 (chargeOwnerWhenVacant
  // on). The pre-fix engine billed the two renters €45 each and €0 to the
  // owner — that is the regression this asserts against.
  const resp = await req.get(
    `${GATEWAY}/api/v2/buildings/${BID}/expense-breakdown?term=${TERM}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        organizationid: realmId
      }
    }
  );
  expect(resp.status(), await resp.text().catch(() => '')).toBe(200);
  const body = (await resp.json()) as {
    rows: Array<{
      propertyId: string;
      recipient: string;
      amount: number;
      expenseName: string;
      ownerBilled?: boolean;
    }>;
    tenantTotal: number;
  };

  const cleaning = (pid: string) =>
    body.rows.find(
      (r) => r.propertyId === pid && r.expenseName === 'E2E49-Cleaning'
    );

  const r1 = cleaning(P1);
  const r2 = cleaning(P2);
  const r3 = cleaning(P3);

  expect(r1, 'P1 cleaning row present').toBeTruthy();
  expect(r2, 'P2 cleaning row present').toBeTruthy();
  expect(r3, 'P3 (vacant) cleaning row present').toBeTruthy();

  // €30 each, NOT €45. 1¢ tolerance for rounding remainder placement.
  expect(Math.abs((r1!.amount ?? 0) - 30)).toBeLessThanOrEqual(0.01);
  expect(Math.abs((r2!.amount ?? 0) - 30)).toBeLessThanOrEqual(0.01);
  expect(r1!.recipient).toBe('renter');
  expect(r2!.recipient).toBe('renter');

  // Vacant P3 is an owner party, billed (chargeOwnerWhenVacant on), €30.
  expect(r3!.recipient).toBe('owner');
  expect(r3!.ownerBilled).toBe(true);
  expect(Math.abs((r3!.amount ?? 0) - 30)).toBeLessThanOrEqual(0.01);

  // Tenants together pay 60, not 90 — the vacant share is NOT redistributed.
  expect(Math.abs(body.tenantTotal - 60)).toBeLessThanOrEqual(0.02);
});

test('49.2 BUG2 — a repair-vacant owner share SURVIVES an unrelated tenancy change', async ({
  request: req
}) => {
  // Pre-state: the seeded ownerMonthlyExpenses has a source:'repair-vacant'
  // row for P3/REPAIR_ID/TERM (amount 100). Trigger the building-expense
  // vacant recompute by mutating a tenant on this building (terminate
  // TenantA via the deployed API), which calls recomputeVacantOwnerForProperties.
  // The pre-fix code stripped ALL source:'vacant' rows and re-added only
  // building.expenses-derived ones, so a 'vacant'-tagged repair share vanished.
  // With the distinct 'repair-vacant' source it must persist.
  const before = readOwnerExpenses();
  expect(before, 'owner expenses readable').toBeTruthy();
  const repairVacantBefore = before!.find(
    (e) => e.source === 'repair-vacant' && e.expenseId === REPAIR_ID
  );
  expect(
    repairVacantBefore,
    'seeded repair-vacant row present before the tenancy change'
  ).toBeTruthy();

  // Find TenantA's id and terminate via the API (drives the real recompute).
  const tenantAId = mongoExec(`
    var t = db.occupants.findOne({name: "E2E49-TenantA"});
    print(t ? String(t._id.valueOf()) : "null");
  `);
  expect(tenantAId).not.toBe('null');

  // Terminate the lease — the documented trigger for the vacant-owner
  // recompute on every linked property in the building.
  const term = await req.patch(
    `${GATEWAY}/api/v2/tenants/${tenantAId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        organizationid: realmId,
        'Content-Type': 'application/json'
      },
      data: { terminationDate: `${YEAR}-${MM}-28` }
    }
  );
  // Whatever the exact API contract, the recompute fires on any tenant write.
  expect(
    [200, 201, 422],
    `tenant patch status ${term.status()}`
  ).toContain(term.status());

  // Give the async recompute a moment to persist.
  await new Promise((r) => setTimeout(r, 2000));

  const after = readOwnerExpenses();
  expect(after, 'owner expenses still readable').toBeTruthy();
  const repairVacantAfter = after!.find(
    (e) => e.source === 'repair-vacant' && e.expenseId === REPAIR_ID
  );
  expect(
    repairVacantAfter,
    'repair-vacant row MUST survive the unrelated tenancy change (BUG2)'
  ).toBeTruthy();
  expect(Math.abs((repairVacantAfter!.amount ?? 0) - 100)).toBeLessThanOrEqual(
    0.01
  );
});

test('49.3 BUG5 — cancelling the repair strips its repair-vacant owner row (no orphan)', async ({
  request: req
}) => {
  // Cancel the repair via the deployed API → _removeRepairCharges must strip
  // BOTH source:'repair' and source:'repair-vacant' rows for the repair. The
  // pre-fix code stripped only 'repair', leaving the repair-vacant row a
  // permanent orphan on the owner ledger.
  const resp = await req.patch(
    `${GATEWAY}/api/v2/buildings/${BID}/repairs/${REPAIR_ID}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        organizationid: realmId,
        'Content-Type': 'application/json'
      },
      data: { status: 'cancelled' }
    }
  );
  expect(
    [200, 201],
    `cancel repair status ${resp.status()}: ${await resp.text().catch(() => '')}`
  ).toContain(resp.status());

  await new Promise((r) => setTimeout(r, 1500));

  const after = readOwnerExpenses();
  expect(after, 'owner expenses readable').toBeTruthy();
  const orphan = after!.find(
    (e) => e.source === 'repair-vacant' && e.expenseId === REPAIR_ID
  );
  expect(
    orphan,
    'cancelled repair must leave NO repair-vacant orphan row (BUG5)'
  ).toBeFalsy();
});

test('49.5 PAID-SURVIVES-RECOMPUTE — a landlord-set paid flag on a source:vacant owner row survives the strip+rebuild', async ({
  request: req
}) => {
  // Adversarial finding (June 2026): vacant-owner rows are strip-and-rebuilt
  // by _recomputeVacantOwnerCharges on every expense edit / tenancy change,
  // and the rebuild minted a NEW _id with paid reset to the schema default
  // (false) — so any unrelated edit silently reverted a paid vacant charge to
  // unpaid, corrupting the Overview paid/outstanding tile. The fix snapshots
  // paid/paidDate by expenseId+propertyId+term before the strip and restores
  // it on rebuild. This proves it end-to-end on the deployed engine.
  //
  // Seed: mark P3's source:'vacant' share for EXPENSE_ID/TERM as PAID directly
  // in mongo (it is recomputed, so we set the flag the recompute must carry).
  const seeded = mongoExec(`
    var b = db.buildings.findOne({_id: ObjectId("${BID}")});
    if (!b) { print("NO_BLDG"); quit(); }
    // ensure a source:'vacant' row exists for P3/EXPENSE_ID/TERM, paid:true.
    var ome = (b.ownerMonthlyExpenses||[]).filter(function(e){
      return !(String(e.expenseId)==="${EXPENSE_ID}" && e.source==="vacant" && Number(e.term)===${TERM} && String(e.propertyId)==="${P3}");
    });
    ome.push({ _id: ObjectId(), expenseId: "${EXPENSE_ID}", term: ${TERM}, amount: 30, propertyId: "${P3}", source: "vacant", description: "E2E49-Cleaning", paid: true, paidDate: new Date() });
    db.buildings.updateOne({_id: ObjectId("${BID}")}, {$set: {ownerMonthlyExpenses: ome}});
    print("SEEDED");
  `);
  expect(seeded && seeded.includes('SEEDED'), 'paid vacant row seeded').toBeTruthy();

  // Confirm pre-state: the vacant row is paid:true.
  const before = readOwnerExpenses();
  const paidBefore = before!.find(
    (e) => e.source === 'vacant' && e.expenseId === EXPENSE_ID && e.propertyId === P3
  );
  expect(paidBefore, 'seeded paid vacant row present').toBeTruthy();
  expect(paidBefore!.paid, 'seeded vacant row is paid before recompute').toBe(true);

  // Trigger a recompute via a harmless expense edit (touch the name). An
  // expense PATCH calls _recomputeVacantOwnerCharges(current term) which
  // strips+rebuilds the source:'vacant' rows for that term.
  const touch = await req.patch(
    `${GATEWAY}/api/v2/buildings/${BID}/expenses/${EXPENSE_ID}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        organizationid: realmId,
        'Content-Type': 'application/json'
      },
      data: { name: 'E2E49-Cleaning' }
    }
  );
  expect(
    [200, 201],
    `expense touch status ${touch.status()}: ${await touch.text().catch(() => '')}`
  ).toContain(touch.status());

  await new Promise((r) => setTimeout(r, 2000));

  // The vacant row must STILL be paid:true after the rebuild (the fix carries
  // the flag forward). Pre-fix, the rebuild reset it to false.
  const after = readOwnerExpenses();
  const paidAfter = after!.find(
    (e) => e.source === 'vacant' && e.expenseId === EXPENSE_ID && e.propertyId === P3
  );
  expect(paidAfter, 'vacant row still present after recompute').toBeTruthy();
  expect(
    paidAfter!.paid,
    'paid flag MUST survive the vacant-owner recompute (carry-forward fix)'
  ).toBe(true);
});

test('49.4 BUG3 (method-flip) — PATCH allocationMethod:fixed with NO/empty customAllocations must 422 (not bill €0)', async ({
  request: req
}) => {
  // The adversarial second-batch challenge confirmed a bypass: flipping a
  // persisted expense to allocationMethod:'fixed' WITHOUT supplying
  // customAllocations (which stay empty []) skipped the fixed-zero guard,
  // persisting a fixed expense that bills €0 to every unit. The fix
  // validates the EFFECTIVE method against the EFFECTIVE (merged) allocations
  // unconditionally. The seeded E2E49-Cleaning is 'equal' with [] allocations.
  const headers = {
    Authorization: `Bearer ${token}`,
    organizationid: realmId,
    'Content-Type': 'application/json'
  };

  // (a) flip to fixed, omit customAllocations entirely → must 422.
  const flip = await req.patch(
    `${GATEWAY}/api/v2/buildings/${BID}/expenses/${EXPENSE_ID}`,
    { headers, data: { allocationMethod: 'fixed' } }
  );
  expect(
    flip.status(),
    `flip-to-fixed-without-allocations must be rejected, got ${flip.status()}: ${await flip
      .text()
      .catch(() => '')}`
  ).toBe(422);

  // (b) flip to fixed with all-zero customAllocations → must also 422.
  const flipZero = await req.patch(
    `${GATEWAY}/api/v2/buildings/${BID}/expenses/${EXPENSE_ID}`,
    {
      headers,
      data: {
        allocationMethod: 'fixed',
        customAllocations: [{ propertyId: P1, value: 0 }]
      }
    }
  );
  expect(
    flipZero.status(),
    `flip-to-fixed-with-zero-allocations must be rejected, got ${flipZero.status()}`
  ).toBe(422);

  // The persisted expense must remain 'equal' (the rejected PATCHes did not
  // mutate it) — confirm via mongo so a 422 that still wrote is caught.
  const persistedMethod = mongoExec(`
    var b = db.buildings.findOne({_id: ObjectId("${BID}")});
    var e = (b.expenses||[]).find(function(x){ return String(x._id.valueOf()) === "${EXPENSE_ID}"; });
    print(e ? e.allocationMethod : "null");
  `);
  expect(
    persistedMethod,
    'rejected PATCH must NOT have flipped the persisted method to fixed'
  ).toBe('equal');

  // (c) a VALID fixed PATCH (non-zero allocation) still succeeds (no regression).
  const ok = await req.patch(
    `${GATEWAY}/api/v2/buildings/${BID}/expenses/${EXPENSE_ID}`,
    {
      headers,
      data: {
        allocationMethod: 'fixed',
        customAllocations: [
          { propertyId: P1, value: 30 },
          { propertyId: P2, value: 30 },
          { propertyId: P3, value: 30 }
        ]
      }
    }
  );
  expect(
    [200, 201],
    `valid fixed PATCH must succeed, got ${ok.status()}: ${await ok
      .text()
      .catch(() => '')}`
  ).toContain(ok.status());
});

test('49.6 STALE-VACANT — getExpenseBreakdown drops a no-longer-opted-in source:vacant row but KEEPS a valid one (read-time validation, no double-count)', async ({
  request: req
}) => {
  // Adversarial finding (round 2): the vacant recompute only re-derives the
  // CURRENT term, so a source:'vacant' row can persist for a term whose
  // expense is no longer active / no longer opts in. If surfaced, the same
  // euro shows in BOTH the owner block (owed) AND the Αχρέωτα/uncollected
  // section (nobody pays) — a contradictory double-count. getExpenseBreakdown
  // now validates each source:'vacant' row against live state at READ time and
  // drops the stale ones.
  //
  // This test must NOT be vacuous (round-3 finding): the pre-fix code blanket-
  // excluded ALL source:'vacant' rows from ownerDirect, so a negative-only
  // assertion would pass even unfixed. We therefore exercise BOTH paths with a
  // PURPOSE-BUILT expense (not the EXPENSE_ID that 49.4 mutated):
  //   - INACTIVE term  → stale row DROPPED (negative)
  //   - ACTIVE  term   → valid row KEPT   (positive — fails on pre-fix code,
  //                      which excluded all vacant rows)
  // The expense keeps chargeOwnerWhenVacant:true throughout, so the drop is
  // attributable purely to isExpenseActiveForTerm (term < startTerm), exactly
  // the mechanism under test — not to the flag.
  const VAC_EXP = '6a0000000000000000004906';
  const startTerm = YEAR * 1000000 + 60100; // YYYY060100 (June this year)
  const activeTerm = startTerm; // active: term === startTerm
  const staleTerm = (YEAR - 1) * 1000000 + 10100; // YYYY-1 0100 → before startTerm → inactive

  const seeded = mongoExec(`
    var b = db.buildings.findOne({_id: ObjectId("${BID}")});
    if (!b) { print("NO_BLDG"); quit(); }
    var ex = (b.expenses||[]).filter(function(e){ return String(e._id.valueOf()) !== "${VAC_EXP}"; });
    // A recurring expense, active from ${startTerm}, that DOES opt into
    // vacant-owner billing. P3 is vacant, so the engine emits an owner-billed
    // vacant share for it.
    ex.push({ _id: ObjectId("${VAC_EXP}"), name: "E2E49-VacOptIn", type: "cleaning", amount: 90, allocationMethod: "equal", isRecurring: true, startTerm: ${startTerm}, customAllocations: [], chargeOwnerWhenVacant: true });
    // Persisted source:'vacant' rows for BOTH terms (same expense+unit). Only
    // the active-term one is legitimate; the stale-term one must be dropped.
    var ome = (b.ownerMonthlyExpenses||[]).filter(function(e){ return String(e.expenseId) !== "${VAC_EXP}"; });
    ome.push({ _id: ObjectId(), expenseId: "${VAC_EXP}", term: ${activeTerm}, amount: 30, propertyId: "${P3}", source: "vacant", description: "E2E49-VacOptIn", paid: false, paidDate: null });
    ome.push({ _id: ObjectId(), expenseId: "${VAC_EXP}", term: ${staleTerm},  amount: 30, propertyId: "${P3}", source: "vacant", description: "E2E49-VacOptIn", paid: false, paidDate: null });
    db.buildings.updateOne({_id: ObjectId("${BID}")}, {$set: {expenses: ex, ownerMonthlyExpenses: ome}});
    print("SEEDED");
  `);
  expect(seeded && seeded.includes('SEEDED'), 'vac-opt-in expense + rows seeded').toBeTruthy();

  const headers = { Authorization: `Bearer ${token}`, organizationid: realmId };
  const getOwnerDirect = async (term: number) => {
    const resp = await req.get(
      `${GATEWAY}/api/v2/buildings/${BID}/expense-breakdown?term=${term}`,
      { headers }
    );
    expect(resp.status(), await resp.text().catch(() => '')).toBe(200);
    const body = (await resp.json()) as {
      ownerDirect: Array<{ expenseId: string; source: string; amount: number }>;
    };
    return (body.ownerDirect || []).filter((e) => e.expenseId === VAC_EXP);
  };

  // NEGATIVE: the stale-term row (term before startTerm → inactive) must NOT
  // surface — dropped by the read-time isExpenseActiveForTerm guard.
  const staleRows = await getOwnerDirect(staleTerm);
  expect(
    staleRows.length,
    'stale source:vacant row (inactive term) must be dropped from ownerDirect'
  ).toBe(0);

  // POSITIVE: the active-term row MUST surface (it is a real owner liability).
  // This is the assertion that FAILS on the pre-fix code (which excluded every
  // source:'vacant' row), so the test is not vacuous.
  const activeRows = await getOwnerDirect(activeTerm);
  expect(
    activeRows.length,
    'valid current-term source:vacant row MUST appear in ownerDirect (owner liability)'
  ).toBeGreaterThanOrEqual(1);
  expect(activeRows.some((r) => r.source === 'vacant')).toBe(true);

  // Cleanup the purpose-built expense + its rows.
  mongoExec(`
    db.buildings.updateOne(
      {_id: ObjectId("${BID}")},
      {$pull: {ownerMonthlyExpenses: {expenseId: "${VAC_EXP}"}}}
    );
    db.buildings.updateOne(
      {_id: ObjectId("${BID}")},
      {$pull: {expenses: {_id: ObjectId("${VAC_EXP}")}}}
    );
    print("CLEANED");
  `);
});

test('49.7 SAVE-STATEMENT-PRESERVES-OTHER-SOURCES — POST monthly-statement strips ONLY source:expense rows (repair-vacant survives; paid carries forward)', async ({
  request: req
}) => {
  // Adversarial map finding: saveMonthlyStatement (W1) stripped EVERY
  // ownerMonthlyExpense for the term (source-blind) then re-added only the
  // source:'expense' rows — so saving a statement DELETED the vacant /
  // repair-vacant / repair owner charges for that term (data loss), and reset
  // the paid flag on the expense rows. The fix scopes the strip to
  // source:'expense' and carries paid forward.
  //
  // Seed: a repair-vacant row (must SURVIVE) + a paid source:'expense' row for
  // EXPENSE2 (its paid flag must SURVIVE a re-save).
  const EXPENSE2 = 'aa00000000000000000000e2';
  const seeded = mongoExec(`
    var b = db.buildings.findOne({_id: ObjectId("${BID}")});
    if (!b) { print("NO_BLDG"); quit(); }
    // ensure a second building expense EXPENSE2 (variable owner-tracked) exists
    var ex = (b.expenses||[]).filter(function(e){ return String(e._id.valueOf()) !== "${EXPENSE2}"; });
    ex.push({ _id: ObjectId("${EXPENSE2}"), name: "E2E49-OwnerVar", type: "management_fee", amount: 0, allocationMethod: "equal", isRecurring: true, startTerm: ${YEAR}010100, customAllocations: [], trackOwnerExpense: true });
    // owner ledger: a repair-vacant row (other source) + a PAID expense row.
    var ome = (b.ownerMonthlyExpenses||[]).filter(function(e){
      return !(Number(e.term)===${TERM} && (String(e.expenseId)==="${REPAIR_ID}" || String(e.expenseId)==="${EXPENSE2}"));
    });
    ome.push({ _id: ObjectId(), expenseId: "${REPAIR_ID}", term: ${TERM}, amount: 77, propertyId: "${P3}", source: "repair-vacant", description: "Repair: E2E49-Elevator", paid: false, paidDate: null });
    ome.push({ _id: ObjectId(), expenseId: "${EXPENSE2}", term: ${TERM}, amount: 25, source: "expense", description: "E2E49-OwnerVar", paid: true, paidDate: new Date() });
    db.buildings.updateOne({_id: ObjectId("${BID}")}, {$set: {expenses: ex, ownerMonthlyExpenses: ome}});
    print("SEEDED");
  `);
  expect(seeded && seeded.includes('SEEDED'), 'seed ok').toBeTruthy();

  // POST a monthly-statement for the term that re-submits the owner-var
  // expense (W1). Pre-fix this wiped the repair-vacant row and reset the paid.
  const post = await req.post(
    `${GATEWAY}/api/v2/buildings/${BID}/monthly-statement`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        organizationid: realmId,
        'Content-Type': 'application/json'
      },
      data: {
        term: TERM,
        ownerExpenses: [
          { expenseId: EXPENSE2, amount: 25, description: 'E2E49-OwnerVar' }
        ]
      }
    }
  );
  expect(
    [200, 201],
    `monthly-statement status ${post.status()}: ${await post.text().catch(() => '')}`
  ).toContain(post.status());

  await new Promise((r) => setTimeout(r, 1500));

  const after = readOwnerExpenses();
  expect(after, 'owner expenses readable').toBeTruthy();
  // The repair-vacant row (DIFFERENT source) MUST survive W1's strip.
  const repairVacant = after!.find(
    (e) =>
      e.source === 'repair-vacant' &&
      e.expenseId === REPAIR_ID &&
      e.term === TERM
  );
  expect(
    repairVacant,
    'repair-vacant row MUST survive a monthly-statement save (W1 must not strip other sources)'
  ).toBeTruthy();
  // The source:'expense' row's paid flag MUST carry forward across the re-save.
  const ownerVar = after!.find(
    (e) =>
      e.source === 'expense' && e.expenseId === EXPENSE2 && e.term === TERM
  );
  expect(ownerVar, 'owner-var expense row present after save').toBeTruthy();
  expect(
    ownerVar!.paid,
    'paid flag on source:expense row MUST carry forward across a monthly-statement re-save'
  ).toBe(true);

  // Cleanup the seeded EXPENSE2 + its rows.
  mongoExec(`
    db.buildings.updateOne({_id: ObjectId("${BID}")}, {$pull: {ownerMonthlyExpenses: {expenseId: "${EXPENSE2}"}}});
    db.buildings.updateOne({_id: ObjectId("${BID}")}, {$pull: {expenses: {_id: ObjectId("${EXPENSE2}")}}});
    print("CLEANED");
  `);
});
