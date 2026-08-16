/**
 * The voice-command samples card (settings → Υπηρεσίες τρίτων, Telegram
 * section) — driven in a real browser against the live NAS.
 *
 * Samples are seeded with DIRECT MONGO INSERTS (the repo rule for this shape):
 * the only healthy writer is a completed Telegram dialogue, which a spec
 * cannot hold. Every seeded row carries the sourceFileName MARKER so cleanup
 * can never touch a real sample — the realm is the landlord's live data and
 * these rows feed the real calibration counters, so a leaked seed would poison
 * the very statistics the shadow phase exists to collect.
 *
 * Count assertions are marker-scoped toHaveCount — not toBeVisible tautologies
 * — and the API check asserts the PRIVACY property (no transcript text, no
 * decodes in the browser payload), which is the endpoint's load-bearing
 * design decision.
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

const MARK = 'E2E-VOICE-SAMPLE';

test.use({ viewport: { width: 1500, height: 1050 }, deviceScaleFactor: 2 });
test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 });

function seed(): void {
  const out = mongoExec(`
    db.inboxitems.insertMany([
      {
        realmId: '${REALM_ID}', source: 'telegram', kind: 'voiceCommand',
        status: 'validated', sourceFileName: '${MARK}.ogg',
        telegramMessageId: NumberInt(7770101),
        voiceCommand: {
          intent: 'rentPayment', personId: 'e2e1',
          personName: '${MARK} ΚΑΠΠΑ', personConfidence: 0.97,
          amount: 350, amountSource: 'text', month: 8,
          transcript: [
            { text: 'ΠΛΗΡΩΜΗ ΕΝΟΙΚΙΟΥ ΚΑΠΠΑ', source: 'voice' },
            { text: '350', source: 'text' },
            { text: 'ναι', source: 'text' }
          ],
          telegramFileIds: ['e2ef1'],
          decodes: [{ mode: 'command', value: null, p: 0.9, lr: -20, nFrames: 142, accept: true, reason: 'transcript', ms: 900 }],
          corrections: 0, outcome: 'validated'
        },
        createdDate: new Date(), updatedDate: new Date()
      },
      {
        realmId: '${REALM_ID}', source: 'telegram', kind: 'voiceCommand',
        status: 'validated', sourceFileName: '${MARK}.ogg',
        telegramMessageId: NumberInt(7770102),
        voiceCommand: {
          intent: 'commonChargesPayment', personId: 'e2e2',
          personName: '${MARK} ΛΑΜΔΑ', personConfidence: 0.91,
          amount: 30, amountSource: 'text', month: 8,
          transcript: [{ text: 'κοινοχρηστα 40 Αύγουστος', source: 'text' }],
          telegramFileIds: [], decodes: [],
          corrections: 1, outcome: 'validated'
        },
        createdDate: new Date(Date.now() - 60000), updatedDate: new Date()
      }
    ]);
    print('seeded=' + db.inboxitems.count({ sourceFileName: '${MARK}.ogg' }));
  `);
  expect(String(out), 'seed must land both rows').toContain('seeded=2');
}

function cleanup(): void {
  mongoExec(`
    var r = db.inboxitems.remove({ sourceFileName: '${MARK}.ogg' });
    print('removed ' + r.nRemoved);
  `);
}

async function signIn(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
  const email = page.locator('input[name=email]');
  await expect(email).toBeVisible({ timeout: 60_000 });
  await email.fill(EMAIL);
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 30000 })
    .toMatch(/(firstaccess|dashboard)/);
}

test.beforeAll(() => {
  test.skip(!EMAIL || !PASSWORD, 'landlord-account secrets missing');
  cleanup(); // leftovers from a panicked prior run
  seed();
});

test.afterAll(() => {
  cleanup();
  const left = mongoExec(
    `print(db.inboxitems.count({ sourceFileName: '${MARK}.ogg' }));`
  );
  expect(String(left).trim().split('\n').pop(), 'cleanup left rows').toBe('0');
});

test('the card renders the seeded samples with amounts, months and outcome pills', async ({
  page
}) => {
  await signIn(page);
  await page.goto(`${BASE}/${encodeURIComponent(ORG)}/settings/thirdparties`, {
    waitUntil: 'domcontentloaded'
  });
  const card = page.locator('[data-cy=voiceSamplesCard]');
  await expect(card).toBeVisible({ timeout: 30000 });

  // Marker-scoped COUNT: exactly the two seeded rows, however many real
  // samples the landlord's own dialogues have accumulated around them.
  const seeded = card.locator('[data-cy=voiceSampleRow]', { hasText: MARK });
  await expect(seeded).toHaveCount(2);

  const kappa = seeded.filter({ hasText: 'ΚΑΠΠΑ' });
  await expect(kappa).toContainText('Καταβολή ενοικίου');
  await expect(kappa).toContainText('350,00');
  await expect(kappa).toContainText('Αύγουστος');
  await expect(kappa).toContainText('Επικυρώθηκε');
  // A complete row must NOT carry the incomplete marker.
  await expect(kappa).not.toContainText('ημιτελές');

  const lamda = seeded.filter({ hasText: 'ΛΑΜΔΑ' });
  await expect(lamda).toContainText('Πληρωμή κοινοχρήστων');
  await expect(lamda).toContainText('1 διόρθωση');

  // The stats footer counts ALL samples (real + seeded): assert shape and
  // that the totals at least cover the two we control.
  const statsLine = card.locator('text=/Δείγματα: \\d+/');
  await expect(statsLine).toBeVisible();
  const statsText = (await statsLine.innerText()).trim();
  const total = Number(/Δείγματα: (\d+)/.exec(statsText)?.[1] ?? '0');
  const validated = Number(/Επικυρωμένα: (\d+)/.exec(statsText)?.[1] ?? '0');
  expect(total, `stats total in «${statsText}»`).toBeGreaterThanOrEqual(2);
  expect(validated, `stats validated in «${statsText}»`).toBeGreaterThanOrEqual(2);
});

test('the API payload carries slots but NEVER transcripts or decode scores', async ({
  request
}) => {
  const signin = await request.post(
    'http://192.168.0.96:1350/api/v2/authenticator/landlord/signin',
    { data: { email: EMAIL, password: PASSWORD } }
  );
  expect(signin.status(), 'signin').toBe(200);
  const token = (await signin.json()).accessToken as string;

  const realms = await request.get('http://192.168.0.96:1350/api/v2/realms', {
    headers: { Authorization: `Bearer ${token}` }
  });
  expect(realms.status(), 'realms').toBe(200);
  const realm = ((await realms.json()) as any[]).find((r) => r.name === ORG);
  expect(realm, `realm ${ORG}`).toBeTruthy();

  const res = await request.get(
    'http://192.168.0.96:1350/api/v2/inbox/voicesamples',
    {
      headers: {
        Authorization: `Bearer ${token}`,
        organizationid: String(realm._id)
      }
    }
  );
  expect(res.status(), 'voicesamples').toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.items), 'items array').toBe(true);
  expect(body.stats, 'stats object').toMatchObject({
    total: expect.any(Number),
    validated: expect.any(Number),
    rejected: expect.any(Number),
    abandoned: expect.any(Number),
    validatedLe1: expect.any(Number)
  });
  const ours = body.items.filter((i: any) =>
    String(i.personName || '').includes(MARK)
  );
  expect(ours.length, 'both seeded rows in payload').toBe(2);
  // The privacy property: what the landlord SAID to the bot, and the raw
  // calibration scores, never reach the browser. The seeded transcript text
  // must be absent from the entire payload.
  const raw = JSON.stringify(body);
  expect(raw).not.toContain('ΠΛΗΡΩΜΗ ΕΝΟΙΚΙΟΥ ΚΑΠΠΑ');
  expect(raw).not.toContain('decodes');
  expect(raw).not.toContain('nFrames');
  expect(raw).not.toContain('telegramFileIds');
});
