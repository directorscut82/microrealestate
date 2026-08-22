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
import { test, expect } from '@playwright/test';
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

// Real Telegram file_ids for the synthetic fixtures, so `original` resolves.
// Regenerate with sendDocument if Telegram ever invalidates them; the spec
// skips cleanly when the download fails for the Ε9 (see the test body).
const LEASE_FILE_ID = process.env.DOCIMPORT_LEASE_FILE_ID ?? '';
const E9_FILE_ID = process.env.DOCIMPORT_E9_FILE_ID ?? '';

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
            title: "ΔΟΚΙΜΗ ΒΗΤΑ · ΑΦΜ 999000043",
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
          summary: {title: "1 κτίριο · 2 μονάδες", subtitle: "ΟΔΟΣ ΒΗΤΑ 4"}
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
  await page.waitForURL(/\/(dashboard|landlord)/, { timeout: 60_000 });
}

async function openBell(page: any) {
  await page
    .getByRole('button', { name: /Ειδοποιήσεις|Notifications/ })
    .click();
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

test.beforeAll(() => {
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

  // Marker-scoped counts, not toBeVisible tautologies.
  await expect(popover.getByText('ΔΟΚΙΜΗ ΒΗΤΑ · ΑΦΜ 999000043')).toHaveCount(1);
  await expect(popover.getByText('1 κτίριο · 2 μονάδες')).toHaveCount(1);
  // the lease classification chip
  await expect(popover.getByText('Νέος ενοικιαστής')).toHaveCount(1);
  // both cards carry the shadow-mode assurance
  await expect(
    popover.getByText('Δεν εισάγεται τίποτα πριν το ελέγξετε.')
  ).toHaveCount(2);
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
    .filter({ hasText: '1 κτίριο · 2 μονάδες' });
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

test('lease «Άνοιγμα» opens the tenant import dialog prefilled from the stored parse', async ({
  page
}) => {
  await signIn(page);
  const popover = await openBell(page);

  const leaseCard = popover
    .locator('[data-cy="inboxDocCard"]')
    .filter({ hasText: 'ΔΟΚΙΜΗ ΒΗΤΑ · ΑΦΜ 999000043' });
  await expect(leaseCard).toHaveCount(1);
  await leaseCard.getByRole('link', { name: 'Άνοιγμα' }).click();

  await page.waitForURL(/inboxImport=/, { timeout: 30_000 });
  await expect(
    page.getByText('ΔΟΚΙΜΗ ΒΗΤΑ').first().or(page.getByText('Κάτι πήγε στραβά'))
  ).toBeVisible({ timeout: 30_000 });
  await expectNoCrash(page);
  // the parsed tenant and property reached the review rows
  await expect(page.getByText('ΔΟΚΙΜΗ ΒΗΤΑ').first()).toBeVisible();
  await expect(page.getByText('ΟΔΟΣ ΑΛΦΑ 12').first()).toBeVisible();

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
  await page.goto(`${BASE}/${ORG}/buildings?inboxImport=${id}`, {
    waitUntil: 'domcontentloaded'
  });
  await expectNoCrash(page);
  // the review dialog must NOT be open
  await expect(page.locator('[data-cy="confirmImport"]')).toHaveCount(0);
  // and the query param is stripped so a reload cannot resurrect it
  await expect
    .poll(() => new URL(page.url()).searchParams.get('inboxImport'), {
      timeout: 30_000
    })
    .toBeNull();

  // restore for the afterAll cleanup predicate
  mongoExec(
    `db.inboxitems.updateOne({_id: ObjectId("${id}")}, {$set: {status: "pending"}});`
  );
});
