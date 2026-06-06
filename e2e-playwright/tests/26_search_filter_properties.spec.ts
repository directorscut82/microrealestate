/**
 * Spec 26 — Properties index search/filter catalog (11 scenarios).
 *
 * Catalog source: `.kiro/steering/test-running-guide.md` "Properties
 * index" section, scenarios 11-21.
 *
 * Search fields: name, atakNumber, address.street1, address.city,
 * surface (see webapps/landlord/src/pages/[organization]/properties/
 * index.js _filterData). Filters: vacant, occupied, plus property-type
 * chips (apartment, store, parking, garage, ...).
 */
import { expect, request, test, Page } from '@playwright/test';
import {
  ensureSeed,
  ensureSeedLeasedTenant,
  ensureSeedProperty
} from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD');
  }
});

async function signIn(page: Page) {
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
    .toMatch(/\/(firstaccess|dashboard)/);
}

async function gotoProperties(page: Page, realmName: string) {
  await page.goto(`${encodeURIComponent(realmName)}/properties`);
  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toBeVisible({ timeout: 20_000 });
  // First property card visible (data-cy=openResourceButton on every
  // PropertyListItem button).
  await expect(
    page.locator('[data-cy=openResourceButton]').first()
  ).toBeVisible({ timeout: 15_000 });
}

function propertyCard(page: Page, name: string) {
  // The property name renders as a div inside the openResourceButton button.
  // Use exact text match to avoid prefix collisions (E2E-Property vs
  // E2E-Property-B).
  return page
    .locator('[data-cy=openResourceButton]')
    .filter({ has: page.locator(`div:text-is("${name}")`) });
}

async function clickFilterChip(page: Page, chipLabel: RegExp) {
  await page.getByRole('button', { name: /Filters|Φίλτρα/i }).first().click();
  await page.locator('li[role=menuitemcheckbox]', { hasText: chipLabel }).first().click();
  await page.keyboard.press('Escape');
}

/**
 * Ensures a property exists with very specific identifying fields so the
 * search-by-X scenarios have a guaranteed-unique target. Idempotent.
 */
async function ensureSearchableProperty(
  apiCtx: import('@playwright/test').APIRequestContext,
  realmId: string,
  token: string,
  fields: {
    name: string;
    atakNumber: string;
    street1: string;
    surface: number;
  }
): Promise<{ _id: string }> {
  const auth = {
    Authorization: `Bearer ${token}`,
    organizationid: realmId,
    'Content-Type': 'application/json'
  };
  const list = (await (
    await apiCtx.get(`${GATEWAY}/api/v2/properties`, { headers: auth })
  ).json()) as Array<{
    _id: string;
    name: string;
    atakNumber?: string;
  }>;
  let prop = list.find((p) => p.name === fields.name);
  if (!prop) {
    const created = await apiCtx.post(`${GATEWAY}/api/v2/properties`, {
      headers: auth,
      data: {
        name: fields.name,
        type: 'apartment',
        rent: 0,
        surface: fields.surface,
        atakNumber: fields.atakNumber,
        address: {
          street1: fields.street1,
          city: 'Test',
          zipCode: '00000'
        }
      }
    });
    expect(
      [200, 201],
      `create property ${fields.name} (status=${created.status()})`
    ).toContain(created.status());
    prop = (await created.json()) as { _id: string; name: string };
  } else {
    // PATCH to make sure the searchable fields are current.
    const patched = await apiCtx.patch(
      `${GATEWAY}/api/v2/properties/${prop._id}`,
      {
        headers: auth,
        data: {
          name: fields.name,
          atakNumber: fields.atakNumber,
          surface: fields.surface,
          address: { street1: fields.street1, city: 'Test', zipCode: '00000' }
        }
      }
    );
    if (patched.status() >= 400) {
      console.warn(
        `[26] PATCH searchable property failed status=${patched.status()}`
      );
    }
  }
  return { _id: prop._id };
}

test('26.11 search 4 chars of property name narrows to that property', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeed(apiCtx);
  // Use a unique 6-letter token so we can search a 4-char substring
  // that won't collide with E2E-Property / E2E-Property-B.
  const tag = 'NMQX' + Math.random().toString(36).slice(2, 4).toUpperCase();
  await ensureSearchableProperty(apiCtx, seed.realmId, seed.token, {
    name: `E2E-${tag}-Name`,
    atakNumber: `${tag}-AT`,
    street1: `${tag}-Street`,
    surface: 77
  });
  await apiCtx.dispose();

  await signIn(page);
  await gotoProperties(page, seed.realmName);

  // Search 4 chars of name.
  await page.locator('[data-cy=globalSearchField]').fill(tag.slice(0, 4));

  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 15_000 });
});

test('26.12 search 4 chars of atakNumber narrows the list', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeed(apiCtx);
  const tag = 'ATKQ' + Math.random().toString(36).slice(2, 4).toUpperCase();
  await ensureSearchableProperty(apiCtx, seed.realmId, seed.token, {
    name: `E2E-${tag}-Name`,
    atakNumber: `${tag}-ATAK`,
    street1: 'AnyStreet',
    surface: 50
  });
  await apiCtx.dispose();

  await signIn(page);
  await gotoProperties(page, seed.realmName);

  await page.locator('[data-cy=globalSearchField]').fill(tag.slice(0, 4));

  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 15_000 });
});

test('26.13 search 4 chars of address.street1 narrows the list', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeed(apiCtx);
  const tag = 'STRZ' + Math.random().toString(36).slice(2, 4).toUpperCase();
  await ensureSearchableProperty(apiCtx, seed.realmId, seed.token, {
    name: `E2E-${tag}-Name`,
    atakNumber: `${tag}-AT`,
    // Street name carries the unique tag — we'll search a 4-char prefix.
    street1: `${tag}-Avenue`,
    surface: 60
  });
  await apiCtx.dispose();

  await signIn(page);
  await gotoProperties(page, seed.realmName);

  await page.locator('[data-cy=globalSearchField]').fill(tag.slice(0, 4));

  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 15_000 });
});

test('26.14 search a 2-digit surface value narrows the list', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeed(apiCtx);
  // Pick a unique 2-digit surface unlikely to collide with the canonical
  // E2E-Property (surface=50) or E2E-Property-B (60). 87 is safe.
  const surfaceVal = 87;
  await ensureSearchableProperty(apiCtx, seed.realmId, seed.token, {
    name: 'E2E-S87-Name',
    atakNumber: 'S87-AT',
    street1: 'S87-Street',
    surface: surfaceVal
  });
  await apiCtx.dispose();

  await signIn(page);
  await gotoProperties(page, seed.realmName);

  await page.locator('[data-cy=globalSearchField]').fill(String(surfaceVal));

  // At least 1 row matches; the canonical 50-surface and B (60) properties
  // must NOT.
  const cards = page.locator('[data-cy=openResourceButton]');
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });
  await expect(cards).toHaveCount(1, { timeout: 15_000 });
});

test('26.15 "Vacant" filter chip → only properties with status=vacant', async ({
  page
}) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  // ensureSeedLeasedTenant assigns the canonical E2E-Property to a tenant,
  // so it should be 'occupied' (status=rented internally → 'occupied' chip).
  // We need at least 1 vacant property to assert non-zero match: the seed
  // already creates E2E-Property which is vacant unless leased — so use
  // ensureSeedProperty (no lease) here.
  const seed = await ensureSeedProperty(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoProperties(page, seed.realmName);

  const before = await page.locator('[data-cy=openResourceButton]').count();
  expect(before).toBeGreaterThan(0);

  await clickFilterChip(page, /Vacant|Διαθέσιμο|Διαθέσιμα/i);

  // At least 1 vacant property; count ≤ before.
  const after = await page
    .locator('[data-cy=openResourceButton]')
    .count();
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThanOrEqual(before);
  // Every visible card must show "Vacant" badge.
  const vacantBadges = page
    .locator('[data-cy=openResourceButton]')
    .locator('text=/Vacant|Διαθέσιμο/i');
  await expect(vacantBadges).toHaveCount(after);
});

test('26.16 "Rented" filter chip → only occupied properties', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  // The leased tenant seed assigns E2E-Property to a tenant.
  const seed = await ensureSeedLeasedTenant(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoProperties(page, seed.realmName);

  const before = await page.locator('[data-cy=openResourceButton]').count();
  expect(before).toBeGreaterThan(0);

  await clickFilterChip(page, /Rented|Μισθωμένο|Μισθωμένα|Occupied/i);

  const after = await page
    .locator('[data-cy=openResourceButton]')
    .count();
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThanOrEqual(before);
});

test('26.17 type-filter chip ("apartment") narrows to that type', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedProperty(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoProperties(page, seed.realmName);

  const before = await page.locator('[data-cy=openResourceButton]').count();
  expect(before).toBeGreaterThan(0);

  // The "apartment" filter chip's label is the translation of the
  // labelId in webapps/landlord/src/components/properties/types.js.
  await clickFilterChip(page, /Apartment|Διαμέρισμα/i);

  const after = await page
    .locator('[data-cy=openResourceButton]')
    .count();
  // 1+ apartments expected (E2E-Property is type=apartment).
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThanOrEqual(before);
});

test('26.18 multiple filter chips compose (multi-select OR within type bucket)', async ({
  page
}) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedProperty(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoProperties(page, seed.realmName);

  const before = await page.locator('[data-cy=openResourceButton]').count();
  expect(before).toBeGreaterThan(0);

  // Pick "Vacant" + "Rented" — selecting both status filters should
  // produce union (every property is either vacant or rented). The
  // _filterData OR's within statusFilters but apartment-type chips are
  // a separate bucket. Union of all two statuses ≈ before.
  await clickFilterChip(page, /Vacant|Διαθέσιμο|Διαθέσιμα/i);
  await clickFilterChip(page, /Rented|Μισθωμένο|Μισθωμένα|Occupied/i);

  const after = await page
    .locator('[data-cy=openResourceButton]')
    .count();
  // With both chips on, count == before (every property fits one of
  // the two categories).
  expect(after).toBe(before);
});

test('26.19 search + filter chip both apply (intersection narrows further)', async ({
  page
}) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedLeasedTenant(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoProperties(page, seed.realmName);

  // Search the canonical property's name.
  await page.locator('[data-cy=globalSearchField]').fill('E2E-Property');
  // Could match E2E-Property and E2E-Property-B if both exist; combining with
  // "Rented" chip narrows further (only the occupied ones).
  const searchOnly = await page
    .locator('[data-cy=openResourceButton]')
    .count();
  expect(searchOnly).toBeGreaterThan(0);

  await clickFilterChip(page, /Rented|Μισθωμένο|Μισθωμένα|Occupied/i);

  const after = await page
    .locator('[data-cy=openResourceButton]')
    .count();
  // Intersection ≤ search-only count.
  expect(after).toBeLessThanOrEqual(searchOnly);
});

test('26.20 search persists across navigate-into-detail then Back', async ({
  page
}) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedProperty(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoProperties(page, seed.realmName);

  await page.locator('[data-cy=globalSearchField]').fill('E2E-Property');
  await expect(
    page.locator('[data-cy=openResourceButton]').first()
  ).toBeVisible({ timeout: 15_000 });
  const before = await page.locator('[data-cy=openResourceButton]').count();
  expect(before).toBeGreaterThan(0);

  // Click into the first matching property.
  await page.locator('[data-cy=openResourceButton]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
    .toMatch(/\/properties\/[a-f0-9]{24}/);

  await page.goBack();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
    .toMatch(/\/properties$/);

  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toHaveValue('E2E-Property', { timeout: 15_000 });
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(before, { timeout: 15_000 });
});

test('26.21 search holds across a window-focus refetch', async ({ page, context }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeedProperty(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoProperties(page, seed.realmName);

  await page.locator('[data-cy=globalSearchField]').fill('E2E-Property');
  await expect(
    page.locator('[data-cy=openResourceButton]').first()
  ).toBeVisible({ timeout: 15_000 });
  const before = await page.locator('[data-cy=openResourceButton]').count();

  // Trigger refetch by focus-toggling.
  const aux = await context.newPage();
  await aux.goto('about:blank');
  await aux.bringToFront();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toHaveValue('E2E-Property');
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(before, { timeout: 15_000 });

  await aux.close();
});
