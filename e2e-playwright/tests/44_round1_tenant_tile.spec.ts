/**
 * Round-1 — TenantListItem tile UI coverage.
 *
 * Surface under test: webapps/landlord/src/components/tenants/TenantListItem.js
 *
 * The tile is the per-tenant card on /tenants. It shows:
 *   1. A "Missing fields" footer with outline-amber Badge per gap when any
 *      of {firstName, lastName, company, legalForm, taxId} are absent or
 *      taxId is present-but-checksum-invalid (badge label "Tax ID
 *      (invalid)").
 *   2. A 3-state lease pill (data-lease-state ∈ {terminated, future,
 *      running}) anchored at the bottom-right with a coloured dot
 *      (grey/amber/olive).
 *   3. A click-anywhere navigation to /[org]/tenants/:id.
 *   4. Greek-locale labels (no English bleed) when the URL path or realm
 *      locale resolves to el.
 *
 * Discipline:
 *  - Live NAS only (CYPRESS-TEST-DO-NOT-USE realm).
 *  - The API rejects POST /tenants payloads missing firstName/lastName/
 *    taxId/legalForm at create time (Tier A1, occupantmanager.ts:916-952),
 *    so we cannot use the API to seed "tenant with missing firstName".
 *    Instead we POST a valid baseline (so the tenant has the canonical
 *    schema shape — name, contacts, history, etc.) and then mongoExec a
 *    `$unset` / `$set` to mutate the doc into the target state. This
 *    matches the spec-19 / verifyT2 pattern and stays within the realm.
 *  - Each fixture name is unique per run (Date.now() suffix) so leftover
 *    fixtures from prior failed runs cannot collide on substring search.
 *  - afterAll bulk-deletes by id; we do NOT rely on the canonical
 *    E2E-LeasedTenant for any of the 12 cases (the running-tenant case
 *    uses a disposable fixture too) so the fixture realm stays stable
 *    for downstream specs.
 *  - Search the tenants index by exact name (`hasText: name + exact`) to
 *    isolate the fixture; the page paginates and other tenants in this
 *    realm carry the E2E- prefix.
 *
 * Test-id shape on the tile (from TenantListItem.js):
 *  - `[data-cy=tenantMissingFields]` wraps the missing-field footer; its
 *    `data-missing-fields` attribute carries a comma-joined list of the
 *    raw keys (`firstName`, `lastName`, `company`, `legalForm`, `taxId`,
 *    `taxIdInvalid`).
 *  - `[data-lease-state]` lives on the pill; values: terminated | future
 *    | running.
 *  - `[data-cy=openResourceButton]` is the title link.
 */
import { expect, request, test } from '@playwright/test';
import type {
  APIRequestContext,
  Locator,
  Page
} from '@playwright/test';
import { ensureSeed } from './lib/api';
import { mongoExec } from './lib/mongoExec';

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';
const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

// Per-run suffix so fixtures don't collide across reruns / leaked state.
const RUN = Date.now().toString(36);

// One namespace, fixture name = `${PREFIX}-<role>-${RUN}`.
const PREFIX = 'E2E-R44';

interface Fixture {
  id: string;
  name: string;
}

interface SeedHandles {
  token: string;
  realmId: string;
  realmName: string;
}

let _seed: SeedHandles | null = null;
const _fixtures: Fixture[] = [];

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

test.beforeAll(async () => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD');
  }
  const apiCtx = await request.newContext();
  const seed = await ensureSeed(apiCtx);
  _seed = {
    token: seed.token,
    realmId: seed.realmId,
    realmName: seed.realmName
  };
  await apiCtx.dispose();
});

test.afterAll(async () => {
  if (!_seed || _fixtures.length === 0) return;
  const apiCtx = await request.newContext();
  try {
    // Bulk-delete via the array endpoint. If a tenant has rents (none of
    // ours do — they're created with no leaseId), the API may 422. We
    // try once and best-effort log; the unique RUN suffix keeps stale
    // fixtures from snowballing across runs even if cleanup is missed.
    const ids = _fixtures.map((f) => f.id);
    const r = await apiCtx.delete(`${GATEWAY}/api/v2/tenants`, {
      headers: {
        Authorization: `Bearer ${_seed.token}`,
        organizationid: _seed.realmId,
        'Content-Type': 'application/json'
      },
      data: { ids }
    });
    if (r.status() !== 200 && r.status() !== 204) {
      // Not fatal; just log so a human notices in the report.
      const body = await r.text().catch(() => '');
      // eslint-disable-next-line no-console
      console.warn(
        `[44_round1_tenant_tile] cleanup DELETE ${ids.length} ids returned ${r.status()}: ${body}`
      );
    }
  } finally {
    await apiCtx.dispose();
  }
});

/**
 * Sign in via the form, asserting the post-redirect lands on
 * /firstaccess|/dashboard. Mirrors the canonical pattern in spec 30.
 */
async function signIn(page: Page): Promise<void> {
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
    .toMatch(/\/(firstaccess|dashboard)/);
}

/**
 * Build a baseline POST payload that satisfies Tier A1 server validation
 * (firstName + lastName + taxId for naturals; company + legalForm + taxId
 * for legal entities). taxId here is a checksum-valid Greek AFM
 * (123456784: 1*256+2*128+...+8*2 = 1004; 1004 % 11 = 4; check digit 4).
 */
function validNaturalPayload(name: string) {
  return {
    name,
    firstName: 'Round1',
    lastName: name,
    taxId: '123456784',
    isCompany: false,
    manager: name,
    contacts: [
      { contact: name, email: '', phone: '', phone1: '6900000000', phone2: '' }
    ]
  };
}

function validCompanyPayload(name: string) {
  return {
    name,
    company: name,
    legalForm: 'AE',
    taxId: '123456784',
    isCompany: true,
    manager: name,
    contacts: [
      { contact: name, email: '', phone: '', phone1: '6900000000', phone2: '' }
    ]
  };
}

/**
 * Create a tenant via API (with a fully-valid baseline that passes Tier
 * A1), then optionally mutate the document via mongoExec to put it into
 * the target test state. Returns { id, name }.
 *
 * `mutate` is a string of mongo update operators (interior of an
 * updateOne second arg). Example: `{$unset: {firstName: ''}}`.
 */
async function makeFixture(
  api: APIRequestContext,
  role: string,
  payload: object,
  mutate?: string
): Promise<Fixture> {
  if (!_seed) throw new Error('seed not initialised');
  const name = `${PREFIX}-${role}-${RUN}`;
  const created = await api.post(`${GATEWAY}/api/v2/tenants`, {
    headers: {
      Authorization: `Bearer ${_seed.token}`,
      organizationid: _seed.realmId,
      'Content-Type': 'application/json'
    },
    data: { ...payload, name }
  });
  expect(
    [200, 201],
    `create fixture ${role} (status=${created.status()}, body: ${await created
      .text()
      .catch(() => '')})`
  ).toContain(created.status());
  const body = (await created.json()) as { _id: string; name?: string };
  expect(body._id, `fixture ${role} _id`).toBeTruthy();
  const fixture: Fixture = { id: body._id, name };
  _fixtures.push(fixture);
  if (mutate) {
    // mongoExec returns null when no portainer-token is present (CI
    // dry-run). The spec is intended for live NAS only; bail with a
    // clear message rather than running tests against an unmutated
    // fixture and producing a confusing tautology pass.
    const out = mongoExec(
      `db.occupants.updateOne({_id: ObjectId('${body._id}')}, ${mutate});`
    );
    if (out === null) {
      throw new Error(
        'mongoExec unavailable (no portainer-token); this spec requires live NAS access'
      );
    }
  }
  return fixture;
}

/**
 * Navigate to /tenants and use the search box to filter to the fixture
 * by exact name. Returns the Card root locator. The page paginates and
 * other E2E- tenants share the prefix, so substring-match alone would
 * sometimes lock onto the wrong card; we feed the unique RUN suffix as
 * the search term.
 */
async function findTenantTile(
  page: Page,
  realmName: string,
  fixture: Fixture
): Promise<Locator> {
  // Use the realm's locale-default route (matches the realm's stored
  // locale, which is el for the test realm). Tests #1-#11 don't care
  // about the prefix; test #12 asserts the el path explicitly.
  await page.goto(`${encodeURIComponent(realmName)}/tenants`);

  const search = page
    .locator('input[placeholder*="Search" i], input[placeholder*="Αναζήτηση" i], input[type=search]')
    .first();
  await expect(search).toBeVisible({ timeout: 15_000 });
  await search.fill(RUN);

  // The list is rendered as Cards; the title is in [data-cy=openResourceButton].
  // Anchor on exact-text match of the fixture name and ascend to the Card.
  const title = page.locator('[data-cy=openResourceButton]', {
    hasText: new RegExp(`^${fixture.name.replace(/[-]/g, '\\-')}$`)
  });
  await expect(
    title,
    `tile for ${fixture.name} must appear after filtering`
  ).toBeVisible({ timeout: 15_000 });
  // Ascend to the Card root (rounded-lg + border, shadcn pattern, same
  // ascent strategy as spec 30's expensesCard helper).
  return title.locator(
    'xpath=ancestor::div[contains(@class, "rounded-lg") and contains(@class, "border")][1]'
  );
}

/**
 * Read the missing-fields data attribute off the tile. Returns the
 * comma-joined list of raw keys, or '' when the footer is not present.
 */
async function missingFieldsKeys(card: Locator): Promise<string> {
  const footer = card.locator('[data-cy=tenantMissingFields]');
  if ((await footer.count()) === 0) return '';
  return (await footer.getAttribute('data-missing-fields')) ?? '';
}

// ============================================================
// Test 1: natural person missing firstName → "First name" badge
// ============================================================
test('44.1 — natural person missing firstName surfaces "First name" badge', async ({
  page
}) => {
  const apiCtx = await request.newContext();
  const fx = await makeFixture(
    apiCtx,
    'NoFirst',
    validNaturalPayload(`${PREFIX}-NoFirst-${RUN}`),
    `{$unset: {firstName: ''}}`
  );
  await apiCtx.dispose();

  await signIn(page);
  const card = await findTenantTile(page, _seed!.realmName, fx);
  const keys = await missingFieldsKeys(card);
  expect(keys.split(','), 'data-missing-fields contains firstName').toContain(
    'firstName'
  );
  // Badge label is locale-dependent (el: "Όνομα", en: "First name").
  // Anchor on either; the realm is el so we expect the Greek label.
  const firstNameBadge = card
    .locator('[data-cy=tenantMissingFields]')
    .getByText(/^(First name|Όνομα)$/);
  await expect(firstNameBadge, '"First name" badge present').toBeVisible();
  // Outline-amber styling — class includes border-amber-500 (per
  // TenantListItem.js:173).
  await expect(firstNameBadge).toHaveClass(/border-amber-500/);
});

// ============================================================
// Test 2: natural person missing lastName → "Last name" badge
// ============================================================
test('44.2 — natural person missing lastName surfaces "Last name" badge', async ({
  page
}) => {
  const apiCtx = await request.newContext();
  const fx = await makeFixture(
    apiCtx,
    'NoLast',
    validNaturalPayload(`${PREFIX}-NoLast-${RUN}`),
    `{$unset: {lastName: ''}}`
  );
  await apiCtx.dispose();

  await signIn(page);
  const card = await findTenantTile(page, _seed!.realmName, fx);
  const keys = await missingFieldsKeys(card);
  expect(keys.split(','), 'data-missing-fields contains lastName').toContain(
    'lastName'
  );
  const lastNameBadge = card
    .locator('[data-cy=tenantMissingFields]')
    .getByText(/^(Last name|Επώνυμο)$/);
  await expect(lastNameBadge, '"Last name" badge present').toBeVisible();
  await expect(lastNameBadge).toHaveClass(/border-amber-500/);
});

// ============================================================
// Test 3: natural person missing taxId → "Tax ID" badge
// ============================================================
test('44.3 — natural person missing taxId surfaces "Tax ID" badge', async ({
  page
}) => {
  const apiCtx = await request.newContext();
  const fx = await makeFixture(
    apiCtx,
    'NoTax',
    validNaturalPayload(`${PREFIX}-NoTax-${RUN}`),
    `{$unset: {taxId: ''}}`
  );
  await apiCtx.dispose();

  await signIn(page);
  const card = await findTenantTile(page, _seed!.realmName, fx);
  const keys = await missingFieldsKeys(card);
  expect(keys.split(','), 'data-missing-fields contains taxId').toContain(
    'taxId'
  );
  // The "Tax ID" label and "Tax ID (invalid)" label are distinguishable —
  // assert the bare label, not the (invalid) variant. Use a closed-form
  // regex anchor so "Tax ID" doesn't also match "Tax ID (invalid)".
  const taxIdBadge = card
    .locator('[data-cy=tenantMissingFields]')
    .getByText(/^(Tax ID|ΑΦΜ)$/);
  await expect(taxIdBadge, '"Tax ID" badge present').toBeVisible();
  await expect(taxIdBadge).toHaveClass(/border-amber-500/);
  // Belt-and-braces: the (invalid) variant must NOT also be on this card
  // (it's mutually exclusive with "missing" in the missingFields reducer).
  await expect(
    card.locator('[data-cy=tenantMissingFields]').getByText(/\(invalid\)|μη έγκυρο/)
  ).toHaveCount(0);
});

// ============================================================
// Test 4: natural person with taxId="123" → "Tax ID (invalid)" badge
// ============================================================
test('44.4 — natural person with malformed taxId surfaces "Tax ID (invalid)" badge', async ({
  page
}) => {
  const apiCtx = await request.newContext();
  const fx = await makeFixture(
    apiCtx,
    'BadTax',
    validNaturalPayload(`${PREFIX}-BadTax-${RUN}`),
    `{$set: {taxId: '123'}}`
  );
  await apiCtx.dispose();

  await signIn(page);
  const card = await findTenantTile(page, _seed!.realmName, fx);
  const keys = await missingFieldsKeys(card);
  expect(
    keys.split(','),
    'data-missing-fields contains taxIdInvalid'
  ).toContain('taxIdInvalid');
  expect(
    keys.split(','),
    'taxId (missing) and taxIdInvalid are mutually exclusive in this case'
  ).not.toContain('taxId');
  const invalidBadge = card
    .locator('[data-cy=tenantMissingFields]')
    .getByText(/^(Tax ID \(invalid\)|ΑΦΜ \(μη έγκυρο\))$/);
  await expect(invalidBadge, '"Tax ID (invalid)" badge present').toBeVisible();
  await expect(invalidBadge).toHaveClass(/border-amber-500/);
});

// ============================================================
// Test 5: natural person with valid AFM → no missing-fields warnings
// ============================================================
test('44.5 — natural person with valid taxId checksum has no missing-fields footer', async ({
  page
}) => {
  // Baseline payload already carries taxId=123456784 (valid checksum).
  // No mutate — the fixture should have all natural-person fields populated.
  const apiCtx = await request.newContext();
  const fx = await makeFixture(
    apiCtx,
    'Clean',
    validNaturalPayload(`${PREFIX}-Clean-${RUN}`)
  );
  await apiCtx.dispose();

  await signIn(page);
  const card = await findTenantTile(page, _seed!.realmName, fx);

  // The footer is conditionally rendered (only when missingFields.length > 0).
  // Use toHaveCount(0) — toBeVisible() can't assert "must not exist".
  await expect(
    card.locator('[data-cy=tenantMissingFields]'),
    'missing-fields footer must NOT render for a tenant with all required fields'
  ).toHaveCount(0);
});

// ============================================================
// Test 6: company missing legalForm → "Legal structure" badge
// ============================================================
test('44.6 — company missing legalForm surfaces "Legal structure" badge', async ({
  page
}) => {
  const apiCtx = await request.newContext();
  const fx = await makeFixture(
    apiCtx,
    'CoNoLegal',
    validCompanyPayload(`${PREFIX}-CoNoLegal-${RUN}`),
    `{$unset: {legalForm: ''}}`
  );
  await apiCtx.dispose();

  await signIn(page);
  const card = await findTenantTile(page, _seed!.realmName, fx);
  const keys = await missingFieldsKeys(card);
  expect(keys.split(','), 'data-missing-fields contains legalForm').toContain(
    'legalForm'
  );
  const legalBadge = card
    .locator('[data-cy=tenantMissingFields]')
    .getByText(/^(Legal structure|Νομική μορφή)$/);
  await expect(legalBadge, '"Legal structure" badge present').toBeVisible();
  await expect(legalBadge).toHaveClass(/border-amber-500/);
});

// ============================================================
// Test 7: company missing company name → "Company" badge
// ============================================================
test('44.7 — company missing company name surfaces "Company" badge', async ({
  page
}) => {
  const apiCtx = await request.newContext();
  // The Card title falls back to tenant.name when company is empty;
  // because the company-payload sets name = company at the API layer
  // (_formatTenant), the saved doc has name = company. We $unset
  // `company` (not `name`) so the tile still has a stable title to
  // search on, and the missingFields reducer flags the gap.
  const fx = await makeFixture(
    apiCtx,
    'CoNoName',
    validCompanyPayload(`${PREFIX}-CoNoName-${RUN}`),
    `{$unset: {company: ''}}`
  );
  await apiCtx.dispose();

  await signIn(page);
  const card = await findTenantTile(page, _seed!.realmName, fx);
  const keys = await missingFieldsKeys(card);
  expect(keys.split(','), 'data-missing-fields contains company').toContain(
    'company'
  );
  const companyBadge = card
    .locator('[data-cy=tenantMissingFields]')
    .getByText(/^(Company|Εταιρεία)$/);
  await expect(companyBadge, '"Company" badge present').toBeVisible();
  await expect(companyBadge).toHaveClass(/border-amber-500/);
});

// ============================================================
// Test 8: terminated tenant → "Lease ended" pill (terminated/grey)
// ============================================================
test('44.8 — terminated tenant pill is "Lease ended" with grey dot', async ({
  page
}) => {
  // To reach `tenant.terminated === true`, frontdata.toOccupantData
  // checks endMoment.isBefore(today) on terminationDate || endDate
  // (frontdata.ts:445-451). Setting terminationDate = yesterday in
  // DD/MM/YYYY format is the cleanest path — bypasses the API
  // validators that may force schema-ish dates.
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dd = String(yesterday.getUTCDate()).padStart(2, '0');
  const mm = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = yesterday.getUTCFullYear();
  const termDate = `${dd}/${mm}/${yyyy}`;

  const apiCtx = await request.newContext();
  const fx = await makeFixture(
    apiCtx,
    'Term',
    validNaturalPayload(`${PREFIX}-Term-${RUN}`),
    `{$set: {terminationDate: '${termDate}'}}`
  );
  await apiCtx.dispose();

  await signIn(page);
  const card = await findTenantTile(page, _seed!.realmName, fx);
  const pill = card.locator('[data-lease-state]');
  await expect(pill, 'pill present on tile').toHaveCount(1);
  await expect(pill).toHaveAttribute('data-lease-state', 'terminated');
  // Greek/English label — anchor on either.
  await expect(pill).toHaveText(/Lease ended|Η μίσθωση έληξε/);
  // Coloured dot — for terminated state the inner span has bg-ink-muted.
  const dot = pill.locator('span[aria-hidden="true"]').first();
  await expect(dot).toHaveClass(/bg-ink-muted/);
});

// ============================================================
// Test 9: future-start tenant → "Lease starts in the future" pill amber
// ============================================================
test('44.9 — future-start tenant pill is "Lease starts in the future" with amber dot', async ({
  page
}) => {
  // beginDate must be after `moment().startOf('day')` (per
  // TenantListItem.js:95-97). 30 days in the future is safe regardless
  // of timezone wraparound. The endDate must come AFTER beginDate or
  // frontdata.terminated derivation will flip — so push endDate further.
  const futureBegin = new Date();
  futureBegin.setUTCDate(futureBegin.getUTCDate() + 30);
  const futureEnd = new Date();
  futureEnd.setUTCDate(futureEnd.getUTCDate() + 365);
  const fmt = (d: Date) => {
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getUTCFullYear()}`;
  };
  const beginDDMM = fmt(futureBegin);
  const endDDMM = fmt(futureEnd);

  const apiCtx = await request.newContext();
  const fx = await makeFixture(
    apiCtx,
    'Future',
    validNaturalPayload(`${PREFIX}-Future-${RUN}`),
    `{$set: {beginDate: '${beginDDMM}', endDate: '${endDDMM}'}}`
  );
  await apiCtx.dispose();

  await signIn(page);
  const card = await findTenantTile(page, _seed!.realmName, fx);
  const pill = card.locator('[data-lease-state]');
  await expect(pill, 'pill present on tile').toHaveCount(1);
  await expect(pill).toHaveAttribute('data-lease-state', 'future');
  await expect(pill).toHaveText(
    /Lease starts in the future|Μελλοντική μίσθωση/
  );
  const dot = pill.locator('span[aria-hidden="true"]').first();
  await expect(dot).toHaveClass(/bg-amber-500/);
});

// ============================================================
// Test 10: running tenant → "Lease running" pill olive
// ============================================================
test('44.10 — running tenant pill is "Lease running" with olive dot', async ({
  page
}) => {
  // beginDate in the past, endDate in the future, no terminationDate.
  const past = new Date();
  past.setUTCDate(past.getUTCDate() - 30);
  const future = new Date();
  future.setUTCDate(future.getUTCDate() + 365);
  const fmt = (d: Date) => {
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getUTCFullYear()}`;
  };
  const beginDDMM = fmt(past);
  const endDDMM = fmt(future);

  const apiCtx = await request.newContext();
  const fx = await makeFixture(
    apiCtx,
    'Run',
    validNaturalPayload(`${PREFIX}-Run-${RUN}`),
    `{$set: {beginDate: '${beginDDMM}', endDate: '${endDDMM}'}}`
  );
  await apiCtx.dispose();

  await signIn(page);
  const card = await findTenantTile(page, _seed!.realmName, fx);
  const pill = card.locator('[data-lease-state]');
  await expect(pill, 'pill present on tile').toHaveCount(1);
  await expect(pill).toHaveAttribute('data-lease-state', 'running');
  await expect(pill).toHaveText(/Lease running|Μίσθωση σε ισχύ/);
  const dot = pill.locator('span[aria-hidden="true"]').first();
  await expect(dot).toHaveClass(/bg-olive/);
});

// ============================================================
// Test 11: click tile → navigates to /tenants/[id]
// ============================================================
test('44.11 — clicking the tile navigates to /[org]/tenants/:id', async ({
  page
}) => {
  // Reuse a clean fixture (no mutate) so the tile is in the "running"
  // state with all fields populated — minimal noise around the
  // navigation assertion.
  const apiCtx = await request.newContext();
  const fx = await makeFixture(
    apiCtx,
    'Click',
    validNaturalPayload(`${PREFIX}-Click-${RUN}`)
  );
  await apiCtx.dispose();

  await signIn(page);
  const card = await findTenantTile(page, _seed!.realmName, fx);
  // The CardHeader and CardContent both bind onClick → handleClick.
  // Click the tenant title link (data-cy=openResourceButton) — that's
  // the most stable hit-target the user actually targets when picking
  // a tenant out of the list.
  await card.locator('[data-cy=openResourceButton]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
    .toMatch(new RegExp(`/tenants/${fx.id}(?:[/?#]|$)`));
});

// ============================================================
// Test 12: Greek locale → all badge labels are Greek (no English bleed)
// ============================================================
test('44.12 — Greek locale renders Greek badge labels with no English bleed', async ({
  page
}) => {
  // Build a fixture that triggers ALL three label classes at once:
  //   - "First name" badge (firstName missing)
  //   - "Tax ID (invalid)" badge (taxId malformed)
  //   - "Lease ended" pill (terminationDate yesterday)
  // Asserting Greek strings on this single tile is the strongest single
  // probe against a regression where a missing translation falls back
  // to the English key.
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dd = String(yesterday.getUTCDate()).padStart(2, '0');
  const mm = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = yesterday.getUTCFullYear();
  const termDate = `${dd}/${mm}/${yyyy}`;

  const apiCtx = await request.newContext();
  const fx = await makeFixture(
    apiCtx,
    'Greek',
    validNaturalPayload(`${PREFIX}-Greek-${RUN}`),
    `{$unset: {firstName: ''}, $set: {taxId: '123', terminationDate: '${termDate}'}}`
  );
  await apiCtx.dispose();

  await signIn(page);
  // Force the el locale prefix on the URL so this test is a hard probe
  // against the Greek bundle (mirrors the _tierB_tile_warnings approach
  // and the _regression_i18n_probe pattern).
  const baseUrl = page.url();
  const baseOrigin = new URL(baseUrl).origin;
  const orgPath = encodeURIComponent(_seed!.realmName);
  await page.goto(`${baseOrigin}/landlord/el/${orgPath}/tenants`, {
    waitUntil: 'domcontentloaded'
  });
  const search = page
    .locator('input[placeholder*="Search" i], input[placeholder*="Αναζήτηση" i], input[type=search]')
    .first();
  await expect(search).toBeVisible({ timeout: 15_000 });
  await search.fill(RUN);
  const title = page.locator('[data-cy=openResourceButton]', {
    hasText: new RegExp(`^${fx.name.replace(/[-]/g, '\\-')}$`)
  });
  await expect(title).toBeVisible({ timeout: 15_000 });
  const card = title.locator(
    'xpath=ancestor::div[contains(@class, "rounded-lg") and contains(@class, "border")][1]'
  );

  // 1. The "Missing fields:" label (CardFooter prefix).
  const footer = card.locator('[data-cy=tenantMissingFields]');
  await expect(footer, 'missing-fields footer present').toHaveCount(1);
  await expect(footer).toContainText('Λείπουν στοιχεία');

  // 2. Greek badges present.
  await expect(
    footer.getByText('Όνομα', { exact: true }),
    '"Όνομα" (First name) badge present'
  ).toBeVisible();
  await expect(
    footer.getByText('ΑΦΜ (μη έγκυρο)', { exact: true }),
    '"ΑΦΜ (μη έγκυρο)" (Tax ID invalid) badge present'
  ).toBeVisible();

  // 3. Lease pill in Greek.
  const pill = card.locator('[data-lease-state]');
  await expect(pill).toHaveAttribute('data-lease-state', 'terminated');
  await expect(pill).toContainText('Η μίσθωση έληξε');

  // 4. NO English bleed — the English variants of any of the strings on
  // this tile must NOT be present. Scope the assertion to the card so
  // we don't accidentally catch unrelated English bleed elsewhere on
  // the page.
  const englishStrings = [
    'First name',
    'Tax ID (invalid)',
    'Lease ended',
    'Missing fields'
  ];
  for (const en of englishStrings) {
    await expect(
      card.getByText(en, { exact: true }),
      `English string "${en}" must NOT appear on Greek-locale tile`
    ).toHaveCount(0);
  }
});
