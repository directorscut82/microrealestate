/**
 * THE LISTS FIND A GREEK NAME TYPED WITH ITS ACCENT («Ενοίκια», «Ενοικιαστές», «Κτίρια»).
 *
 * Names are stored in capitals without accents, as the tax office prints them
 * («ΔΟΚΙΜΟΠΟΥΛΟΣ», «ΟΔΟΣ ΑΛΦΑ»); Greek is typed with them («Δοκιμόπουλος», «οδός άλφα»).
 * Until 2026-11 every list compared after lower-casing and turning ς into σ but kept the
 * accent, so «δοκιμόπουλος» never found «ΔΟΚΙΜΟΠΟΥΛΟΣ» and the list came up empty.
 *
 * ONE TENANT with a lease that began this month, in ONE BUILDING. Each test types the name
 * the way it is written on paper:
 *   · the capitals the name is stored in — found (it was found before too: the fixture
 *     is on the screen at all);
 *   · «δοκιμόπουλος» / «οδός άλφα» — exactly one row carries the fixture name, and the
 *     «nothing found» sentence is not on the screen;
 *   · before each of them, a name that is NOT in the list, with an accent — no row, the
 *     sentence is on the screen (a search that matched everything would pass the steps
 *     above, and a row left over from the search before would pass them too).
 *
 * Self-cleaning: the tenant, the apartment and the building are removed before and after
 * the run, and the run fails if one is left. Every identifier is from the reserved
 * synthetic bands.
 */
import { expect, request, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { ensureSeedLease, LeaseSeed } from './lib/api';
import {
  createBillBuilding,
  createLedgerTenant,
  monthRef,
  removeLedgerFixtures,
  rentRow,
  serverAndBrowserAgreeOnTheMonth,
  signIn
} from './lib/ledger';

const GATEWAY = process.env.NAS_GATEWAY_URL as string;
const CURRENT = monthRef(0);
const F = {
  tenant: 'E2E-ΤΟΝΟΣ ΔΟΚΙΜΟΠΟΥΛΟΣ ΑΛΦΑ',
  apartment: 'E2E-ΤΟΝΟΣ ΔΙΑΜΕΡΙΣΜΑ',
  building: 'E2E-ΤΟΝΟΣ ΟΔΟΣ ΑΛΦΑ'
};
const FIXTURES = {
  tenants: [F.tenant],
  buildings: [F.building],
  properties: [F.apartment]
};

test.describe.configure({ timeout: 5 * 60_000 });

let seed: LeaseSeed;

const search = (page: Page) => page.locator('[data-cy=globalSearchField]');
const enc = encodeURIComponent;
/** A name that no fixture and no real record is called, with an accent on it. */
const NOT_THERE = 'ζωνόχωρα';

/** The names of this spec's fixtures that the realm still has (archived tenants included). */
async function leftOver(): Promise<string[]> {
  const api = await request.newContext();
  const headers = {
    Authorization: `Bearer ${seed.token}`,
    organizationid: seed.realmId
  };
  const left: string[] = [];
  for (const [resource, names] of [
    ['tenants?includeArchived=true', FIXTURES.tenants],
    ['buildings', FIXTURES.buildings],
    ['properties', FIXTURES.properties]
  ] as const) {
    const r = await api.get(`${GATEWAY}/api/v2/${resource}`, { headers });
    expect(r.status(), `list ${resource}`).toBe(200);
    const body = await r.json();
    const rows = (Array.isArray(body) ? body : body.items || []) as Array<{
      name: string;
    }>;
    left.push(...rows.filter((x) => names.includes(x.name)).map((x) => x.name));
  }
  await api.dispose();
  return left;
}

test.beforeAll(async () => {
  test.setTimeout(5 * 60_000);
  test.skip(
    !serverAndBrowserAgreeOnTheMonth(),
    'Month boundary: the server (UTC) and the browser (local time) disagree on which month is current.'
  );
  if (!process.env.TEST_EMAIL || !process.env.TEST_PASSWORD) {
    throw new Error(
      'Missing TEST_EMAIL/TEST_PASSWORD. Expected .secrets/cypress-test-account.'
    );
  }
  const api = await request.newContext();
  seed = await ensureSeedLease(api);
  await removeLedgerFixtures(api, seed, FIXTURES);

  const tenant = await createLedgerTenant(api, seed, {
    tenantName: F.tenant,
    propertyName: F.apartment,
    afmFirst8: '99900030',
    rent: 400,
    monthsBack: 0
  });
  await createBillBuilding(api, seed, {
    name: F.building,
    atakPrefix: '999781',
    propertyIds: [tenant.propertyId],
    expenseName: 'E2E-ΤΟΝΟΣ ΔΕΗ',
    billingId: '999781001',
    startTerm: CURRENT.term
  });
  await api.dispose();
});

test.afterAll(async () => {
  if (!seed) return;
  const api = await request.newContext();
  await removeLedgerFixtures(api, seed, FIXTURES);
  await api.dispose();
  expect(await leftOver(), 'fixtures left in the realm').toEqual([]);
});

/**
 * Type `typed` into the search of the page and expect exactly one row carrying the fixture
 * name and no «nothing found» sentence. A name that is not in the list is typed first: the
 * list is empty (and says so) before `typed` is typed, so a row seen afterwards was
 * brought back by THIS search and not left over from the one before it.
 */
async function typedFinds(
  page: Page,
  typed: string,
  rows: Locator,
  nothingFound: string
): Promise<void> {
  const sentence = page.getByText(nothingFound, { exact: true });
  await search(page).fill(NOT_THERE);
  await expect(rows, `no row after «${NOT_THERE}»`).toHaveCount(0, {
    timeout: 60_000
  });
  await expect(sentence, `«${nothingFound}» after «${NOT_THERE}»`).toHaveCount(
    1
  );

  await search(page).fill(typed);
  await expect(
    rows,
    `rows carrying the fixture name after «${typed}»`
  ).toHaveCount(1, { timeout: 60_000 });
  await expect(sentence, `«${nothingFound}» after «${typed}»`).toHaveCount(0);
}

test('Ενοίκια: «δοκιμόπουλος» finds ΔΟΚΙΜΟΠΟΥΛΟΣ', async ({ page }) => {
  const NOTHING = 'Δεν βρέθηκαν ενοίκια';
  await signIn(page);
  await page.goto(`el/${enc(seed.realmName)}/rents/${CURRENT.ym}`);
  const rows = rentRow(page, F.tenant);

  await typedFinds(page, 'ΔΟΚΙΜΟΠΟΥΛΟΣ', rows, NOTHING);
  await typedFinds(page, 'δοκιμόπουλος', rows, NOTHING);
  await typedFinds(page, 'Δοκιμόπουλος Άλφα', rows, NOTHING);
});

test('Ενοικιαστές: «δοκιμόπουλος» finds ΔΟΚΙΜΟΠΟΥΛΟΣ', async ({ page }) => {
  const NOTHING = 'Δεν βρέθηκαν ενοικιαστές';
  await signIn(page);
  await page.goto(`el/${enc(seed.realmName)}/tenants`);
  const rows = page.locator(
    `[data-cy=openResourceButton]:text-is("${F.tenant}")`
  );

  await typedFinds(page, 'ΔΟΚΙΜΟΠΟΥΛΟΣ', rows, NOTHING);
  await typedFinds(page, 'δοκιμόπουλος', rows, NOTHING);
  await typedFinds(page, 'Δοκιμόπουλος Άλφα', rows, NOTHING);
});

test('Κτίρια: «οδός άλφα» finds ΟΔΟΣ ΑΛΦΑ', async ({ page }) => {
  const NOTHING = 'Δεν βρέθηκαν κτίρια';
  await signIn(page);
  await page.goto(`el/${enc(seed.realmName)}/buildings`);
  const rows = page
    .locator('[data-cy=openResourceButton]')
    .filter({ has: page.locator(`div.font-medium:text-is("${F.building}")`) });

  await typedFinds(page, 'ΟΔΟΣ ΑΛΦΑ', rows, NOTHING);
  await typedFinds(page, 'οδός άλφα', rows, NOTHING);
  await typedFinds(page, 'Οδός  Άλφα', rows, NOTHING);
});
