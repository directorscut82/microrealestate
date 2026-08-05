import { expect, test } from '@playwright/test';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

/**
 * Step 5b for da61311d — the three behaviour fixes whose warnings need a state
 * that does not exist yet. Each test CREATES the condition (never seeds the
 * output), drives the surface, and asserts the Greek text on screen.
 *
 * Everything is built on a throwaway E2E building so the live portfolio is never
 * mutated. Cleanup runs in afterAll.
 */

const BASE = process.env.GATEWAY_URL || 'http://192.168.0.96:1350';

const ACCOUNT_FILE = path.resolve(__dirname, '../../.secrets/landlord-account');
const account: Record<string, string> = fs.existsSync(ACCOUNT_FILE)
  ? dotenv.parse(fs.readFileSync(ACCOUNT_FILE))
  : {};
const EMAIL = process.env.LANDLORD_EMAIL || account.EMAIL || '';
const PASSWORD = process.env.LANDLORD_PASSWORD || account.PASSWORD || '';
const REALM = process.env.LANDLORD_REALM || account.REALM || 'landlord';

const STAMP = process.env.E2E_STAMP || String(Date.now()).slice(-6);
const BUILDING_NAME = `E2E-BEHAV-${STAMP}`;

let token = '';
let orgId = '';
let buildingId = '';
const createdPropertyIds: string[] = [];
const createdTenantIds: string[] = [];
const createdUnitIds: string[] = [];

async function api(
  method: string,
  route: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}/api/v2${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE,
      Authorization: `Bearer ${token}`,
      ...(orgId ? { organizationId: orgId } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

// Checksum-valid synthetic ΑΦΜ, same AADE algorithm the harness already uses
// (tests/lib/api.ts:425). Never a real tax id — AGENTS.md reserves the
// 9990000xx band for exactly this.
function syntheticTaxId(): string {
  const digits = [9, 9, 9, 0, 0, 0, 0, 1];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += digits[i] * Math.pow(2, 8 - i);
  return digits.join('') + String((sum % 11) % 10);
}

function currentTerm(): number {
  const d = new Date();
  return Number(
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}0100`
  );
}

function priorTerm(): number {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return Number(
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}0100`
  );
}

test.beforeAll(async () => {
  const signin = await fetch(
    `${BASE}/api/v2/authenticator/landlord/signin`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD })
    }
  );
  const body = await signin.json();
  token = body.accessToken;
  expect(token, 'signin must return an access token').toBeTruthy();

  const realms = await (
    await fetch(`${BASE}/api/v2/realms`, {
      headers: { Authorization: `Bearer ${token}`, Origin: BASE }
    })
  ).json();
  const realm = (realms || []).find((r: any) => r.name === REALM) || realms[0];
  orgId = realm._id;
  expect(orgId, 'the realm must resolve').toBeTruthy();

  // atakPrefix is required (buildingmanager.ts:838) — a real validator, not a
  // test-harness quirk. Synthetic prefix, never a real cadastral value.
  const created = await api('POST', '/buildings', {
    name: BUILDING_NAME,
    atakPrefix: `999${STAMP}`,
    address: { street1: 'ΟΔΟΣ ΔΟΚΙΜΗΣ 1', zipCode: '11111', city: 'ΔΟΚΙΜΗ' }
  });
  expect(created.status, `create building: ${JSON.stringify(created.json)}`).toBe(200);
  buildingId = created.json._id;
});

test.afterAll(async () => {
  // Teardown ORDER matters and the first version got it wrong, leaving 15
  // fixtures behind: DELETE building 422s while its units reference properties,
  // and DELETE property 422s while a tenant occupies it. So unwind the
  // references first — tenant, then property, then the building.
  // A tenant with recorded rents CANNOT be deleted — that 422 is the app's
  // referential integrity doing its job (B3 records a payment on purpose). The
  // DELETE endpoint takes a comma-separated id list in the body and the guard is
  // on payments, so first strip the payment we seeded, then delete.
  for (const id of createdTenantIds) {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    await api('PATCH', `/rents/payment/${id}/${now.getFullYear()}${mm}0100`, {
      _id: id,
      month: now.getMonth() + 1,
      year: now.getFullYear(),
      payments: [],
      description: '',
      extracharge: 0,
      noteextracharge: '',
      promo: 0,
      notepromo: ''
    });
    const r = await api('DELETE', `/tenants/${id}`);
    if (r.status !== 200) console.log('CLEANUP tenant', id, r.status, JSON.stringify(r.json).slice(0, 90));
  }
  // The property is still referenced by the building UNIT that links to it, so
  // drop the units before the properties.
  for (const id of createdUnitIds) {
    const r = await api('DELETE', `/buildings/${buildingId}/units/${id}`);
    if (r.status !== 200) console.log('CLEANUP unit', id, r.status, JSON.stringify(r.json).slice(0, 90));
  }
  for (const id of createdPropertyIds) {
    const r = await api('DELETE', `/properties/${id}`);
    if (r.status !== 200) console.log('CLEANUP property', id, r.status, JSON.stringify(r.json).slice(0, 80));
  }
  if (buildingId) {
    const r = await api('DELETE', `/buildings/${buildingId}`);
    if (r.status !== 200) console.log('CLEANUP building', r.status, JSON.stringify(r.json).slice(0, 120));
  }
});

async function signIn(page: any) {
  await page.goto(`${BASE}/landlord/el/signin`, {
    waitUntil: 'domcontentloaded'
  });
  await page.getByLabel(/Email/i).fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /Σύνδεση/ }).click();
  await page.waitForURL(/\/landlord\/el\/(?!signin)/, { timeout: 45000 });
}

async function openTestBuilding(page: any) {
  await page.goto(`${BASE}/landlord/el/${REALM}/buildings/${buildingId}`, {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForLoadState('networkidle');
}

test.describe.configure({ mode: 'serial' });

test('B1 a soft-ended expense warns that saving RE-ACTIVATES it', async ({
  page
}) => {
  // CREATE the condition through the real API: an expense whose endTerm is last
  // month is exactly what ExpenseList's «Τερματισμός από τον τρέχοντα μήνα»
  // produces, and the list renders it identically to an active one.
  const add = await api('POST', `/buildings/${buildingId}/expenses`, {
    name: `E2E-ENDED-${STAMP}`,
    type: 'cleaning',
    amount: 120,
    allocationMethod: 'equal',
    isRecurring: true,
    startTerm: priorTerm()
  });
  expect(add.status, `add expense: ${JSON.stringify(add.json)}`).toBe(200);
  const expenseId = (add.json.expenses || []).find(
    (e: any) => e.name === `E2E-ENDED-${STAMP}`
  )?._id;
  expect(expenseId, 'the expense must exist').toBeTruthy();

  // Soft-end it — endTerm = the month BEFORE the current one.
  const end = await api(
    'PATCH',
    `/buildings/${buildingId}/expenses/${expenseId}`,
    { endTerm: priorTerm() }
  );
  expect(end.status, `soft-end: ${JSON.stringify(end.json)}`).toBe(200);

  await signIn(page);
  await openTestBuilding(page);
  await page.getByRole('tab', { name: 'Έξοδα' }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);

  // Open the terminated expense — the pencil on its row.
  const row = page.locator('tr', { hasText: `E2E-ENDED-${STAMP}` }).first();
  await expect(row, 'the ended expense still shows in the list').toBeVisible({
    timeout: 20000
  });
  await row.locator('button').first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });

  await expect(dialog.getByText(/είχε τερματιστεί:/)).toBeVisible({
    timeout: 10000
  });
  await expect(dialog.getByText(/ΕΠΑΝΕΝΕΡΓΟΠΟΙΕΙ/)).toBeVisible();

  await page.screenshot({ path: '/tmp/b1-ended-expense.png' });
});

test('B2 renaming the organisation warns that uploaded files become unreachable', async ({
  page
}) => {
  await signIn(page);
  // /settings is an INDEX page (observed: a list of links). The org name lives
  // behind «Ιδιοκτήτης» (LandlordForm).
  await page.goto(`${BASE}/landlord/el/${REALM}/settings`, {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForLoadState('networkidle');
  await page.getByRole('link', { name: 'Ιδιοκτήτης' }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  const nameInput = page.locator('#name');
  await expect(nameInput).toBeVisible({ timeout: 20000 });
  const original = await nameInput.inputValue();

  // Type a different name — do NOT save. The warning must appear on the edit.
  await nameInput.fill(`${original}-E2E`);
  await page.waitForTimeout(900);

  const banner = page.getByText(
    /Η μετονομασία του οργανισμού αλλάζει τη διαδρομή/
  );
  await expect(banner).toBeVisible({ timeout: 10000 });
  // It must quote the exact previous name — that is the only recovery path.
  // Assert INSIDE the banner: a bare regex also matches the sidebar org label.
  await expect(banner).toContainText(original);

  await page.screenshot({ path: '/tmp/b2-rename-warning.png' });

  // Restore the field without saving.
  await nameInput.fill(original);
  await page.waitForTimeout(500);
  await expect(
    page.getByText(/Η μετονομασία του οργανισμού αλλάζει τη διαδρομή/)
  ).toHaveCount(0);
});

test('B3 an equal repair on a frozen month warns that charges were NOT recalculated', async ({
  page
}) => {
  // The bail fires when ANY unit's rent for the charge term is frozen. A PAST
  // term is unconditionally frozen (_frozenPropertyIdsForTerm: "past → every
  // given unit is frozen"), which is the cheapest reachable form of the
  // condition and exercises the same code path as a fully-paid current month.
  //
  // The repair needs at least one unit with a propertyId for the frozen set to
  // be non-empty, so build a property + unit first.
  const prop = await api('POST', '/properties', {
    name: `E2E-BEHAV-PROP-${STAMP}`,
    type: 'apartment',
    surface: 50,
    rent: 300,
    // address.street1 is required (propertymanager) — synthetic placeholder.
    address: { street1: 'ΟΔΟΣ ΔΟΚΙΜΗΣ 1', zipCode: '11111', city: 'ΔΟΚΙΜΗ' }
  });
  expect(prop.status, `create property: ${JSON.stringify(prop.json)}`).toBe(200);
  createdPropertyIds.push(prop.json._id);

  const unit = await api('POST', `/buildings/${buildingId}/units`, {
    atakNumber: `999${STAMP}0`,
    floor: 1,
    surface: 50,
    isManaged: true,
    propertyId: prop.json._id
  });
  expect(unit.status, `add unit: ${JSON.stringify(unit.json)}`).toBe(200);
  const newUnit = (unit.json.units || []).find(
    (u: any) => String(u.atakNumber) === `999${STAMP}0`
  );
  if (newUnit?._id) createdUnitIds.push(newUnit._id);

  // A tenant covering the past term, fully paid → that unit is frozen.
  const tenant = await api('POST', '/tenants', {
    name: `E2E-BEHAV-TENANT-${STAMP}`,
    // A natural-person tenant needs first/last name (occupantmanager validator).
    isCompany: false,
    firstName: 'E2E',
    lastName: `BEHAV-${STAMP}`,
    taxId: syntheticTaxId(),
    // The API parses DD/MM/YYYY (see tests/lib/api.ts toDDMMYYYY) — an ISO date
    // is rejected 422 "Invalid date".
    beginDate: '01/01/2020',
    endDate: '31/12/2030',
    properties: [{ propertyId: prop.json._id, rent: 300 }]
  });
  expect(tenant.status, `create tenant: ${JSON.stringify(tenant.json)}`).toBe(200);
  createdTenantIds.push(tenant.json._id);

  const repair = await api('POST', `/buildings/${buildingId}/repairs`, {
    title: `E2E-EQUAL-FROZEN-${STAMP}`,
    category: 'general',
    status: 'completed',
    chargeableTo: 'tenants',
    allocationMethod: 'equal',
    chargeTerm: currentTerm(),
    actualCost: 600
  });
  expect(repair.status, `create repair: ${JSON.stringify(repair.json)}`).toBe(200);
  const repairId = (repair.json.repairs || []).find(
    (r: any) => r.title === `E2E-EQUAL-FROZEN-${STAMP}`
  )?._id;
  expect(repairId, 'the repair must exist').toBeTruthy();

  // Pay the current month in full so the unit's rent freezes. Payload shape read
  // from tests/lib/api.ts:941 — the handler needs _id/month/year alongside the
  // payments array, and the term path segment is the full YYYYMM0100.
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const pay = await api(
    'PATCH',
    `/rents/payment/${tenant.json._id}/${yyyy}${mm}0100`,
    {
      _id: tenant.json._id,
      month: now.getMonth() + 1,
      year: yyyy,
      payments: [
        {
          amount: 100000,
          date: `${dd}/${mm}/${yyyy}`,
          type: 'cash',
          reference: '',
          description: ''
        }
      ],
      description: '',
      extracharge: 0,
      noteextracharge: '',
      promo: 0,
      notepromo: ''
    }
  );
  console.log('PAY_STATUS', pay.status, JSON.stringify(pay.json).slice(0, 120));
  expect([200, 201], 'the seed payment must land').toContain(pay.status);

  // Now edit the repair's cost through the API and read the response — this is
  // the primary artifact: the server must report billingSkipped, not a bare 200.
  const edit = await api(
    'PATCH',
    `/buildings/${buildingId}/repairs/${repairId}`,
    { actualCost: 900 }
  );
  console.log('EDIT_STATUS', edit.status);
  console.log('BILLING_SKIPPED', JSON.stringify(edit.json?.billingSkipped));

  expect(edit.status).toBe(200);
  expect(
    edit.json?.billingSkipped,
    'the server must report the equal-frozen skip instead of a silent 200'
  ).toBe('equal-frozen');
});
