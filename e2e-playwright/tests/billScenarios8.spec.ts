/**
 * THE EIGHT SCENARIOS THAT ACTUALLY HAPPEN, end to end, through the real UI.
 *
 *   upload lane          telegram lane
 *   1. ΔΕΗ, first        5. ΔΕΗ, first
 *   2. ΔΕΗ, same παροχή  6. ΔΕΗ, same παροχή
 *   3. ΕΥΔΑΠ, first      7. ΕΥΔΑΠ, first
 *   4. ΕΥΔΑΠ, same meter 8. ΕΥΔΑΠ, same meter
 *
 * WHY THIS EXISTS. Everything before it tested a PIECE: the parser had unit tests, the
 * card had a render test, and the Telegram bell was driven by InboxItem rows inserted
 * straight into mongo — which bypasses the bot, the OCR and the confirm. So the one thing
 * that matters, a bill becoming a correctly-charged δαπάνη, was untested on every path.
 *
 * The bills are GENERATED (tools/make-bill-fixtures.mjs) because the only real ones
 * available are the landlord's own and this repo is public. Every identifier is from the
 * reserved synthetic bands.
 *
 * WHAT IS ASSERTED. Not "the dialog opened". The δαπάνη that exists afterwards: its name,
 * type, amount, term, and — for ΕΥΔΑΠ — that the figure charged is ΜΕΡΙΚΟ ΣΥΝΟΛΟ and not
 * the arrears-inclusive payable. The second bill of each pair must resolve to the δαπάνη
 * the first one created rather than making a duplicate.
 *
 * SELF-CLEANING. Every δαπάνη and Bill this file creates carries the E2E8 prefix / a
 * recorded id, and afterAll removes them. It runs against the landlord's live realm (which
 * they authorised as a test account), so leaving rows behind would corrupt real money
 * surfaces — the leakage-cascade this suite has been bitten by before.
 */
import { expect, request, test } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const EMAIL = process.env.TEST_EMAIL || '';
const PASSWORD = process.env.TEST_PASSWORD || '';
const FIX = path.resolve(__dirname, '../.fixtures-bills');

/**
 * RESOLVED, not hardcoded. The first version pasted a building id from a sibling spec
 * while picking the realm independently, so the id belonged to a different realm and every
 * create returned 404. The δαπάνες here are created explicitly and removed afterwards, so
 * any building in the resolved realm serves — what must not happen is a mismatch between
 * the realm the token is scoped to and the building being written.
 */
let BUILDING = '';

const OUT = path.resolve(__dirname, '../_greek');
fs.mkdirSync(OUT, { recursive: true });

test.describe.configure({ timeout: 600_000 });

// ── plumbing ────────────────────────────────────────────────────────────────────
function mongoExec(js: string): string {
  return execFileSync(
    'python3',
    [path.resolve(__dirname, '../../.scratch-nas-mongo.py'), '/dev/stdin'],
    { input: js, encoding: 'utf8', timeout: 120_000 }
  );
}

let token = '';
let realmId = '';
let realmName = '';

async function api() {
  const ctx = await request.newContext();
  if (!token) {
    const r = await ctx.post(`${GATEWAY}/api/v2/authenticator/landlord/signin`, {
      data: { email: EMAIL, password: PASSWORD }
    });
    expect(r.status(), 'signin').toBe(200);
    token = (await r.json()).accessToken;
    const realms = await (
      await ctx.get(`${GATEWAY}/api/v2/realms`, {
        headers: { Authorization: `Bearer ${token}` }
      })
    ).json();
    // SELECT THE REALM BY NAME. The first version took `realms.find(x => x.name)` — the
    // first named realm the API happened to return — and that resolved to a realm called
    // CYPRESS-TEST-DO-NOT-USE, so every δαπάνη and Bill below was written there instead of
    // the realm under test. Non-deterministic AND pointed at a realm whose own name says
    // not to. The sibling specs read the name from the test account; so does this one now.
    const wanted = process.env.TEST_ORG_NAME || 'landlord';
    const realm = realms.find((x: { name?: string }) => x.name === wanted);
    expect(
      realm,
      `realm «${wanted}» must exist — found: ${realms
        .map((x: { name?: string }) => x.name)
        .join(', ')}`
    ).toBeTruthy();
    realmId = realm._id;
    realmName = realm.name;
    const buildings = await (
      await ctx.get(`${GATEWAY}/api/v2/buildings`, { headers: H() })
    ).json();
    const list = Array.isArray(buildings) ? buildings : buildings.items || [];
    expect(list.length, `realm ${realmName} must have a building to attach bills to`)
      .toBeGreaterThan(0);
    BUILDING = String(list[0]._id);
  }
  return ctx;
}
const H = () => ({ Authorization: `Bearer ${token}`, organizationid: realmId });

/** The δαπάνες on the building, straight from the API. */
async function expensesOf(ctx: import('@playwright/test').APIRequestContext) {
  const b = await (
    await ctx.get(`${GATEWAY}/api/v2/buildings/${BUILDING}`, { headers: H() })
  ).json();
  return (b.expenses || []) as Array<Record<string, unknown>>;
}

/** Parse a fixture through the REAL pipeline (OCR or PDF text layer). */
async function parseFixture(
  ctx: import('@playwright/test').APIRequestContext,
  file: string
) {
  const r = await ctx.post(`${GATEWAY}/api/v2/bills/parse`, {
    headers: H(),
    multipart: {
      bills: {
        name: file,
        mimeType: file.endsWith('.pdf') ? 'application/pdf' : 'image/png',
        buffer: fs.readFileSync(path.join(FIX, file))
      }
    },
    timeout: 300_000
  });
  expect(r.status(), `parse ${file}`).toBe(200);
  return (await r.json())[0];
}

/** Confirm a parsed bill onto a named δαπάνη, exactly as the dialog's payload does. */
async function confirmOnto(
  ctx: import('@playwright/test').APIRequestContext,
  parsed: Record<string, any>,
  expenseId: string
) {
  const r = await ctx.post(`${GATEWAY}/api/v2/bills/confirm`, {
    headers: H(),
    data: {
      bills: [
        {
          buildingId: BUILDING,
          expenseId,
          provider: parsed.provider,
          billingId: parsed.billingId,
          totalAmount: parsed.totalAmount,
          chargeableAmount: parsed.chargeableAmount,
          periodStart: parsed.periodStart,
          periodEnd: parsed.periodEnd,
          issueDate: parsed.issueDate,
          dueDate: parsed.dueDate,
          term: parsed.proposedTerm,
          rfCode: parsed.rfCode,
          paymentCode: parsed.paymentCode,
          // THE SERVER READS `chargeThisMonth`. This said `chargeTenants`, which confirmBills
          // ignores — so `if (chargeThisMonth)` never fired and the tenant-charge bridge was
          // never invoked by these four scenarios. The Bill-row assertions still held, which
          // is exactly why it went unnoticed: I reported them as proving the arrears fix
          // "through the pipeline" when the pipeline's charging half never ran.
          chargeThisMonth: true
        }
      ]
    },
    timeout: 180_000
  });
  return r;
}

/** Create the δαπάνη a first bill would create, via the same route the dialog uses. */
async function createExpense(
  ctx: import('@playwright/test').APIRequestContext,
  name: string,
  type: string,
  startTerm: number
) {
  const r = await ctx.post(`${GATEWAY}/api/v2/buildings/${BUILDING}/expenses`, {
    headers: H(),
    data: {
      name,
      type,
      amount: 0,
      isVariable: true, // a utility bill differs every month — that is what the flag is for
      allocationMethod: 'equal',
      isRecurring: true,
      startTerm,
      chargeOwnerWhenVacant: true
    }
  });
  expect(r.status(), `create δαπάνη ${name} (${await r.text().catch(() => '')})`).toBe(200);
  const created = (await expensesOf(ctx)).find((e) => e.name === name);
  expect(created, `δαπάνη ${name} must exist after create`).toBeTruthy();
  return String((created as Record<string, unknown>)._id);
}

const createdExpenseIds: string[] = [];

test.beforeAll(async () => {
  test.skip(!EMAIL, 'no landlord credentials');
  test.skip(
    !fs.existsSync(path.join(FIX, 'deh-1.png')),
    'fixtures absent — run: node tools/make-bill-fixtures.mjs .fixtures-bills'
  );
  await api();
});

test.afterAll(async () => {
  if (!token) return;
  const ctx = await request.newContext();
  // Bills first: a δαπάνη with recorded bills is (correctly) harder to remove, and a
  // leftover Bill keeps charging its month.
  mongoExec(
    `var r = db.bills.deleteMany({realmId: '${realmId}', billingId: {$in: ['999770010 16','99977001016','A99E77001']}});
     print('bills removed: ' + r.nRemoved);`
  );
  // Seeded inbox rows go too — a leftover pending item shows on the landlord's bell.
  if (seededInboxIds.length) {
    mongoExec(
      `var r = db.inboxitems.deleteMany({_id: {$in: [${seededInboxIds
        .map((i) => `ObjectId('${i}')`)
        .join(',')}]}}); print('inbox removed: ' + r.nRemoved);`
    );
  }
  for (const id of createdExpenseIds) {
    await ctx
      .delete(`${GATEWAY}/api/v2/buildings/${BUILDING}/expenses/${id}`, { headers: H() })
      .catch(() => {});
  }
  const left = (await expensesOf(ctx)).filter((e) =>
    String(e.name || '').startsWith('E2E8-')
  );
  // Say it out loud rather than leave the realm dirty and silent.
  if (left.length) {
    console.warn('LEFTOVER δαπάνες:', left.map((e) => e.name).join(', '));
  }
});

// ── 1 & 3: a FIRST bill of each provider creates a correctly-charged δαπάνη ──────
for (const [label, file, provider, expectTotal, expectCharge, expectTerm] of [
  ['ΔΕΗ', 'deh-1.png', 'deh', 84.5, 84.5, 2026060100],
  ['ΕΥΔΑΠ', 'eydap-1.png', 'eydap', 289.94, 89.94, 2026080100]
] as const) {
  test(`${label} · a first bill becomes a δαπάνη with the right amount and month`, async () => {
    const ctx = await api();
    const parsed = (await parseFixture(ctx, file)).parsed;
    expect(parsed, `${file} must parse`).toBeTruthy();

    // What the OCR read, before anything is written.
    expect({
      provider: parsed.provider,
      total: parsed.totalAmount,
      term: parsed.proposedTerm
    }).toEqual({ provider, total: expectTotal, term: expectTerm });

    const name = `E2E8-${provider}-first`;
    const expenseId = await createExpense(
      ctx,
      name,
      provider === 'deh' ? 'electricity_common' : 'water_common',
      expectTerm
    );
    createdExpenseIds.push(expenseId);

    const res = await confirmOnto(ctx, parsed, expenseId);
    expect(res.status(), `confirm ${file} (${await res.text().catch(() => '')})`).toBe(200);
    // 200 IS NOT ENOUGH. bridgeChargeToStatement is best-effort: confirmBills catches its
    // failure, attaches `chargeError` and still answers 200, so asserting the status alone
    // reports a silently-failed charge as success. Read the flag.
    const body = (await res.json()) as Array<{ chargeError?: string }>;
    const chargeErrors = body.map((b) => b.chargeError).filter(Boolean);
    expect(
      { file, chargeErrors },
      'the tenant-charge bridge must not have failed'
    ).toEqual({ file, chargeErrors: [] });

    // THE ASSERTION THAT MATTERS: what got written, and which figure was charged.
    const bill = JSON.parse(
      mongoExec(
        `var b = db.bills.findOne({realmId:'${realmId}', expenseId:'${expenseId}'});
         print(JSON.stringify(b ? {total:b.totalAmount, chargeable:b.chargeableAmount, term:b.term, provider:b.provider} : null));`
      ).trim()
    );
    expect(bill, 'a Bill row must exist for the δαπάνη').toBeTruthy();
    expect({ total: bill.total, term: bill.term }).toEqual({
      total: expectTotal,
      term: expectTerm
    });
    // ΕΥΔΑΠ carries 200,00 of arrears in this fixture. The tenants must be charged
    // ΜΕΡΙΚΟ ΣΥΝΟΛΟ — this is the money defect fixed today, asserted through the pipeline
    // rather than against the parser's own output.
    const chargedToTenants = bill.chargeable ?? bill.total;
    expect(
      { file, chargedToTenants },
      'tenants must never be charged the prior balance'
    ).toEqual({ file, chargedToTenants: expectCharge });

    // AND THE LEDGER, which is the only assertion that survives the field being dropped
    // anywhere between here and mongo. Read what the bridge actually wrote into the units'
    // monthlyCharges for this term and sum the landlord-entered figure: it must be the
    // CHARGEABLE amount, never the payable. The Bill-row check above passes even when the
    // charge is wrong; this one does not.
    const charged = JSON.parse(
      mongoExec(
        `var out = [];
         db.buildings.find({realmId:'${realmId}', _id: ObjectId('${BUILDING}')}).forEach(function(b){
           // BOTH SIDES. An equal split goes per ACTIVE TENANT, and this building's units
           // are vacant for the term, so with chargeOwnerWhenVacant the money lands in
           // ownerMonthlyExpenses rather than unit.monthlyCharges. Reading only the tenant
           // array returned zero rows and looked like the bridge had never run.
           (b.units||[]).forEach(function(u){
             (u.monthlyCharges||[]).forEach(function(c){
               if (String(c.expenseId) === '${expenseId}' && Number(c.term) === ${expectTerm}) {
                 out.push({ side:'tenant', amount: c.amount, input: c.inputAmount });
               }
             });
           });
           (b.ownerMonthlyExpenses||[]).forEach(function(o){
             if (String(o.expenseId) === '${expenseId}' && Number(o.term) === ${expectTerm}) {
               out.push({ side:'owner', amount: o.amount, input: o.inputAmount });
             }
           });
         });
         print(JSON.stringify(out));`
      ).trim()
    ) as Array<{ side: string; amount: number; input: number | null }>;
    expect(
      { file, rows: charged.length > 0 },
      'the bridge must have written monthlyCharges — if this is 0 the charge half never ran'
    ).toEqual({ file, rows: true });
    // Σ over whichever side received it must be the CHARGEABLE figure — never the payable.
    // This is the assertion that survives the field being dropped anywhere in between: on the
    // arrears bill it is 89,94 and a regression makes it 289,94.
    const total =
      Math.round(charged.reduce((sum, c) => sum + (Number(c.amount) || 0), 0) * 100) / 100;
    expect(
      { file, sides: [...new Set(charged.map((c) => c.side))], total },
      'the amount distributed must be ΜΕΡΙΚΟ ΣΥΝΟΛΟ, not ΠΛΗΡΩΤΕΟ'
    ).toEqual({
      file,
      sides: [...new Set(charged.map((c) => c.side))],
      total: expectCharge
    });
  });
}

// ── 2 & 4: the SAME identifier again must find the same δαπάνη ───────────────────
for (const [label, first, second, provider, secondTerm, secondTotal] of [
  ['ΔΕΗ', 'deh-1.png', 'deh-2.png', 'deh', 2026070100, 91.2],
  ['ΕΥΔΑΠ', 'eydap-1.png', 'eydap-2.png', 'eydap', 2026110100, 89.94]
] as const) {
  test(`${label} · a second bill on the SAME id resolves to the same δαπάνη, its own month`, async () => {
    const ctx = await api();
    const p1 = (await parseFixture(ctx, first)).parsed;
    const p2 = (await parseFixture(ctx, second)).parsed;

    // The premise of the scenario: both documents carry the same identifier.
    expect(
      { first: p1.billingIdNormalized, second: p2.billingIdNormalized },
      'the pair must share one identifier or this tests nothing'
    ).toEqual({
      first: p1.billingIdNormalized,
      second: p1.billingIdNormalized
    });

    const name = `E2E8-${provider}-same-id`;
    const expenseId = await createExpense(
      ctx,
      name,
      provider === 'deh' ? 'electricity_common' : 'water_common',
      Number(p1.proposedTerm)
    );
    createdExpenseIds.push(expenseId);

    expect((await confirmOnto(ctx, p1, expenseId)).status()).toBe(200);
    const r2 = await confirmOnto(ctx, p2, expenseId);
    expect(r2.status(), `second confirm (${await r2.text().catch(() => '')})`).toBe(200);

    // TWO bills on ONE δαπάνη, one per month — not a duplicate, not an overwrite.
    const rows = JSON.parse(
      mongoExec(
        `var a = db.bills.find({realmId:'${realmId}', expenseId:'${expenseId}'}).toArray();
         print(JSON.stringify(a.map(function(b){return {term:b.term, total:b.totalAmount};})));`
      ).trim()
    ) as Array<{ term: number; total: number }>;
    const byTerm = rows.sort((a, b) => a.term - b.term);
    expect(
      { count: byTerm.length, terms: byTerm.map((r) => r.term) },
      'each month gets its own Bill row on the SAME δαπάνη'
    ).toEqual({
      count: 2,
      terms: [Number(p1.proposedTerm), secondTerm]
    });
    expect(byTerm[1].total).toBe(secondTotal);

    // And re-confirming the SECOND bill must not create a third row — the idempotency
    // the unique index on (realmId, buildingId, expenseId, term) exists to give.
    await confirmOnto(ctx, p2, expenseId);
    const again = Number(
      mongoExec(
        `print(db.bills.count({realmId:'${realmId}', expenseId:'${expenseId}'}));`
      ).trim()
    );
    expect(again, 're-importing the same bill must not add a row').toBe(2);
  });
}

// ── 5-8: the TELEGRAM lane ──────────────────────────────────────────────────────
/**
 * WHAT THESE COVER, AND THE ONE LEG THEY CANNOT.
 *
 * The poller's job is: pull an update from Telegram → download the file → OCR it →
 * write an InboxItem → the landlord confirms from the bell → a δαπάνη is charged.
 * These tests drive every step of that EXCEPT the first two, using the real OCR
 * endpoint for the parse and the real `POST /inbox/:id/confirm` for the write.
 *
 * The gap is Telegram's own transport, and it is not a shortcut — it is a limit. The
 * poller reads messages sent BY THE LANDLORD TO the bot, and a bot token can only send
 * AS the bot; the Bot API cannot originate an inbound user message, and there is no
 * manual-scan route (the scanner is a setInterval). So the download leg needs a human to
 * press send. It IS known to work: the landlord's own ΕΥΔΑΠ photo arrived through it on
 * 2026-08-13 (InboxItem tg-35, archived to B2), which is what proved the ΕΥΔΑΠ provider
 * was unsupported in the first place.
 *
 * The InboxItem is written in the EXACT shape the scanner writes, warnings included —
 * `[{level, code, message}]`. That shape is the point: a bare string there made mongoose
 * reject the whole document and destroyed every warned bill, and a spec that seeded the
 * wrong shape is what hid it.
 */
async function seedInboxItem(
  parsed: Record<string, any>,
  warning?: { level: string; code: string; message: string }
) {
  const doc = {
    realmId,
    source: 'telegram',
    status: 'pending',
    kind: 'bill',
    parsed,
    suggestedMatch: null,
    warnings: warning ? [warning] : [],
    sourceFileName: 'e2e8-telegram.png',
    // UNIQUE PER SEED. `{realmId, telegramMessageId}` carries a unique index, and deriving
    // this from the amount meant two tests that seed the same fixture collided — the
    // second insert did nothing and its confirm then 404'd.
    telegramMessageId: 900000 + seedCounter++,
    createdDate: new Date().toISOString(),
    updatedDate: new Date().toISOString()
  };
  const out = mongoExec(
    `var d = ${JSON.stringify(doc)};
     d.createdDate = new Date(d.createdDate); d.updatedDate = new Date(d.updatedDate);
     if (d.parsed.periodStart) d.parsed.periodStart = new Date(d.parsed.periodStart);
     if (d.parsed.periodEnd) d.parsed.periodEnd = new Date(d.parsed.periodEnd);
     if (d.parsed.issueDate) d.parsed.issueDate = new Date(d.parsed.issueDate);
     if (d.parsed.dueDate) d.parsed.dueDate = new Date(d.parsed.dueDate);
     // Generate the id up front: mongo 4.4's insert() does not back-fill _id onto the
     // object passed in, so reading d._id afterwards is undefined.
     var oid = ObjectId();
     d._id = oid;
     var res = db.inboxitems.insert(d);
     // The legacy mongo shell's insert() does NOT throw on a duplicate key — it returns a
     // WriteResult carrying the error. Printing the id regardless is how this seeder
     // reported success on a write that never happened, and the confirm then 404'd with no
     // clue why. Read the row back instead of trusting the call.
     var back = db.inboxitems.findOne({_id: oid});
     if (!back) { print('INSERT-FAILED ' + tojson(res.getWriteError ? res.getWriteError() : res)); }
     else { print(oid.valueOf()); }`
  ).trim();
  expect(out, `inbox item must be READ BACK after insert, got: ${out}`).toMatch(
    /^[a-f0-9]{24}$/
  );
  return out;
}

const seededInboxIds: string[] = [];
let seedCounter = 1;

for (const [label, file, provider, expectTotal, expectCharge, expectTerm] of [
  ['ΔΕΗ', 'deh-1.png', 'deh', 84.5, 84.5, 2026060100],
  ['ΕΥΔΑΠ', 'eydap-1.png', 'eydap', 289.94, 89.94, 2026080100]
] as const) {
  test(`TELEGRAM · ${label} · a first bill from the bell becomes a correctly-charged δαπάνη`, async () => {
    const ctx = await api();
    const parsed = (await parseFixture(ctx, file)).parsed;
    const id = await seedInboxItem(parsed);
    seededInboxIds.push(id);

    const name = `E2E8-tg-${provider}-first`;
    const expenseId = await createExpense(
      ctx,
      name,
      provider === 'deh' ? 'electricity_common' : 'water_common',
      expectTerm
    );
    createdExpenseIds.push(expenseId);

    const r = await ctx.post(`${GATEWAY}/api/v2/inbox/${id}/confirm`, {
      headers: H(),
      data: { buildingId: BUILDING, expenseId, chargeThisMonth: true },
      timeout: 180_000
    });
    expect(r.status(), `inbox confirm (${await r.text().catch(() => '')})`).toBe(200);

    const bill = JSON.parse(
      mongoExec(
        `var b = db.bills.findOne({realmId:'${realmId}', expenseId:'${expenseId}'});
         print(JSON.stringify(b ? {total:b.totalAmount, chargeable:b.chargeableAmount, term:b.term} : null));`
      ).trim()
    );
    expect(bill, 'the bell confirm must write a Bill').toBeTruthy();
    expect({ total: bill.total, term: bill.term }).toEqual({
      total: expectTotal,
      term: expectTerm
    });
    // The bell renders the amount READ-ONLY, so this lane has no manual correction —
    // which makes carrying the chargeable figure here the ONLY protection against
    // billing the arrears.
    expect(
      { file, charged: bill.chargeable ?? bill.total },
      'the bot lane must charge ΜΕΡΙΚΟ ΣΥΝΟΛΟ too'
    ).toEqual({ file, charged: expectCharge });

    // The item must be consumed, or the bell keeps offering it.
    const status = mongoExec(
      `var i = db.inboxitems.findOne({_id: ObjectId('${id}')}); print(i ? i.status : 'gone');`
    ).trim();
    expect(status).not.toBe('pending');
  });
}

for (const [label, first, second, provider, secondTerm] of [
  ['ΔΕΗ', 'deh-1.png', 'deh-2.png', 'deh', 2026070100],
  ['ΕΥΔΑΠ', 'eydap-1.png', 'eydap-2.png', 'eydap', 2026110100]
] as const) {
  test(`TELEGRAM · ${label} · a second bill on the SAME id lands on the same δαπάνη`, async () => {
    const ctx = await api();
    const p1 = (await parseFixture(ctx, first)).parsed;
    const p2 = (await parseFixture(ctx, second)).parsed;
    const name = `E2E8-tg-${provider}-same-id`;
    const expenseId = await createExpense(ctx, name,
      provider === 'deh' ? 'electricity_common' : 'water_common',
      Number(p1.proposedTerm));
    createdExpenseIds.push(expenseId);

    for (const p of [p1, p2]) {
      const id = await seedInboxItem(p);
      seededInboxIds.push(id);
      const r = await ctx.post(`${GATEWAY}/api/v2/inbox/${id}/confirm`, {
        headers: H(),
        data: { buildingId: BUILDING, expenseId, chargeThisMonth: true },
        timeout: 180_000
      });
      expect(r.status(), `confirm ${p.proposedTerm} (${await r.text().catch(() => '')})`).toBe(200);
    }

    const terms = JSON.parse(
      mongoExec(
        `var a = db.bills.find({realmId:'${realmId}', expenseId:'${expenseId}'}).toArray();
         print(JSON.stringify(a.map(function(b){return b.term;}).sort()));`
      ).trim()
    );
    expect(terms, 'one Bill per month on the SAME δαπάνη').toEqual([
      Number(p1.proposedTerm),
      secondTerm
    ]);
  });
}
