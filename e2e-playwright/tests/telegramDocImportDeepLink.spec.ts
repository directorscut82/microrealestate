/**
 * Telegram document imports: the bell card → «Άνοιγμα» → the REAL import dialog,
 * driven in a browser against the live NAS.
 *
 * THIS SPEC EXISTS BECAUSE ITS ABSENCE SHIPPED A CRASH. The Ε9 deep link was
 * dead on arrival: `ImportE9Dialog` renders `preview.owners` (PLURAL — its
 * upload path aggregates one owner per file across a batch), the server's
 * single-document preview returns `owner` singular, and the raw response was
 * handed straight into the dialog's state, so `preview.owners.length` threw
 * during render and ErrorBoundary replaced the whole page. A green server suite
 * and a screenshot of the bell both missed it, because neither crosses the
 * boundary between them. Every assertion below is chosen to fail on that class
 * of defect: each dialog must RENDER ITS PARSED CONTENT, and the ErrorBoundary
 * fallback «Κάτι πήγε στραβά» must be absent.
 *
 * Rows are seeded with DIRECT MONGO INSERTS (the repo rule for this shape): the
 * only healthy writer is a Telegram document the landlord sends from their own
 * client, which a spec cannot do — a bot never receives its own outgoing
 * messages as updates. `telegramFileId` points at a REAL Telegram upload of the
 * synthetic fixture, so `GET /inbox/:id/original` exercises its real
 * re-download fallback rather than a stub.
 *
 * NOTHING IS IMPORTED. The spec stops at the review step and closes the dialog:
 * completing it would create tenants/buildings in the landlord's live realm.
 * Every seeded row carries the MARK so cleanup can never touch a real
 * notification.
 */
import { test, expect, request } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { mongoExec } from './lib/mongoExec';

const BASE = 'http://192.168.0.96:1350/landlord/el';
const ACCT_FILE = path.resolve(__dirname, '../../.secrets/landlord-account');
const acct = fs.existsSync(ACCT_FILE)
  ? dotenv.parse(fs.readFileSync(ACCT_FILE))
  : ({} as Record<string, string>);
const EMAIL = acct.EMAIL ?? '';
const PASSWORD = acct.PASSWORD ?? '';
const ORG = acct.REALM ?? 'landlord';
const REALM_ID = '6a00d7ce323739077de89e58';

const MARK = 'E2E-DOCIMPORT';
// The doc card renders ONLY importDoc.summary — `sourceFileName` (where MARK
// lives) shows on the parseError branch alone. So MARK goes in the TITLE too: a
// seed leaked by a crashed run must be recognisable as a test row on the
// landlord's real bell, not a plausible «ΔΟΚΙΜΗ ΒΗΤΑ» card with a live
// «Άνοιγμα» button that would import a synthetic tenant into production.
const LEASE_TITLE = `${MARK} · ΔΟΚΙΜΗ ΒΗΤΑ · ΑΦΜ 999000043`;
const E9_TITLE = `${MARK} · 1 κτίριο · 2 μονάδες`;

/**
 * SELF-PROVISIONED Telegram file_ids, from a fixture GENERATED AT RUN TIME.
 *
 * The Ε9 dialog refuses to open without the original bytes (its confirm
 * re-uploads the file), so its test needs `telegramFileId` to resolve through
 * GET /inbox/:id/original. Two earlier shapes were both wrong:
 *   · reading the ids from env vars that existed nowhere in the repo — so on
 *     every machine but the author's the Ε9 test SKIPPED and the seed wrote an
 *     empty id: the guard for the crash this spec exists to catch did not guard;
 *   · committing the two synthetic PDFs as fixtures — correctly refused by the
 *     pre-commit scanner, because this repo's rule is that documents stay OUTSIDE
 *     a public repo and a scanner cannot tell a synthetic PDF from a real one.
 * So the PDF is rendered here, by the browser Playwright already runs, from HTML
 * held as plain reviewable text, and uploaded to get a durable file_id. Nothing
 * binary is committed and nothing depends on the author's shell.
 *
 * The values are the repo's synthetic placeholders only: the 9990000xx ΑΦΜ band
 * and ΟΔΟΣ ΑΛΦΑ/ΒΗΤΑ streets.
 */
const BOT_FILE = path.resolve(
  __dirname,
  '../../.secrets/telegram-microrealestate-bot'
);
const bot = fs.existsSync(BOT_FILE)
  ? dotenv.parse(fs.readFileSync(BOT_FILE))
  : ({} as Record<string, string>);
const BOT_TOKEN = bot.BOT_TOKEN ?? '';
const ADMIN_CHAT_ID = bot.ADMIN_CHAT_ID ?? '';

let LEASE_FILE_ID = '';
let E9_FILE_ID = '';

const LEASE_HTML = `<html><head><meta charset="utf-8"><style>body{font-family:Helvetica,Arial;font-size:11px}</style></head><body>
<p>ΑΠΟΔΕΙΞΗ ΥΠΟΒΟΛΗΣ ΔΗΛΩΣΗΣ ΠΛΗΡΟΦΟΡΙΑΚΩΝ ΣΤΟΙΧΕΙΩΝ ΜΙΣΘΩΣΗΣ ΑΚΙΝΗΤΗΣ ΠΕΡΙΟΥΣΙΑΣ</p>
<p>ΑΡ. ΔΗΛΩΣΗΣ &nbsp; 999532100 &nbsp; ΗΜ/ΝΙΑ ΥΠΟΒΟΛΗΣ &nbsp; 01/09/2026</p>
<p>ΣΤΟΙΧΕΙΑ ΕΚΜΙΣΘΩΤH: A/A 1 Κύριος &nbsp; ΔΟΚΙΜΗ ΑΛΦΑ (ΑΦΜ Δηλούντος:999000018) Ποσοστό &nbsp; 100</p>
<p>ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΤH: A/A 1 ΟΝΟΜΑΤΕΠΩΝΥΜΟ/ΕΠΩΝΥΜΙΑ &nbsp; ΔΟΚΙΜΗ ΒΗΤΑ (Α.Φ.Μ:999000043)</p>
<p>ΣΤΟΙΧΕΙΑ ΑΚΙΝΗΤΟΥ ΔΙΕΥΘΥΝΣΗ ΑΚΙΝΗΤΟΥ &nbsp; ΟΔΟΣ ΑΛΦΑ 12 ΑΘΗΝΑ 11111</p>
</body></html>`;

const E9_HTML = `<html><head><meta charset="utf-8"><style>body{font-family:Helvetica,Arial;font-size:11px}</style></head><body>
<p>ΒΕΒΑΙΩΣΗ ΥΠΟΒΟΛΗΣ ΔΗΛΩΣΗΣ ΣΤΟΙΧΕΙΩΝ ΑΚΙΝΗΤΩΝ (Ε9) ΕΤΟΥΣ 2026</p>
<p>ΣΤΟΙΧΕΙΑ ΦΟΡΟΛΟΓΟΥΜΕΝΟΥ: ΔΟΚΙΜΗ ΑΛΦΑ ΑΦΜ 999000018</p>
<p>ΠΙΝΑΚΑΣ 1: ΣΤΟΙΧΕΙΑ ΑΚΙΝΗΤΩΝ ΠΟΥ ΥΠΑΡΧΟΥΝ ΤΗΝ 01/01/2026</p>
<p>1 ΟΔΟΣ ΒΗΤΑ 4 ΑΘΗΝΑ 22222 ΑΤΑΚ 99900000021 ΕΠΙΦΑΝΕΙΑ 90</p>
</body></html>`;

/** Render HTML to a PDF buffer with the browser Playwright already runs. */
async function renderPdf(browser: any, html: string): Promise<Buffer> {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await page.pdf({ format: 'A4' });
  } finally {
    await page.close();
  }
}

/** Upload a buffer to the admin chat; returns its durable file_id. */
async function uploadFixture(name: string, buffer: Buffer): Promise<string> {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return '';
  const api = await request.newContext();
  try {
    const r = await api.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`,
      {
        multipart: {
          chat_id: ADMIN_CHAT_ID,
          document: { name: `${name}.pdf`, mimeType: 'application/pdf', buffer }
        },
        timeout: 60_000
      }
    );
    const body = await r.json();
    return body?.result?.document?.file_id ?? '';
  } catch {
    return '';
  } finally {
    await api.dispose();
  }
}

test.use({ viewport: { width: 1500, height: 1050 }, deviceScaleFactor: 2 });
test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 });

function seed(): string | null {
  return mongoExec(`
    db.inboxitems.deleteMany({realmId: "${REALM_ID}", sourceFileName: /^${MARK}/});
    var now = new Date();
    db.inboxitems.insertMany([
      {
        realmId: "${REALM_ID}", source: "telegram", status: "pending",
        kind: "leaseImport", parsed: {},
        importDoc: {
          docKind: "lease",
          parsed: {
            declarationNumber: "999532100", submissionDate: "01/09/2026",
            isAmendment: false,
            landlords: [{name: "ΔΟΚΙΜΗ ΑΛΦΑ", taxId: "999000018", percentage: 100}],
            tenants: [{name: "ΔΟΚΙΜΗ ΒΗΤΑ", taxId: "999000043"}],
            originalStartDate: "01/10/2026", leaseType: "ΑΣΤΙΚΗ",
            totalMonthlyRent: 350,
            validityStart: "01/10/2026", validityEnd: "30/09/2029",
            notes: "",
            properties: [{
              category: "ΚΑΤΟΙΚΙΑ", type: "ΔΙΑΜΕΡΙΣΜΑ", atakNumber: "99900000012",
              rawAddress: "ΟΔΟΣ ΑΛΦΑ 12",
              address: {street1: "ΟΔΟΣ ΑΛΦΑ 12", zipCode: "11111", city: "ΑΘΗΝΑ"},
              surface: 85, monthlyRent: 350, dehNumber: ""
            }]
          },
          summary: {
            title: "${LEASE_TITLE}",
            subtitle: "ΟΔΟΣ ΑΛΦΑ 12 · 350 € / μήνα · 01/10/2026–30/09/2029",
            classification: "new"
          }
        },
        sourceFileName: "${MARK}-misthotirio.pdf",
        sourceMimeType: "application/pdf",
        telegramMessageId: 970001,
        telegramFileId: "${LEASE_FILE_ID}",
        createdDate: new Date(now - 3*60*1000), updatedDate: now
      },
      {
        realmId: "${REALM_ID}", source: "telegram", status: "pending",
        kind: "e9Import", parsed: {},
        importDoc: {
          docKind: "e9",
          parsed: {
            owner: {taxId: "999000018", lastName: "ΔΟΚΙΜΗ", firstName: "ΑΛΦΑ"},
            buildings: [{
              address: {street1: "ΟΔΟΣ ΒΗΤΑ 4", zipCode: "22222", city: "ΑΘΗΝΑ"},
              units: [
                {atakNumber: "99900000021", surface: 90, floor: "1", percentage: 100, category: "ΚΑΤΟΙΚΙΑ"},
                {atakNumber: "99900000022", surface: 75, floor: "2", percentage: 100, category: "ΚΑΤΟΙΚΙΑ"}
              ]
            }],
            skippedLandPlots: 0
          },
          summary: {title: "${E9_TITLE}", subtitle: "ΟΔΟΣ ΒΗΤΑ 4"}
        },
        sourceFileName: "${MARK}-e9.pdf",
        sourceMimeType: "application/pdf",
        telegramMessageId: 970002,
        telegramFileId: "${E9_FILE_ID}",
        createdDate: new Date(now - 6*60*1000), updatedDate: now
      }
    ]);
    print("seeded=" + db.inboxitems.count({realmId: "${REALM_ID}", sourceFileName: /^${MARK}/}));
  `);
}

function cleanup(): void {
  mongoExec(`
    var r = db.inboxitems.deleteMany({realmId: "${REALM_ID}", sourceFileName: /^${MARK}/});
    print("removed=" + r.deletedCount);
  `);
}

async function signIn(page: any) {
  await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/Email|Ηλεκτρονικό/i).fill(EMAIL);
  await page.getByLabel(/Password|Κωδικός/i).fill(PASSWORD);
  await page.getByRole('button', { name: /Σύνδεση|Sign in/i }).click();
  // `/landlord` is the app's BASE PATH, so a matcher containing it passes
  // instantly while still on /signin — the sign-in then races whatever comes
  // next. Wait for the dashboard route specifically.
  await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
}

async function openBell(page: any) {
  const bell = page.getByRole('button', {
    name: /Ειδοποιήσεις|Notifications/
  });
  await expect(bell).toBeVisible({ timeout: 60_000 });
  await bell.click();
  const popover = page.locator('[data-radix-popper-content-wrapper]');
  await popover.waitFor({ state: 'visible', timeout: 15_000 });
  return popover;
}

/** The ErrorBoundary fallback must never be on screen. */
async function expectNoCrash(page: any) {
  await expect(page.getByText('Κάτι πήγε στραβά')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Επαναφόρτωση σελίδας' })
  ).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
  test.skip(
    !EMAIL || !PASSWORD,
    'no landlord account in .secrets — cannot sign in'
  );
  // Render, then upload, BEFORE seeding: the row embeds the file_id.
  const [leasePdf, e9Pdf] = [
    await renderPdf(browser, LEASE_HTML),
    await renderPdf(browser, E9_HTML)
  ];
  [LEASE_FILE_ID, E9_FILE_ID] = await Promise.all([
    uploadFixture('synthetic-misthotirio', leasePdf),
    uploadFixture('synthetic-e9', e9Pdf)
  ]);
  const out = seed();
  test.skip(out === null, 'no portainer token — cannot seed');
  expect(out).toContain('seeded=2');
});

test.afterAll(() => {
  cleanup();
});

test('the bell shows both document cards with their server-composed summaries', async ({
  page
}) => {
  await signIn(page);
  const popover = await openBell(page);

  // SCOPED TO THE TWO SEEDED CARDS. A popover-wide toHaveCount(2) on the
  // shadow-mode line breaks the moment the landlord has one REAL μισθωτήριο or
  // Ε9 pending — the normal state of this feature in production — so counts must
  // be per-card, not realm-global.
  const leaseCard = popover
    .locator('[data-cy="inboxDocCard"]')
    .filter({ hasText: LEASE_TITLE });
  const e9Card = popover
    .locator('[data-cy="inboxDocCard"]')
    .filter({ hasText: E9_TITLE });
  await expect(leaseCard).toHaveCount(1);
  await expect(e9Card).toHaveCount(1);
  await expect(leaseCard.getByText('Νέος ενοικιαστής')).toHaveCount(1);
  await expect(
    leaseCard.getByText('Δεν εισάγεται τίποτα πριν το ελέγξετε.')
  ).toHaveCount(1);
  await expect(
    e9Card.getByText('Δεν εισάγεται τίποτα πριν το ελέγξετε.')
  ).toHaveCount(1);
  await expectNoCrash(page);
});

test('Ε9 «Άνοιγμα» opens the REAL import dialog and renders the owner — the regression that shipped', async ({
  page
}) => {
  test.skip(
    !E9_FILE_ID,
    'no Ε9 file_id: the dialog requires the original bytes'
  );
  await signIn(page);
  const popover = await openBell(page);

  // Scope to the CARD ROOT, not a text-bearing descendant: `locator('div',
  // {hasText}).last()` resolves to the innermost div holding the string, which
  // does not contain the link at all.
  const e9Card = popover
    .locator('[data-cy="inboxDocCard"]')
    .filter({ hasText: E9_TITLE });
  await expect(e9Card).toHaveCount(1);
  await e9Card.getByRole('link', { name: 'Άνοιγμα' }).click();

  await page.waitForURL(/inboxImport=/, { timeout: 30_000 });

  // THE assertion. Wait for the page to SETTLE into either outcome first —
  // asserting the crash's absence immediately after the URL change passes
  // trivially, because the dialog has not rendered yet and the throw has not
  // happened. Racing the two makes the failure message name the actual defect
  // («the ErrorBoundary is on screen») instead of a downstream
  // element-not-found.
  await expect(
    page.getByText('ΔΟΚΙΜΗ ΑΛΦΑ').first().or(page.getByText('Κάτι πήγε στραβά'))
  ).toBeVisible({ timeout: 30_000 });
  await expectNoCrash(page);
  await expect(page.getByText('ΔΟΚΙΜΗ ΑΛΦΑ').first()).toBeVisible();
  await expect(page.getByText('ΟΔΟΣ ΒΗΤΑ 4').first()).toBeVisible();
  // it landed on the REVIEW step: the confirm control exists and is enabled
  await expect(page.locator('[data-cy="confirmImport"]')).toBeVisible();
  // and the unit count from the stored parse made it through
  await expect(page.getByText('99900000021').first()).toBeVisible();

  // Close WITHOUT importing — a completed import would write to live data.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-cy="confirmImport"]')).toHaveCount(0);
  // the item is still pending: closing must not consume the notification
  const still = mongoExec(
    `print(db.inboxitems.count({realmId: "${REALM_ID}", sourceFileName: /^${MARK}-e9/, status: "pending"}));`
  );
  expect((still || '').trim()).toBe('1');
});

test('re-opening the SAME item re-hydrates — the hydrate-once guard must not outlive the dialog', async ({
  page
}) => {
  // The regression the finding-4 fix introduced: `hydratedRef` was set on first
  // hydration and never cleared, while both dialogs stay permanently mounted and
  // «Άνοιγμα» is a same-pathname next/link — so nothing remounts and the second
  // open bailed on the stale ref, landing on the file drop zone with no preview,
  // no error and no explanation until a full page reload. Silent breakage of the
  // feature's primary flow.
  test.skip(
    !E9_FILE_ID,
    'fixture upload failed — the Ε9 dialog needs the original'
  );
  await signIn(page);

  for (const pass of ['first', 'second']) {
    const popover = await openBell(page);
    await popover
      .locator('[data-cy="inboxDocCard"]')
      .filter({ hasText: E9_TITLE })
      .getByRole('link', { name: 'Άνοιγμα' })
      .click();
    await expect(page.locator('[data-cy="confirmImport"]')).toBeVisible({
      timeout: 30_000
    });
    await expectNoCrash(page);
    // the PREVIEW is present, not just the shell: the drop zone would also
    // render a dialog, which is exactly what the bug produced
    await expect(page.getByText('ΟΔΟΣ ΒΗΤΑ 4').first()).toBeVisible();
    if (pass === 'first') {
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-cy="confirmImport"]')).toHaveCount(0);
    }
  }

  await page.keyboard.press('Escape');
});

test('lease «Άνοιγμα» opens the tenant import dialog prefilled from the stored parse', async ({
  page
}) => {
  await signIn(page);
  const popover = await openBell(page);

  const leaseCard = popover
    .locator('[data-cy="inboxDocCard"]')
    .filter({ hasText: LEASE_TITLE });
  await expect(leaseCard).toHaveCount(1);
  await leaseCard.getByRole('link', { name: 'Άνοιγμα' }).click();

  await page.waitForURL(/inboxImport=/, { timeout: 30_000 });
  await expect(
    page.getByText('ΔΟΚΙΜΗ ΒΗΤΑ').first().or(page.getByText('Κάτι πήγε στραβά'))
  ).toBeVisible({ timeout: 30_000 });
  await expectNoCrash(page);
  // DIALOG-ONLY anchor: every string on the review rows also appears on the bell
  // card that opened it (they come from the same parse), so a text assertion
  // alone would pass with the popover still up and no dialog at all — and both
  // strings are the repo's shared synthetic placeholders, satisfiable by a
  // tenant another spec leaked.
  await expect(page.locator('[data-cy="confirmLeaseImport"]')).toBeVisible({
    timeout: 30_000
  });
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('ΔΟΚΙΜΗ ΒΗΤΑ').first()).toBeVisible();
  await expect(dialog.getByText('ΟΔΟΣ ΑΛΦΑ 12').first()).toBeVisible();

  await page.keyboard.press('Escape');
  const still = mongoExec(
    `print(db.inboxitems.count({realmId: "${REALM_ID}", sourceFileName: /^${MARK}-misthotirio/, status: "pending"}));`
  );
  expect((still || '').trim()).toBe('1');
});

test('a consumed notification’s deep link fails visibly instead of opening an empty dialog', async ({
  page
}) => {
  // Flip the Ε9 row to confirmed, then follow its link: getImportPayload 404s
  // and the hook must toast + clean the URL rather than leave a dead dialog.
  const id = (
    mongoExec(
      `print(db.inboxitems.findOne({realmId: "${REALM_ID}", sourceFileName: /^${MARK}-e9/})._id.str);`
    ) || ''
  ).trim();
  expect(id).toMatch(/^[a-f0-9]{24}$/);
  mongoExec(
    `db.inboxitems.updateOne({_id: ObjectId("${id}")}, {$set: {status: "confirmed"}});`
  );

  await signIn(page);
  await page.goto(
    `${BASE}/${encodeURIComponent(ORG)}/buildings?inboxImport=${id}`,
    {
      waitUntil: 'domcontentloaded'
    }
  );
  // ORDER MATTERS. These two toHaveCount(0) assertions used to run immediately
  // after `goto(..., 'domcontentloaded')` — before React had hydrated, let alone
  // opened a dialog or thrown — so they passed trivially. The poll is the
  // assertion that actually carries this test; the absences are only meaningful
  // once the app has settled.
  await expect
    .poll(() => new URL(page.url()).searchParams.get('inboxImport'), {
      timeout: 30_000
    })
    .toBeNull();
  await expectNoCrash(page);
  // the review dialog must NOT be open
  await expect(page.locator('[data-cy="confirmImport"]')).toHaveCount(0);

  // Restore the status so a re-run starts from the seeded state. NOT needed by
  // cleanup(), which matches on realmId + sourceFileName only.
  mongoExec(
    `db.inboxitems.updateOne({_id: ObjectId("${id}")}, {$set: {status: "pending"}});`
  );
});
