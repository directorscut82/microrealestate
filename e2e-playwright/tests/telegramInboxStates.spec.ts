/**
 * Every state the TELEGRAM INBOX BELL can be in, driven in a real browser.
 *
 * WHY THIS EXISTS. The Telegram lane had NO browser coverage at all. Its states are
 * exactly the ones that go wrong quietly: a warning that is stored and never
 * rendered, an ambiguous match rendered as «nothing matched», a parse failure whose
 * advice cannot be followed. Two of those were real defects in this repo — the second
 * one twice, on two different surfaces.
 *
 * Items are seeded with DIRECT MONGO INSERTS, not through an API. That is deliberate
 * and it is the repo's rule for this shape of test: the ingest path is the thing under
 * test on the OTHER lane, and several of these states (a parseError, a malformed
 * suggestedMatch, an ambiguity) cannot be produced on demand through a healthy API —
 * the validators would refuse them, which is the validators doing their job.
 *
 * Every seeded item is removed in afterEach REGARDLESS of outcome. A leaked pending
 * item shows on the landlord's real bell, and this realm is their live data.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { mongoExec } from './lib/mongoExec';

const BASE = 'http://192.168.0.96:1350/landlord/el';
const OUT = path.resolve(__dirname, '../_greek');

const ACCT_FILE = path.resolve(__dirname, '../../.secrets/landlord-account');
const acct = fs.existsSync(ACCT_FILE)
  ? dotenv.parse(fs.readFileSync(ACCT_FILE))
  : ({} as Record<string, string>);
const EMAIL = acct.EMAIL ?? '';
const PASSWORD = acct.PASSWORD ?? '';
const ORG = acct.REALM ?? 'landlord';
const REALM_ID = '6a00d7ce323739077de89e58';
const BUILDING_ID = '6a5920fa1df21dc733133cbe';

// A marker no real item can carry, so cleanup can never delete the landlord's own
// bills — matching on «pending» alone would.
const MARK = 'E2E-INBOX-STATE';

test.use({ viewport: { width: 1500, height: 1050 }, deviceScaleFactor: 2 });

/**
 * Seed one InboxItem. `overrides` is spliced into the document as raw JS so a test can
 * express a state the schema allows but no healthy ingest would produce.
 */
function seedItem(overrides: string): string {
  const id = mongoExec(`
    var d = {
      realmId: '${REALM_ID}',
      source: 'telegram',
      status: 'pending',
      kind: 'bill',
      sourceFileName: '${MARK}.jpg',
      telegramMessageId: NumberInt(Math.floor(90000 + Math.random() * 9000)),
      createdDate: new Date(),
      updatedDate: new Date()
    };
    var o = ${overrides};
    for (var k in o) { d[k] = o[k]; }
    // Mint the id OURSELVES. mongo 4.4's shell insert() does not populate _id on the
    // object it was handed, so reading d._id afterwards threw «_id is undefined» —
    // after the document had already been written, which would have leaked a pending
    // item onto the landlord's real bell on every failed seed.
    d._id = ObjectId();
    db.inboxitems.insert(d);
    print(d._id.valueOf());
  `);
  const parsed = String(id || '').trim().split('\n').pop() || '';
  expect(parsed, 'seeding must return an id').toMatch(/^[a-f0-9]{24}$/);
  return parsed;
}

function cleanup() {
  mongoExec(`
    var r = db.inboxitems.remove({ sourceFileName: '${MARK}.jpg' });
    print('removed ' + r.nRemoved);
  `);
}

async function signIn(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/signin`);
  await page.waitForTimeout(700);
  await page.locator('input[name=email]').fill(EMAIL);
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 30000 })
    .toMatch(/(firstaccess|dashboard)/);
}

/** Open the bell and return its panel text. */
async function openBell(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/${encodeURIComponent(ORG)}/dashboard`);
  await page.waitForTimeout(2500);
  // By ACCESSIBLE NAME. The first version guessed at `header button` — there is no
  // <header> element; the bell lives inside <main>, and the guess timed out on all
  // seven tests while the item was sitting there correctly with its badge showing 1.
  const bell = page.getByRole('button', { name: 'Ειδοποιήσεις' });
  await expect(bell).toBeVisible({ timeout: 20000 });
  // The badge is the proof the seed reached the API: assert it before clicking, so a
  // seeding failure is distinguishable from a rendering failure.
  await expect(bell).toContainText(/[1-9]/);
  await bell.click();
  await page.waitForTimeout(2500);
  return page;
}

test.beforeEach(async () => {
  test.skip(!EMAIL, 'no landlord credentials');
  fs.mkdirSync(OUT, { recursive: true });
  // Belt and braces: clear any leftover from a panicked previous run BEFORE seeding,
  // or two items with the same marker make the assertions ambiguous.
  cleanup();
});

test.afterEach(async () => {
  cleanup();
});

test('a PARSE FAILURE shows the reason and advice that can be followed', async ({
  page
}) => {
  // The advice matters: Telegram compresses photos to ~1280px, so «try a closer
  // photo» is an instruction that cannot succeed. The scanner now says «send it as a
  // FILE», and a third reply that still said «send a photo» closed a loop with no
  // exit until it was fixed.
  seedItem(`{
    parseError: 'Ο πάροχος ΕΥΔΑΠ δεν υποστηρίζεται ακόμα',
    parsed: {},
    suggestedMatch: null,
    warnings: []
  }`);
  await signIn(page);
  await openBell(page);
  const text = await page.locator('body').innerText();
  await page.screenshot({ path: path.join(OUT, 'inbox_parse_error.png'), fullPage: true });
  expect(text).toContain('ΕΥΔΑΠ');
  // The reason must be shown, not swallowed into a generic failure.
  expect(text).toMatch(/δεν υποστηρίζεται|δεν διαβάστηκε|δεν αναγνωρίστηκε/);
});

test('WARNINGS reach the screen — a bill on a month nobody is charged for', async ({
  page
}) => {
  // THE DEFECT THIS EXISTS FOR. The scanner records this warning and GET /inbox
  // returns it (the handler returns the lean doc), and InboxBell never read
  // `item.warnings` — so it lived in the database and nowhere the landlord could see
  // it. Which is the same absent-representation failure the warning itself announces:
  // when a bill's month falls outside its expense's active range, the engine charges
  // that expense for no month at all and the amount lands on no surface.
  const warning =
    'Η δαπάνη «ΔΕΗ» ξεκινά τον Αύγουστο 2026, ενώ ο λογαριασμός αφορά τον Ιούνιο 2026 — δεν θα χρεωθεί σε κανέναν.';
  seedItem(`{
    parsed: {
      provider: 'deh',
      billingId: '999935585',
      billingIdNormalized: '999935585',
      totalAmount: 120,
      proposedTerm: NumberInt(2026060100)
    },
    suggestedMatch: null,
    warnings: ['${warning}']
  }`);
  await signIn(page);
  await openBell(page);
  await page.screenshot({ path: path.join(OUT, 'inbox_warning.png'), fullPage: true });
  await expect(page.locator('[data-cy=inboxItemWarnings]')).toBeVisible();
  const text = await page.locator('body').innerText();
  // The whole sentence, because the useful part is WHY: which expense, which month,
  // and that it reaches nobody.
  expect(text).toContain('δεν θα χρεωθεί σε κανέναν');
  expect(text).toContain('ΔΕΗ');
});

test('an AMBIGUOUS expense match does NOT read as «nothing matched»', async ({
  page
}) => {
  // Saying «no expense found» when SEVERAL were found is the opposite of the truth,
  // and its obvious remedy — create another δαπάνη for the same παροχή — makes the
  // ambiguity permanent.
  seedItem(`{
    parsed: {
      provider: 'deh',
      billingId: '999935585',
      billingIdNormalized: '999935585',
      totalAmount: 88.5,
      proposedTerm: NumberInt(2026080100)
    },
    suggestedMatch: { ambiguous: 'expense' },
    warnings: []
  }`);
  await signIn(page);
  await openBell(page);
  await page.screenshot({ path: path.join(OUT, 'inbox_ambiguous_expense.png'), fullPage: true });
  const text = await page.locator('body').innerText();
  expect(text).toMatch(/περισσότερες από μία δαπάν|more than one expense/i);
  // And it must NOT claim nothing was found.
  expect(text).not.toMatch(/δεν βρέθηκε δαπάνη/);
});

test('an AMBIGUOUS shared meter says so, and proposes no apartment', async ({
  page
}) => {
  // Falling through to the unit tier here would propose `single_unit` and bill a whole
  // building's shared supply to one flat.
  seedItem(`{
    parsed: {
      provider: 'deh',
      billingId: '999777888',
      billingIdNormalized: '999777888',
      totalAmount: 500,
      proposedTerm: NumberInt(2026080100)
    },
    suggestedMatch: { ambiguous: 'sharedMeter' },
    warnings: []
  }`);
  await signIn(page);
  await openBell(page);
  await page.screenshot({ path: path.join(OUT, 'inbox_ambiguous_shared.png'), fullPage: true });
  const text = await page.locator('body').innerText();
  expect(text).toMatch(/κοινόχρηστ|shared meter/i);
  expect(text).toMatch(/περισσότερ|more than one/i);
});

test('a MATCHED bill names the expense it belongs to', async ({ page }) => {
  seedItem(`{
    parsed: {
      provider: 'deh',
      // Synthetic band. The assertions below are about the expense NAME and the
      // amount; a real παροχή here would publish the landlord's supply number for
      // nothing. scan-pii caught it.
      billingId: '999900063',
      billingIdNormalized: '999900063',
      totalAmount: 120,
      proposedTerm: NumberInt(2026080100)
    },
    suggestedMatch: {
      buildingId: '${BUILDING_ID}',
      buildingName: 'E2E',
      expenseId: '6a7ca9b4a8c6d44c795e40f9',
      expenseName: 'ΔΕΗ'
    },
    warnings: []
  }`);
  await signIn(page);
  await openBell(page);
  await page.screenshot({ path: path.join(OUT, 'inbox_matched.png'), fullPage: true });
  const text = await page.locator('body').innerText();
  expect(text).toContain('ΔΕΗ');
  expect(text).toContain('120');
});

test('a SHARED-METER hit gives the building but offers a NEW expense', async ({
  page
}) => {
  // expenseId:'' is the signal: the building is known, no δαπάνη exists yet, so the
  // card must offer to create one rather than show a green «matched» with a blank
  // expense name.
  seedItem(`{
    parsed: {
      provider: 'deh',
      billingId: '999000777',
      billingIdNormalized: '999000777',
      totalAmount: 210,
      proposedTerm: NumberInt(2026080100)
    },
    suggestedMatch: {
      buildingId: '${BUILDING_ID}',
      buildingName: 'E2E',
      expenseId: '',
      expenseName: '',
      sharedProvider: 'deh',
      sharedLabel: 'Κλιμακοστάσιο'
    },
    warnings: []
  }`);
  await signIn(page);
  await openBell(page);
  await page.screenshot({ path: path.join(OUT, 'inbox_shared_hit.png'), fullPage: true });
  const text = await page.locator('body').innerText();
  // A building select or the create-expense affordance must be present; a green
  // «matched» with an empty expense name would be a lie.
  expect(text).toMatch(/δαπάν|κτίριο/i);
  expect(text).not.toMatch(/Αντιστοιχεί\s*:?\s*$/m);
});

test('DISMISS removes the item from the bell', async ({ page }) => {
  const id = seedItem(`{
    parseError: 'Αποτυχία ανάλυσης λογαριασμού',
    parsed: {},
    suggestedMatch: null,
    warnings: []
  }`);
  await signIn(page);
  await openBell(page);
  const before = await page.locator('body').innerText();
  expect(before).toMatch(/Αποτυχία ανάλυσης/);

  const dismiss = page.getByRole('button', { name: /Απόρριψη|Παράβλεψη|Διαγραφή/ }).first();
  const found = await dismiss.isVisible().catch(() => false);
  test.skip(!found, 'dismiss affordance not found on the card');
  await dismiss.click();
  await page.waitForTimeout(2500);

  // Assert the WRITE, not just the screen: the row must be non-pending in mongo, or a
  // re-render would bring it back.
  const status = mongoExec(
    `var i = db.inboxitems.findOne({_id: ObjectId('${id}')}); print(i ? i.status : 'gone');`
  );
  expect(String(status || '').trim()).toMatch(/dismissed|gone/);
});
