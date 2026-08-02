/**
 * Spec 48 — the notification bell (InboxItem kind:'notice').
 *
 * Surface: webapps/landlord/src/components/InboxBell.js — the bell in the app
 * header, its badge, and the NoticeCard rows inside the popover. Backed by
 * GET /api/v2/inbox (inboxmanager.list) which returns status:'pending' items.
 *
 * WHY THE NOTICES ARE MONGO-SEEDED, not produced by the scanner:
 *   The 8 notice conditions are written by noticeScanner.runNoticeScans, which
 *   runs ONLY in-process under the api container on a once-per-UTC-day cron
 *   tick. There is no HTTP route that invokes it, and no way to advance the
 *   container's clock from here. The scanner's own logic is covered by 30 jest
 *   cases (services/api/src/__tests__/noticeScanner.test.js) with injected
 *   finders. What jest CANNOT cover — and what this spec exists for — is
 *   whether the rendered Greek bell actually displays a notice correctly.
 *   So the notice documents are inserted with the exact shape createNotice
 *   writes, and the assertions are all on the UI.
 *
 * Coverage:
 *   48.1 badge counts BILLS only — notices contribute a dot, not a number
 *        (regression: one unpaid bill fires at 4 windows, so counting notices
 *        made the badge read 4 for a single bill)
 *   48.2 every one of the 8 notice codes renders its Greek message + icon
 *   48.3 the «Άνοιγμα» deep-link navigates AND closes the popover
 *        (regression: InboxBell lives in Layout, so a client-side navigation
 *        does not unmount it and the popover stayed over the target page)
 *   48.4 dismiss removes the row and the server records status:'dismissed'
 *   48.5 a malformed notice (no `notice` subdoc) does not blank the bell
 *   48.6 the two deleted dashboard tiles are GONE from the dashboard
 *
 * Discipline (.kiro/steering/test-running-guide.md):
 *   - toHaveCount / value assertions, never a bare toBeVisible on a row that
 *     is also present in the unfiltered list
 *   - status assertion on every awaited HTTP response
 *   - every fixture carries a run-unique tag; cleanup deletes by that tag, so
 *     a partial-cleanup leftover cannot satisfy a later run's assertion
 *   - the realm is the canonical test realm; notices are additive and are
 *     removed in afterAll
 */
import { APIRequestContext, expect, Page, request, test } from '@playwright/test';
import { getAccessToken } from './lib/api';
import { mongoExec } from './lib/mongoExec';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

// Run-unique so concurrent runs and leftovers can never collide.
const TAG = `s48-${Date.now()}`;

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error(
      'Missing TEST_EMAIL/TEST_PASSWORD. Expected .secrets/cypress-test-account.'
    );
  }
});

async function resolveRealm(api: APIRequestContext) {
  const token = await getAccessToken(api);
  const r = await api.get(`${GATEWAY}/api/v2/realms`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  expect(r.status(), 'list realms').toBe(200);
  const realms = (await r.json()) as Array<{ _id: string; name: string }>;
  const name = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';
  const realm = realms.find((x) => x.name === name);
  expect(realm, `realm ${name} must exist`).toBeTruthy();
  return { token, realmId: String(realm!._id), realmName: realm!.name };
}

/**
 * The 8 notice codes with the Greek text the server composes. Kept in the same
 * order the scanners fire them so a reviewer can diff this against
 * noticeScanner.ts / leaseExpiryScanner.ts by eye.
 */
const NOTICES = [
  {
    code: 'lease-expiry',
    message: '⏳ Μίσθωση λήγει σε 7 ημέρες: ΕΝΟΙΚΟΣ ΔΟΚΙΜΗΣ',
    link: '/tenants/000000000000000000000001'
  },
  {
    code: 'energy-cert',
    message: '📜 Ενεργειακό πιστοποιητικό λήγει σε 30 ημέρες: ΟΔΟΣ ΑΛΦΑ 1',
    link: '/buildings/000000000000000000000002'
  },
  {
    code: 'bill-due',
    message: '💶 Λογαριασμός ΔΕΗ λήγει σε 7 ημέρες: 200,00 € (ΟΔΟΣ ΑΛΦΑ 1)',
    link: '/buildings/000000000000000000000002'
  },
  {
    code: 'unpaid-rents',
    message: '⏱ Απλήρωτα ενοίκια Ιουλίου 2026: 2 — ΑΛΦΑ (500,00 €), ΒΗΤΑ (300,00 €)',
    link: '/rents/2026.07'
  },
  {
    code: 'deposit-unreturned',
    message:
      '💰 Εγγύηση δεν έχει επιστραφεί: ΕΝΟΙΚΟΣ ΔΟΚΙΜΗΣ — 500,00 €, μίσθωση έληξε 01/07/2026',
    link: '/tenants/000000000000000000000001'
  },
  {
    code: 'holdover-lease',
    message:
      '⚠️ Μίσθωση έληξε πριν 7 ημέρες χωρίς ενέργεια (λήξη ή παράταση): ΕΝΟΙΚΟΣ ΔΟΚΙΜΗΣ',
    link: '/tenants/000000000000000000000001'
  },
  {
    code: 'unit-vacant',
    message:
      '🏠 Μονάδα Α1 (ΟΔΟΣ ΑΛΦΑ 1) έμεινε κενή — τα κοινόχρηστα βαρύνουν τον ιδιοκτήτη',
    link: '/buildings/000000000000000000000002'
  },
  {
    code: 'inbox-ttl',
    message:
      '🗑 Λογαριασμός στο κουδούνι θα διαγραφεί αυτόματα σε ~5 ημέρες (εκκρεμεί από 09/06)',
    link: ''
  }
] as const;

/** Insert notices with the EXACT shape noticeHelpers.createNotice writes. */
function seedNotices(realmId: string, codes: readonly string[]): number {
  const docs = NOTICES.filter((n) => codes.includes(n.code)).map((n) => ({
    realmId,
    source: 'system',
    status: 'pending',
    kind: 'notice',
    notice: { code: n.code, message: n.message, link: n.link },
    dedupeKey: `${TAG}:${n.code}`,
    createdDate: new Date().toISOString()
  }));
  const script = `
    var docs = ${JSON.stringify(docs)};
    docs.forEach(function (d) {
      d.realmId = ObjectId(d.realmId);
      d.createdDate = new Date(d.createdDate);
      db.inboxitems.insert(d);
    });
    print(db.inboxitems.count({ dedupeKey: /^${TAG}:/ }));
  `;
  const out = mongoExec(script);
  return out === null ? -1 : Number(String(out).trim());
}

function cleanupNotices(): void {
  mongoExec(`
    var r = db.inboxitems.deleteMany({ dedupeKey: /^${TAG}:/ });
    print('deleted=' + (r.deletedCount || 0));
  `);
}

async function signIn(page: Page) {
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 25_000 })
    .toMatch(/\/(firstaccess|dashboard)/);
}

/** Open the bell popover and return its content locator. */
async function openBell(page: Page) {
  // The trigger is the only button whose aria-label is the Notifications label
  // (Greek «Ειδοποιήσεις»); match on either locale so the spec survives a
  // realm-locale change.
  const trigger = page
    .locator('button[aria-label="Ειδοποιήσεις"], button[aria-label="Notifications"]')
    .first();
  await expect(trigger, 'bell trigger must render in the header').toBeVisible({
    timeout: 25_000
  });
  await trigger.click();
  const popover = page.locator('[data-radix-popper-content-wrapper]').first();
  await expect(popover, 'bell popover must open').toBeVisible({
    timeout: 10_000
  });
  return { trigger, popover };
}

test.afterAll(() => {
  cleanupNotices();
});

test.describe('Spec 48 — notification bell', () => {
  test('48.1 · badge counts BILLS only; notices add a dot, not a number', async ({
    page
  }) => {
    test.setTimeout(180_000);
    const api = await request.newContext();
    try {
      const { realmId } = await resolveRealm(api);
      cleanupNotices();
      // Four notices = four pending items, but ZERO actionable bills.
      const n = seedNotices(realmId, [
        'bill-due',
        'deposit-unreturned',
        'holdover-lease',
        'unit-vacant'
      ]);
      test.skip(n === -1, 'portainer token unavailable — mongo seed impossible');
      expect(n, 'four notices seeded').toBe(4);

      await signIn(page);
      const { trigger } = await openBell(page);

      // The numeric badge is bill-driven. With notices only, there must be NO
      // number — this is the regression: `count = pending.length` showed 4.
      const numericBadge = trigger.locator('span.font-mono');
      await expect(
        numericBadge,
        'notices must NOT produce a numeric badge (they are not actionable)'
      ).toHaveCount(0);

      // …but the landlord must still see that something arrived.
      const dot = trigger.locator('span.rounded-full').filter({ hasText: '' });
      await expect(
        dot,
        'a notice-only bell must still show the dot indicator'
      ).toHaveCount(1);
    } finally {
      cleanupNotices();
      await api.dispose();
    }
  });

  test('48.2 · all 8 notice codes render their Greek message', async ({
    page
  }) => {
    test.setTimeout(240_000);
    const api = await request.newContext();
    try {
      const { realmId } = await resolveRealm(api);
      cleanupNotices();
      const n = seedNotices(
        realmId,
        NOTICES.map((x) => x.code)
      );
      test.skip(n === -1, 'portainer token unavailable — mongo seed impossible');
      expect(n, 'all 8 notices seeded').toBe(8);

      await signIn(page);
      const { popover } = await openBell(page);

      // Every message must be present EXACTLY once — a duplicate would mean
      // the list is rendering an item twice.
      for (const notice of NOTICES) {
        await expect(
          popover.getByText(notice.message, { exact: true }),
          `notice ${notice.code} must render its Greek message verbatim`
        ).toHaveCount(1, { timeout: 20_000 });
      }

      // No raw interpolation placeholders and no NaN leaked into any row.
      const body = (await popover.textContent()) || '';
      expect(body, 'no unrendered {{...}} placeholder').not.toMatch(/\{\{/);
      expect(body, 'no NaN / undefined in any money figure').not.toMatch(
        /NaN|undefined/
      );
      // The header label must NOT claim pending action for notice-only content.
      expect(body, 'header must not read "8 εκκρεμούν" for pure notices').not.toMatch(
        /8\s+εκκρεμ/
      );
    } finally {
      cleanupNotices();
      await api.dispose();
    }
  });

  test('48.3 · «Άνοιγμα» navigates AND closes the popover', async ({ page }) => {
    test.setTimeout(180_000);
    const api = await request.newContext();
    try {
      const { realmId } = await resolveRealm(api);
      cleanupNotices();
      // unpaid-rents links to /rents/2026.07 — a real, zero-padded route.
      const n = seedNotices(realmId, ['unpaid-rents']);
      test.skip(n === -1, 'portainer token unavailable — mongo seed impossible');
      expect(n).toBe(1);

      await signIn(page);
      const { popover } = await openBell(page);

      const open = popover.getByRole('link', { name: /Άνοιγμα|Open/ }).first();
      await expect(open, 'the notice must offer an Open link').toHaveCount(1);
      await open.click();

      // Navigated to the rents term page…
      await expect
        .poll(() => new URL(page.url()).pathname, { timeout: 25_000 })
        .toMatch(/\/rents\/2026\.07/);

      // …and the popover must be GONE. InboxBell is mounted in Layout, outside
      // the page component, so a client-side navigation does not unmount it:
      // without an explicit close the 420px panel stayed over the target page.
      await expect(
        page.locator('[data-radix-popper-content-wrapper]'),
        'popover must close on navigate (it does not unmount itself)'
      ).toHaveCount(0, { timeout: 10_000 });
    } finally {
      cleanupNotices();
      await api.dispose();
    }
  });

  test('48.4 · dismiss removes the row and persists status:dismissed', async ({
    page
  }) => {
    test.setTimeout(180_000);
    const api = await request.newContext();
    try {
      const { realmId } = await resolveRealm(api);
      cleanupNotices();
      const n = seedNotices(realmId, ['holdover-lease', 'unit-vacant']);
      test.skip(n === -1, 'portainer token unavailable — mongo seed impossible');
      expect(n).toBe(2);

      await signIn(page);
      const { popover } = await openBell(page);

      const rows = popover.locator('button', { hasText: /Απόρριψη|Dismiss/ });
      await expect(rows, 'two dismissable notices').toHaveCount(2, {
        timeout: 20_000
      });
      await rows.first().click();

      // Value delta, not existence: one row must disappear.
      await expect(
        popover.locator('button', { hasText: /Απόρριψη|Dismiss/ }),
        'dismissing one notice leaves exactly one'
      ).toHaveCount(1, { timeout: 20_000 });

      // And the server recorded it — read the TREE, not the UI's word for it.
      const state = mongoExec(`
        var docs = db.inboxitems.find({ dedupeKey: /^${TAG}:/ },
                                      { status: 1, dedupeKey: 1 }).toArray();
        print(JSON.stringify(docs.map(function (d) {
          return { k: d.dedupeKey, s: d.status };
        })));
      `);
      const parsed = JSON.parse(String(state));
      expect(
        parsed.filter((d: { s: string }) => d.s === 'dismissed').length,
        'exactly one notice persisted as dismissed'
      ).toBe(1);
      expect(
        parsed.filter((d: { s: string }) => d.s === 'pending').length,
        'the other is still pending'
      ).toBe(1);
    } finally {
      cleanupNotices();
      await api.dispose();
    }
  });

  test('48.5 · a malformed notice (no `notice` subdoc) does not blank the bell', async ({
    page
  }) => {
    test.setTimeout(180_000);
    const api = await request.newContext();
    try {
      const { realmId } = await resolveRealm(api);
      cleanupNotices();
      const n = seedNotices(realmId, ['bill-due']);
      test.skip(n === -1, 'portainer token unavailable — mongo seed impossible');
      // A legacy/corrupt row: kind:'notice' with the subdoc missing entirely.
      mongoExec(`
        db.inboxitems.insert({
          realmId: ObjectId("${realmId}"),
          source: 'system', status: 'pending', kind: 'notice',
          dedupeKey: '${TAG}:malformed', createdDate: new Date()
        });
        print('ok');
      `);

      await signIn(page);
      const { popover } = await openBell(page);

      // The healthy notice must STILL render — a malformed sibling must not
      // take down the list (React would blank the subtree on a throw).
      await expect(
        popover.getByText(NOTICES[2].message, { exact: true }),
        'the well-formed notice renders despite a malformed sibling'
      ).toHaveCount(1, { timeout: 20_000 });
      const body = (await popover.textContent()) || '';
      expect(body, 'no error-boundary text in the popover').not.toMatch(
        /Something went wrong|Κάτι πήγε στραβά/i
      );
    } finally {
      cleanupNotices();
      await api.dispose();
    }
  });

  test('48.6 · the two removed dashboard tiles are gone', async ({ page }) => {
    test.setTimeout(180_000);
    const api = await request.newContext();
    try {
      const { realmName } = await resolveRealm(api);
      await signIn(page);
      await page.goto(`${encodeURIComponent(realmName)}/dashboard`);
      await expect
        .poll(() => new URL(page.url()).pathname, { timeout: 25_000 })
        .toContain('/dashboard');

      // Wait for the dashboard to actually render something before asserting
      // ABSENCE — otherwise an empty page trivially "passes".
      await expect(
        page.locator('main, [role=main]').first(),
        'dashboard shell must render before absence is asserted'
      ).toBeVisible({ timeout: 25_000 });

      for (const heading of [
        /^(Λήξεις μισθώσεων|Λήξη μίσθωσης|Expiring leases)$/,
        /^(Λήξη ενεργειακών πιστοποιητικών|Expiring energy certificates)$/
      ]) {
        await expect(
          page.getByText(heading, { exact: true }),
          `the removed tile (${heading}) must not render`
        ).toHaveCount(0);
      }
    } finally {
      await api.dispose();
    }
  });
});
