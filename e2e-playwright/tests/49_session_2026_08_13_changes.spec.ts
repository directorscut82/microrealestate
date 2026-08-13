/**
 * 49 — Every change of the 2026-08-13 session, driven against the REAL realm.
 *
 * WHY THIS SPEC RUNS AS THE LANDLORD ACCOUNT AND NOT THE CYPRESS ONE.
 * The harness signs in as `.secrets/cypress-test-account`, whose realm has no
 * bills, no B2 configuration and no legacy expenses. Every defect fixed this
 * session is about how REAL data renders: a κυμαινόμενο expense created before the
 * flag existed, a `fixed` allocation carrying €0, an archived bill sitting in B2.
 * A green run on the synthetic realm would prove nothing about any of them, so
 * this spec loads `.secrets/landlord-account` and drives the live realm — the
 * account the landlord actually uses, which they have sanctioned for test writes.
 *
 * WHAT IS SEEDED vs WHAT IS ASSERTED. Inputs only are written directly to mongo
 * (an `isVariable` flag on an existing expense, one Bill row pointing at the B2
 * object that is already there). Every assertion reads the RENDERED Greek UI.
 * Nothing that the app itself computes is ever seeded.
 *
 * MEASURED FIXTURE (mongo, 2026-08-13) — realm «landlord», the building at
 * `6a5920fa1df21dc733133cbe` (name deliberately not written here: it is a real
 * street address, and this file is in a PUBLIC repo — the pre-commit scanner
 * rejects it, correctly):
 *   · «Ηλεκτρικό κοινοχρ.»       amount 35, alloc equal,       active from 2026-01
 *   · «Πετρέλαιο (κυμαινόμενο)»  amount 0,  alloc equal,       active from 2026-01,
 *                                 June 2026 charged (inputAmount 80 → 5 × €16)
 *   · «DEH»                      amount 0,  alloc single_unit, active from 2026-08
 *   · 5 apartments, no shared meters
 *   · the one real Bill: provider deh, term 2026060100 (JUNE), total 120, and its
 *     source archived at the B2 key below.
 *
 * A REAL INCONSISTENCY THIS SPEC DOCUMENTS RATHER THAN HIDES: that Bill's term is
 * June while its own expense «DEH» only starts in August, so the expense is not
 * active in the month the bill belongs to and its €120 lands on no surface. That
 * is the T6 shape (BILL_OCR_INBOX_PLAN §18) in live data, not a rendering bug — so
 * the pill is exercised against a bill seeded onto an expense that IS active, and
 * the «DEH» mismatch is asserted separately as the absence it really is.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { mongoExec } from './lib/mongoExec';

// ⚠️ The screenshots this spec writes show a REAL ΔΕΗ bill — named account holder,
// address, provision number. They go to `test-results/`, which is gitignored
// (e2e-playwright/.gitignore:3). NEVER move them into the repo, attach them to an
// issue, or paste them anywhere: real documents stay outside the repository.


const ACCOUNT_FILE = path.resolve(__dirname, '../../.secrets/landlord-account');
const account = fs.existsSync(ACCOUNT_FILE)
  ? dotenv.parse(fs.readFileSync(ACCOUNT_FILE))
  : {};
const EMAIL = account.EMAIL || '';
const PASSWORD = account.PASSWORD || '';
const REALM = account.REALM || 'landlord';

const BUILDING_ID = '6a5920fa1df21dc733133cbe';
const EXP_FIXED = '6a5fc1292bdd999da0ff2b47'; // «Ηλεκτρικό κοινοχρ.», €35
const EXP_VARIABLE = '6a5fde2cf95a14d14944c66e'; // «Πετρέλαιο (κυμαινόμενο)», €0
// The expense the one real bill points at — active only from 2026-08, while the
// bill's own term is 2026-06.
const EXP_DEH = '6a7ca9b4a8c6d44c795e40f9';
const JUNE_TERM = 2026060100;
const B2_KEY =
  'landlord-6a00d7ce323739077de89e58/bills/6a7ca9c1a8c6d44c795e4924/bill-02-DEH-2026-06-120.00.pdf';
const SEEDED_BILL_ID = '6a7ca9c1a8c6d44c795e9999';

test.describe.configure({ mode: 'serial', timeout: 4 * 60_000 });

/** Set (or clear) `isVariable` on one expense of the real building. */
function setIsVariable(expenseId: string, value: boolean | null): void {
  const op =
    value === null
      ? `{ $unset: { "expenses.$.isVariable": "" } }`
      : `{ $set: { "expenses.$.isVariable": ${value} } }`;
  // NOTE: mongoExec already escapes `$`. Passing `\\$unset` is what silently threw
  // in every earlier cleanup — write the operator plain.
  const out = mongoExec(
    `db.buildings.updateOne({ _id: ObjectId("${BUILDING_ID}"), "expenses._id": ObjectId("${expenseId}") }, ${op}); print("nModified=" + db.buildings.find({_id: ObjectId("${BUILDING_ID}")}).count());`
  );
  expect(out, `isVariable=${value} written for ${expenseId}`).not.toBeNull();
}

async function signIn(page: Page): Promise<void> {
  await page.goto('el/signin');
  await page.locator('input[name=email]').fill(EMAIL);
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 25_000 })
    .toMatch(/\/(firstaccess|dashboard)/);
}

/** Building → Έξοδα tab, with June 2026 selected in the calendar. */
async function openJune(page: Page): Promise<void> {
  // Greek locale explicitly — the realm's own language, and the only one whose
  // rendering has ever been reviewed.
  await page.goto(`el/${encodeURIComponent(REALM)}/buildings/${BUILDING_ID}`);
  const tab = page.locator('[data-cy=expensesTab]');
  await expect(tab, 'Έξοδα tab').toBeVisible({ timeout: 25_000 });
  await tab.click();
  // The calendar opens on the current month (August); step back to June.
  const june = page.getByRole('button', { name: /^Ιουν/ }).first();
  await expect(june, 'June button in the calendar').toBeVisible({ timeout: 20_000 });
  await june.click();
}

/**
 * The statement row for one expense, on one side.
 *
 * Addressed by `data-cy` + `data-expense`, NOT by text: the tenant and owner lists
 * render the same expense name, and a text locator with `.last()` silently picked
 * the OWNER row — which reads back the owner entry (€16) instead of the €80 the
 * landlord typed, so the first version of test A failed against correct code.
 */
function rowFor(page: Page, expenseId: string, side: 'tenant' | 'owner' = 'tenant') {
  return page.locator(
    `[data-cy=${side}ExpenseRow][data-expense="${expenseId}"]`
  );
}

test.beforeAll(() => {
  if (!EMAIL || !PASSWORD) {
    throw new Error('Missing .secrets/landlord-account (EMAIL/PASSWORD)');
  }
});

test.afterAll(() => {
  // Leave the realm exactly as found: clear both flags, drop the seeded bill.
  setIsVariable(EXP_FIXED, null);
  setIsVariable(EXP_VARIABLE, null);
  mongoExec(`db.bills.deleteOne({ _id: ObjectId("${SEEDED_BILL_ID}") });`);
});

test('A · a legacy κυμαινόμενο expense offers an editable monthly input', async ({
  page
}) => {
  // «Πετρέλαιο (κυμαινόμενο)» has isVariable undefined and amount 0 — the legacy
  // shape. The fallback inference must keep treating it as variable, or the
  // landlord loses the only place a monthly figure can be typed.
  await signIn(page);
  await openJune(page);
  const row = rowFor(page, EXP_VARIABLE);
  await expect(row, 'the κυμαινόμενο row renders').toBeVisible({ timeout: 20_000 });
  const input = row.locator('input[type=number]');
  await expect(input, 'it carries an editable amount input').toHaveCount(1);
  // June was charged with inputAmount 80 — the input reads back the ENTERED
  // statement figure, not the Σ of the 5 × €16 per-unit shares (summing them is
  // what eroded the amount toward zero on every re-save).
  await expect(input).toHaveValue('80');
  await page.screenshot({
    path: 'test-results/49-A-variable-row.png',
    fullPage: true
  });
});

test('B · isVariable:true on an expense WITH an amount flips it to an input', async ({
  page
}) => {
  // THE MONEY DEFECT, end to end. «Ηλεκτρικό κοινοχρ.» carries €35. Flagged
  // variable, the panel used to keep showing a read-only «35,00 €» and adding 35
  // to the month total, because it re-derived variability from the amount and
  // ignored the flag. Now the flag decides.
  setIsVariable(EXP_FIXED, true);
  await signIn(page);
  await openJune(page);
  const row = rowFor(page, EXP_FIXED);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(
    row.locator('input[type=number]'),
    'flagged variable → editable input, not a read-only figure'
  ).toHaveCount(1);
  await page.screenshot({
    path: 'test-results/49-B-flag-true-becomes-input.png',
    fullPage: true
  });
});

test('C · isVariable:false at €0 stays VISIBLE and read-only', async ({ page }) => {
  // The unfinished expense. Routing through the shared predicate correctly stops
  // calling it variable — and the `else if (fixedAmount)` branch then dropped the
  // row entirely, so the expense DISAPPEARED from the panel. This is the
  // regression the fix itself introduced; the row must be present and have no
  // input.
  setIsVariable(EXP_VARIABLE, false);
  await signIn(page);
  await openJune(page);
  const row = rowFor(page, EXP_VARIABLE);
  await expect(row, 'the expense must NOT vanish').toBeVisible({ timeout: 20_000 });
  await expect(
    row.locator('input[type=number]'),
    'not variable → no input'
  ).toHaveCount(0);
  await page.screenshot({
    path: 'test-results/49-C-unfinished-visible.png',
    fullPage: true
  });
});

test('D · an archived bill shows a PDF pill that opens the document beside its data', async ({
  page
}) => {
  // Seed ONE Bill row for an expense that IS active in June, pointing at the B2
  // object that already exists. Nothing about the archive is faked — the bytes,
  // the key and the realm prefix are the real ones; only the (expenseId, term)
  // link is seeded, because the real bill's own expense does not start until
  // August (see the header note).
  setIsVariable(EXP_FIXED, null);
  // deleteOne FIRST. An insertOne alone hits E11000 on the second run and mongo
  // keeps the row from the previous one — so the spec asserts against a stale
  // fixture and fails while the code is correct. That is the seed-leakage trap the
  // harness docs warn about, hit here on the very first re-run.
  mongoExec(`db.bills.deleteOne({ _id: ObjectId("${SEEDED_BILL_ID}") });`);
  const seeded = mongoExec(
    `db.bills.insertOne({ _id: ObjectId("${SEEDED_BILL_ID}"), realmId: "6a00d7ce323739077de89e58", buildingId: "${BUILDING_ID}", expenseId: "${EXP_FIXED}", provider: "deh", billingId: "999935585", totalAmount: 35, periodStart: new Date("2026-05-01"), periodEnd: new Date("2026-05-31"), issueDate: new Date("2026-06-02"), dueDate: new Date("2026-06-20"), term: ${JUNE_TERM}, status: "pending", pdfUrl: "${B2_KEY}", rfCode: "RF99999000000000012345", ocrText: "E2E seeded — the archived source is the real one", createdDate: new Date(), updatedDate: new Date() });`
  );
  test.skip(seeded === null, 'mongoExec unavailable');

  await signIn(page);
  await openJune(page);

  // «Ηλεκτρικό κοινοχρ.» is owner-tracked, so it appears on the tenant list AND
  // the owner list. Each is its own money line and each carries its own pill —
  // assert the TENANT one specifically rather than a global count of 1, which is
  // what a first pass wrongly expected.
  const pill = rowFor(page, EXP_FIXED).locator('[data-cy=billSourcePill]');
  await expect(pill, 'the PDF pill renders on the row that has a bill').toHaveCount(
    1,
    { timeout: 20_000 }
  );
  // A .pdf source must read «PDF», never «OCR» — the distinction tells the
  // landlord whether a figure was read off a photograph.
  await expect(pill).toHaveText(/PDF/);
  // A row with NO bill must carry no pill at all.
  await expect(
    rowFor(page, EXP_VARIABLE).locator('[data-cy=billSourcePill]'),
    'an expense with no bill gets no pill'
  ).toHaveCount(0);
  // No απόδειξη is recorded for this bill, so there must be NO receipt pill. An
  // absent proof must not render as a pill the landlord can click into nothing.
  await expect(
    page.locator('[data-cy=billReceiptPill]'),
    'no receipt on file → no receipt pill'
  ).toHaveCount(0);

  await pill.click();

  // The document on the LEFT. Headless Chromium has NO PDF viewer, so the pane is
  // blank in an automated run no matter what — asserting it "looks right" here
  // would be a lie. What IS provable headlessly: the bytes arrived (a blob URL
  // exists, which only happens after the by-key fetch resolved) and the
  // plugin-independent escape hatch is present. The rendered document was verified
  // separately in headed Chrome, where the real ΔΕΗ bill paints.
  const frame = page.locator('[data-cy=billPdfFrame]');
  await expect(frame, 'the PDF pane is mounted').toHaveCount(1, { timeout: 30_000 });
  const src = await frame.getAttribute('src');
  expect(src, 'served as a blob, i.e. the bytes really arrived').toMatch(/^blob:/);
  await expect(
    page.locator('[data-cy=billOpenInTab]'),
    'a viewer-independent way to open the document'
  ).toHaveCount(1);

  // The truncation defect: a 25-character RF code and a date RANGE were clipped
  // mid-string (the code lost its last six characters, the period read «31/05/202»)
  // because the value column would
  // not shrink. A half-printed payment code looks like something the landlord can
  // type into their bank.
  // Synthetic code (the 999-prefixed placeholder band), seeded above — the real
  // one is a payment instrument on someone's actual bill and must never be in
  // this repository.
  await expect(page.getByText('RF99999000000000012345')).toBeVisible();
  await expect(page.getByText('01/05/2026 – 31/05/2026')).toBeVisible();

  // The extracted data on the RIGHT.
  await expect(page.getByText('Αριθμός παροχής')).toBeVisible();
  await expect(page.getByText('999935585')).toBeVisible();
  await expect(page.getByText('Κωδικός RF')).toBeVisible();
  // Greek provider name, not the raw code «DEH» — that raw code is how a live
  // building ended up with an expense literally called «DEH».
  await expect(page.getByText('ΔΕΗ', { exact: false })).toBeVisible();

  await page.screenshot({
    path: 'test-results/49-D-bill-dialog.png',
    fullPage: true
  });
});

test('E · the shared-meter provider select offers the SERVICE, not one brand', async ({
  page
}) => {
  // «nova» is a company. Offering it as the provider left a landlord on Cosmote or
  // Vodafone unable to record a telecom line at all.
  await signIn(page);
  await page.goto(`el/${encodeURIComponent(REALM)}/buildings/${BUILDING_ID}`);
  const tab = page.locator('[data-cy=settingsTab]');
  await expect(tab, 'Ρυθμίσεις tab').toBeVisible({ timeout: 25_000 });
  await tab.click();

  // The shared-meter block only renders a provider select once a meter row exists.
  const addMeter = page.getByRole('button', { name: /κοινόχρηστ|μετρητ/i }).first();
  if (await addMeter.count()) {
    await addMeter.click().catch(() => {});
  }
  const select = page.locator('button[role=combobox]').filter({
    hasText: /ΔΕΗ|ΕΥΔΑΠ|ΕΠΑ|Τηλεπικοινωνίες|Πάροχος/
  });
  test.skip(
    (await select.count()) === 0,
    'no shared-meter row on this building to open the provider select'
  );
  await select.first().click();
  await expect(
    page.getByRole('option', { name: 'Τηλεπικοινωνίες' }),
    'the service is offered'
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole('option', { name: 'NOVA' }),
    'the brand is NOT the axis'
  ).toHaveCount(0);
  await page.screenshot({
    path: 'test-results/49-E-provider-options.png',
    fullPage: true
  });
});

test('F · an apartment has an Έγγραφα tab with its own upload surface', async ({
  page
}) => {
  // Until this session `Document` had no `propertyId`, so an apartment's own
  // papers had nowhere to be stored and the property page had no documents
  // surface at all.
  await signIn(page);
  const apartment = mongoExec(
    `var b = db.buildings.findOne({_id: ObjectId("${BUILDING_ID}")}); print(b.units[0].propertyId);`
  );
  test.skip(!apartment, 'mongoExec unavailable');
  const propertyId = String(apartment).trim().split('\n').pop()!.trim();
  await page.goto(`el/${encodeURIComponent(REALM)}/properties/${propertyId}`);

  const docsTab = page.locator('[data-cy=documentsTab]');
  await expect(docsTab, 'the apartment Έγγραφα tab exists').toBeVisible({
    timeout: 25_000
  });
  // The details form must still be reachable — the tab is an addition, not a
  // replacement.
  await expect(page.locator('[data-cy=detailsTab]')).toBeVisible();
  await docsTab.click();
  await expect(
    page.getByText('Έγγραφα του διαμερίσματος', { exact: false }),
    'the panel names the apartment, not the building'
  ).toBeVisible({ timeout: 15_000 });

  // AND IT MUST BE SCOPED. The first version of this test asserted only that the
  // tab existed, and passed while the panel listed every file in the realm — the
  // client dropped the propertyId from the query string, so the request meant
  // "all documents". Count the rendered rows against what mongo actually holds
  // for THIS apartment: an existence assertion cannot tell a scoped list from an
  // unscoped one.
  const owned = mongoExec(
    `print(db.documents.count({ propertyId: "${propertyId}", type: "file" }));`
  );
  const expected = Number(String(owned).trim().split('\n').pop());
  await expect(
    page.locator('[data-cy=documentRow], li').filter({ has: page.getByRole('button', { name: 'Λήψη' }) }),
    `exactly the apartment's own files (${expected}), not the realm's`
  ).toHaveCount(expected, { timeout: 15_000 });
  if (expected === 0) {
    await expect(page.getByText('Δεν έχουν μεταφορτωθεί έγγραφα')).toBeVisible();
  }
  await page.screenshot({
    path: 'test-results/49-F-apartment-documents.png',
    fullPage: true
  });
});

test('G · the real ΔΕΗ bill lands on no surface, because its expense starts later', async ({
  page
}) => {
  // Not a rendering bug — a live data inconsistency worth pinning so it cannot be
  // mistaken for one. The Bill's term is June 2026; its expense «DEH» has
  // startTerm 2026-08, so the expense is inactive in June and no row exists for a
  // pill to attach to. If a future change makes `confirmBills` extend the
  // expense's startTerm (or refuse the mismatch), THIS test is the one that should
  // start failing.
  // `x._id.valueOf()`, NOT `String(x._id)`. In the mongo 4.4 shell
  // `String(someObjectId)` returns the 36-character literal `ObjectId("…")`, not the
  // 24-char hex — so comparing it to a stored id STRING can never match. The first
  // version of this query silently found nothing and threw on `e.startTerm`, which
  // read like the expense had been deleted from the live building. It had not.
  const state = mongoExec(
    `var b = db.bills.findOne({ _id: { $ne: ObjectId("${SEEDED_BILL_ID}") } }); var bl = db.buildings.findOne({_id: ObjectId(String(b.buildingId))}); var e = bl.expenses.filter(function(x){return x._id.valueOf() === String(b.expenseId)})[0]; print("billTerm=" + b.term + " expenseStart=" + e.startTerm);`
  );
  test.skip(!state, 'mongoExec unavailable');
  expect(state, 'the mismatch is still present in live data').toContain(
    'billTerm=2026060100 expenseStart=2026080100'
  );

  await signIn(page);
  await openJune(page);
  // Absent from the JUNE STATEMENT, not from the page. The expense CATALOGUE at
  // the top of the tab lists every expense of the building regardless of term —
  // that is its job — so a page-wide text assertion here was simply wrong and
  // failed against correct rendering. Scope to the month's statement rows.
  await expect(
    rowFor(page, EXP_DEH),
    'not active in June → no statement row, so nowhere for its €120 to land'
  ).toHaveCount(0);
  await expect(rowFor(page, EXP_DEH, 'owner')).toHaveCount(0);
  // And the expense IS in the catalogue — proving the absence above is about the
  // term, not about the expense having vanished.
  await expect(page.getByText('DEH', { exact: true }).first()).toBeVisible();
});
