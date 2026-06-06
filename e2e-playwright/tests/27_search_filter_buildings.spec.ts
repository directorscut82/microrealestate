/**
 * Spec 27 — Buildings index search/filter catalog (7 scenarios).
 *
 * Catalog source: `.kiro/steering/test-running-guide.md` "Buildings
 * index" section, scenarios 22-28.
 *
 * Search fields: name, description, address.street1, address.city.
 * Filters: hasElevator, hasCentralHeating.
 */
import { expect, request, test, Page } from '@playwright/test';
import { ensureSeed } from './lib/api';

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

async function gotoBuildings(page: Page, realmName: string) {
  await page.goto(`${encodeURIComponent(realmName)}/buildings`);
  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.locator('[data-cy=openResourceButton]').first()
  ).toBeVisible({ timeout: 15_000 });
}

async function clickFilterChip(page: Page, chipLabel: RegExp) {
  await page.getByRole('button', { name: /Filters|Φίλτρα/i }).first().click();
  await page.locator('li[role=menuitemcheckbox]', { hasText: chipLabel }).first().click();
  await page.keyboard.press('Escape');
}

/**
 * Ensures a building exists with the supplied identifying fields.
 * Idempotent — finds by atakPrefix uniqueness, PATCHes to refresh the
 * fields each run.
 */
async function ensureSearchableBuilding(
  apiCtx: import('@playwright/test').APIRequestContext,
  realmId: string,
  token: string,
  fields: {
    name: string;
    atakPrefix: string;
    street1?: string;
    city?: string;
    hasElevator?: boolean;
    hasCentralHeating?: boolean;
  }
): Promise<{ _id: string }> {
  const auth = {
    Authorization: `Bearer ${token}`,
    organizationid: realmId,
    'Content-Type': 'application/json'
  };
  const list = (await (
    await apiCtx.get(`${GATEWAY}/api/v2/buildings`, { headers: auth })
  ).json()) as Array<{
    _id: string;
    name: string;
    atakPrefix?: string;
  }>;
  let bld = list.find((b) => b.atakPrefix === fields.atakPrefix);
  if (!bld) {
    const created = await apiCtx.post(`${GATEWAY}/api/v2/buildings`, {
      headers: auth,
      data: {
        name: fields.name,
        atakPrefix: fields.atakPrefix,
        address: {
          street1: fields.street1 || 'Test',
          city: fields.city || 'Test',
          zipCode: '00000'
        },
        ...(fields.hasElevator !== undefined && { hasElevator: fields.hasElevator }),
        ...(fields.hasCentralHeating !== undefined && {
          hasCentralHeating: fields.hasCentralHeating
        })
      }
    });
    expect(
      [200, 201],
      `create building ${fields.name} (status=${created.status()}, body: ${await created.text().catch(() => '')})`
    ).toContain(created.status());
    bld = (await created.json()) as { _id: string; name: string };
  } else {
    const patched = await apiCtx.patch(
      `${GATEWAY}/api/v2/buildings/${bld._id}`,
      {
        headers: auth,
        data: {
          name: fields.name,
          atakPrefix: fields.atakPrefix,
          address: {
            street1: fields.street1 || 'Test',
            city: fields.city || 'Test',
            zipCode: '00000'
          },
          ...(fields.hasElevator !== undefined && { hasElevator: fields.hasElevator }),
          ...(fields.hasCentralHeating !== undefined && {
            hasCentralHeating: fields.hasCentralHeating
          })
        }
      }
    );
    if (patched.status() >= 400) {
      console.warn(
        `[27] PATCH searchable building ${fields.name} failed status=${patched.status()}`
      );
    }
  }
  return { _id: bld._id };
}

test('27.22 search 3 chars of building name narrows the list', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeed(apiCtx);
  // Unique tag in the building name.
  const tag = 'BNM' + Math.random().toString(36).slice(2, 4).toUpperCase();
  await ensureSearchableBuilding(apiCtx, seed.realmId, seed.token, {
    name: `E2E-${tag}-Building`,
    atakPrefix: `${tag}AT`
  });
  await apiCtx.dispose();

  await signIn(page);
  await gotoBuildings(page, seed.realmName);

  await page.locator('[data-cy=globalSearchField]').fill(tag);

  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 15_000 });
});

test('27.23 search by city narrows the list', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeed(apiCtx);
  // Unique city tag (3 letters, hex-random suffix).
  const cityTag = 'CTYZK' + Math.random().toString(36).slice(2, 4).toUpperCase();
  await ensureSearchableBuilding(apiCtx, seed.realmId, seed.token, {
    name: `E2E-${cityTag}-CityBld`,
    atakPrefix: `${cityTag}AT`,
    city: cityTag
  });
  await apiCtx.dispose();

  await signIn(page);
  await gotoBuildings(page, seed.realmName);

  await page.locator('[data-cy=globalSearchField]').fill(cityTag);

  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 15_000 });
});

test('27.24 "Has elevator" filter chip narrows to elevator-equipped buildings', async ({
  page
}) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeed(apiCtx);
  // Ensure exactly one building with hasElevator=true exists.
  await ensureSearchableBuilding(apiCtx, seed.realmId, seed.token, {
    name: 'E2E-EL1-Building',
    atakPrefix: 'EL1AT',
    hasElevator: true,
    hasCentralHeating: false
  });
  await apiCtx.dispose();

  await signIn(page);
  await gotoBuildings(page, seed.realmName);

  const before = await page.locator('[data-cy=openResourceButton]').count();
  expect(before).toBeGreaterThan(0);

  await clickFilterChip(page, /Has elevator|Έχει ασανσέρ|ασανσέρ/i);

  const after = await page.locator('[data-cy=openResourceButton]').count();
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThanOrEqual(before);
});

test('27.25 "Has central heating" filter chip narrows to heated buildings', async ({
  page
}) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeed(apiCtx);
  await ensureSearchableBuilding(apiCtx, seed.realmId, seed.token, {
    name: 'E2E-CH1-Building',
    atakPrefix: 'CH1AT',
    hasElevator: false,
    hasCentralHeating: true
  });
  await apiCtx.dispose();

  await signIn(page);
  await gotoBuildings(page, seed.realmName);

  const before = await page.locator('[data-cy=openResourceButton]').count();
  expect(before).toBeGreaterThan(0);

  await clickFilterChip(page, /Has heating|Has central heating|θέρμανση/i);

  const after = await page.locator('[data-cy=openResourceButton]').count();
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThanOrEqual(before);
});

test('27.26 elevator+heating chips → intersection (AND in _filterData)', async ({
  page
}) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeed(apiCtx);
  // Need at least one building with BOTH chips true (else the
  // intersection is 0 and the spec is vacuous). Seed it.
  await ensureSearchableBuilding(apiCtx, seed.realmId, seed.token, {
    name: 'E2E-FULL-Building',
    atakPrefix: 'FULLAT',
    hasElevator: true,
    hasCentralHeating: true
  });
  await apiCtx.dispose();

  await signIn(page);
  await gotoBuildings(page, seed.realmName);

  const before = await page.locator('[data-cy=openResourceButton]').count();
  expect(before).toBeGreaterThan(0);

  await clickFilterChip(page, /Has elevator|Έχει ασανσέρ|ασανσέρ/i);
  const afterElevator = await page
    .locator('[data-cy=openResourceButton]')
    .count();

  await clickFilterChip(page, /Has heating|Has central heating|θέρμανση/i);
  const afterBoth = await page
    .locator('[data-cy=openResourceButton]')
    .count();

  // Intersection: buildings with BOTH attrs ≤ either single filter.
  expect(afterBoth).toBeGreaterThan(0);
  expect(afterBoth).toBeLessThanOrEqual(afterElevator);
});

test('27.27 search + chip both apply (intersection narrows further)', async ({
  page
}) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeed(apiCtx);
  // The fixture from 27.24 may already exist; ensure it idempotently.
  await ensureSearchableBuilding(apiCtx, seed.realmId, seed.token, {
    name: 'E2E-EL1-Building',
    atakPrefix: 'EL1AT',
    hasElevator: true
  });
  await apiCtx.dispose();

  await signIn(page);
  await gotoBuildings(page, seed.realmName);

  await page.locator('[data-cy=globalSearchField]').fill('E2E-EL1');
  // 1 row matches the search.
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 15_000 });

  // Adding the elevator chip keeps it (the seeded building has elevator).
  await clickFilterChip(page, /Has elevator|Έχει ασανσέρ|ασανσέρ/i);
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(1, { timeout: 10_000 });
});

test('27.28 search holds across a window-focus refetch', async ({ page, context }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const seed = await ensureSeed(apiCtx);
  await apiCtx.dispose();

  await signIn(page);
  await gotoBuildings(page, seed.realmName);

  // Search a substring guaranteed to match the canonical E2E-Building.
  await page.locator('[data-cy=globalSearchField]').fill('E2E');
  await expect(
    page.locator('[data-cy=openResourceButton]').first()
  ).toBeVisible({ timeout: 15_000 });
  const before = await page.locator('[data-cy=openResourceButton]').count();
  expect(before).toBeGreaterThan(0);

  const aux = await context.newPage();
  await aux.goto('about:blank');
  await aux.bringToFront();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  await expect(
    page.locator('[data-cy=globalSearchField]')
  ).toHaveValue('E2E');
  await expect(
    page.locator('[data-cy=openResourceButton]')
  ).toHaveCount(before, { timeout: 15_000 });

  await aux.close();
});
