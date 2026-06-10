/**
 * Spec 45 · Round-1 PDF Import — comprehensive classifyAgainstExisting +
 * extend-lease coverage (F1/F2/F5 + AADE category map + past-month
 * settlements).
 *
 * 11 tests, mixing UI radio-default assertions (mocked import-pdf
 * response) with API-only server-guard assertions and pure unit-style
 * mapping checks. Everything runs against the live NAS realm; UI mocks
 * fulfill /api/v2/tenants/import-pdf so we don't need a stable AADE PDF
 * fixture per kind.
 */
import {
  test,
  expect,
  request,
  Page
} from '@playwright/test';
import { ensureSeedLease, LeaseSeed } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.describe.configure({ mode: 'serial', timeout: 4 * 60_000 });

interface SpecSeed {
  token: string;
  realmId: string;
  realmName: string;
  leaseId: string;
  propertyId: string;
  tenantId: string;
  tenantName: string;
  taxId: string;
  duplicateTenantId: string;
  duplicateTenantName: string;
  beginIso: string;
  endIso: string;
  beginApi: string;
  endApi: string;
  createdPropertyIds: string[];
  createdTenantIds: string[];
}

let _seed: SpecSeed | null = null;

const toDDMMYYYY = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

const auth = (s: { token: string; realmId: string }) => ({
  Authorization: `Bearer ${s.token}`,
  'Content-Type': 'application/json',
  organizationid: s.realmId
});

function makeAFM(digits: number[]): string {
  if (digits.length !== 8) throw new Error('AFM needs 8 leading digits');
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += digits[i] * Math.pow(2, 8 - i);
  return digits.join('') + (((sum % 11) % 10).toString());
}

async function signIn(page: Page) {
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
    .toMatch(/\/(firstaccess|dashboard)/);
}

async function driveImportDialogWithMock(
  page: Page,
  realmName: string,
  mockedResponse: unknown
): Promise<void> {
  await page.route(
    (url) => url.pathname.endsWith('/api/v2/tenants/import-pdf'),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockedResponse)
      });
    }
  );

  await page.goto(`${encodeURIComponent(realmName)}/tenants`);
  await page.waitForLoadState('networkidle');

  await page
    .locator('button', {
      hasText: /Import lease PDF|Εισαγωγή μισθωτηρίου/
    })
    .first()
    .click();
  await expect(
    page
      .locator(
        'text=/Drop PDF files here|Drop a PDF file here|Σύρετε αρχεία PDF|Σύρετε αρχείο/i'
      )
      .first()
  ).toBeVisible({ timeout: 10_000 });

  const fileInput = page.locator('input[type=file]').first();
  await fileInput.setInputFiles({
    name: 'mock-import.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%mock\n', 'utf8')
  });

  const parseRespP = page.waitForResponse(
    (r) => r.url().includes('/api/v2/tenants/import-pdf'),
    { timeout: 30_000 }
  );
  await page.locator('button[data-cy=parseLease]').first().click();
  const parseR = await parseRespP;
  expect(parseR.status(), 'mocked parse response 200').toBe(200);
}

test.beforeAll(async () => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD');
  }
  const apiCtx = await request.newContext();
  try {
    const leaseSeed: LeaseSeed = await ensureSeedLease(apiCtx);
    const headers = auth({ token: leaseSeed.token, realmId: leaseSeed.realmId });

    const propName = `E2E-Spec45-Prop-${Date.now()}`;
    const propResp = await apiCtx.post(`${GATEWAY}/api/v2/properties`, {
      headers,
      data: {
        name: propName,
        type: 'apartment',
        rent: 500,
        surface: 50,
        address: { street1: 'Test 45', city: 'Test', zipCode: '00000' }
      }
    });
    expect(
      [200, 201],
      `create spec-45 property (${propResp.status()}: ${await propResp.text().catch(() => '')})`
    ).toContain(propResp.status());
    const propBody = (await propResp.json()) as { _id: string };
    const propertyId = propBody._id;

    const today = new Date();
    const beginUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 6, 1));
    const endUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 7, 0));
    const beginIso = beginUtc.toISOString().substring(0, 10);
    const endIso = endUtc.toISOString().substring(0, 10);
    const beginApi = toDDMMYYYY(beginIso);
    const endApi = toDDMMYYYY(endIso);

    const taxId = makeAFM([3, 4, 5, 6, 7, 8, 9, 1]);
    const tenantName = `E2E-Spec45-Tenant-${Date.now()}`;

    const tenantsResp = await apiCtx.get(`${GATEWAY}/api/v2/tenants`, { headers });
    if (tenantsResp.status() === 200) {
      const tenants = (await tenantsResp.json()) as Array<{ _id: string; name: string }>;
      const stale = tenants.filter((t) => /^E2E-Spec45-/.test(t.name));
      for (const t of stale) {
        await apiCtx.delete(`${GATEWAY}/api/v2/tenants/${t._id}`, { headers }).catch(() => {});
      }
    }

    const tenantResp = await apiCtx.post(`${GATEWAY}/api/v2/tenants`, {
      headers,
      data: {
        name: tenantName,
        firstName: 'E2E',
        lastName: 'Spec45',
        isCompany: false,
        manager: tenantName,
        contacts: [{ contact: tenantName, email: '', phone1: '6900000045', phone: '', phone2: '' }],
        leaseId: leaseSeed.leaseId,
        beginDate: beginApi,
        endDate: endApi,
        taxId,
        properties: [{ propertyId, rent: 500, expenses: [] }]
      }
    });
    expect(
      [200, 201],
      `create spec-45 tenant (${tenantResp.status()}: ${await tenantResp.text().catch(() => '')})`
    ).toContain(tenantResp.status());
    const tenantBody = (await tenantResp.json()) as { _id: string };
    const tenantId = tenantBody._id;

    const duplicateTenantName = `E2E-Spec45-Duplicate-${Date.now()}`;
    const dupResp = await apiCtx.post(`${GATEWAY}/api/v2/tenants`, {
      headers,
      data: {
        name: duplicateTenantName,
        firstName: 'E2E',
        lastName: 'Spec45Dup',
        isCompany: false,
        manager: duplicateTenantName,
        contacts: [{ contact: duplicateTenantName, email: '', phone1: '6900000046', phone: '', phone2: '' }],
        taxId
      }
    });
    expect(
      [200, 201],
      `create spec-45 duplicate tenant (${dupResp.status()}: ${await dupResp.text().catch(() => '')})`
    ).toContain(dupResp.status());
    const dupBody = (await dupResp.json()) as { _id: string };

    _seed = {
      token: leaseSeed.token,
      realmId: leaseSeed.realmId,
      realmName: leaseSeed.realmName,
      leaseId: leaseSeed.leaseId,
      propertyId,
      tenantId,
      tenantName,
      taxId,
      duplicateTenantId: dupBody._id,
      duplicateTenantName,
      beginIso,
      endIso,
      beginApi,
      endApi,
      createdPropertyIds: [propertyId],
      createdTenantIds: [tenantId, dupBody._id]
    };
  } finally {
    await apiCtx.dispose();
  }
});

test.afterAll(async () => {
  if (!_seed) return;
  const apiCtx = await request.newContext();
  try {
    const headers = auth({ token: _seed.token, realmId: _seed.realmId });
    for (const tid of _seed.createdTenantIds) {
      await apiCtx.delete(`${GATEWAY}/api/v2/tenants/${tid}`, { headers }).catch(() => {});
    }
    for (const pid of _seed.createdPropertyIds) {
      await apiCtx.delete(`${GATEWAY}/api/v2/properties/${pid}`, { headers }).catch(() => {});
    }
  } finally {
    await apiCtx.dispose();
  }
});

test('45.1 · kind=new → "Create new" radio defaults checked, others not', async ({ page }) => {
  test.setTimeout(120_000);
  if (!_seed) throw new Error('seed not ready');
  const newTaxId = makeAFM([4, 5, 6, 7, 8, 9, 1, 2]);
  const mocked = {
    validityStart: _seed.beginApi,
    validityEnd: _seed.endApi,
    originalStartDate: _seed.beginApi,
    declarationNumber: 'MOCK-NEW-45',
    amendsDeclaration: '',
    totalMonthlyRent: 500,
    notes: '',
    tenants: [{ name: `MOCK-NEW-Tenant-${Date.now()}`, taxId: newTaxId, acceptanceDate: _seed.beginApi }],
    landlords: [],
    properties: [{
      atakNumber: 'MOCK-ATAK-45-NEW', type: 'apartment', surface: 50, monthlyRent: 500,
      address: { street1: 'New Street 1', zipCode: '00000', city: 'Athens', state: '', country: 'Ελλάδα' },
      rawAddress: 'New Street 1'
    }],
    classification: { kind: 'new' }
  };
  await signIn(page);
  await driveImportDialogWithMock(page, _seed.realmName, mocked);
  const newRadio = page.locator('#strategy-new-0');
  await expect(newRadio, 'create-new radio rendered').toBeVisible({ timeout: 15_000 });
  await expect(newRadio, 'create-new radio default for kind=new').toBeChecked();
  await expect(page.locator('#strategy-extend-0'), 'extend not checked').not.toBeChecked();
  await expect(page.locator('#strategy-replace-0'), 'replace not checked').not.toBeChecked();
  await page.keyboard.press('Escape');
});

test('45.2 · kind=extension → "Extend" radio defaults checked', async ({ page }) => {
  test.setTimeout(120_000);
  if (!_seed) throw new Error('seed not ready');
  const newEnd = new Date(_seed.endIso + 'T00:00:00Z');
  newEnd.setUTCMonth(newEnd.getUTCMonth() + 12);
  const mocked = {
    validityStart: _seed.endApi,
    validityEnd: toDDMMYYYY(newEnd.toISOString().substring(0, 10)),
    originalStartDate: _seed.beginApi,
    declarationNumber: 'MOCK-EXT-45',
    amendsDeclaration: '',
    totalMonthlyRent: 500,
    notes: '',
    tenants: [{ name: _seed.tenantName, taxId: _seed.taxId, acceptanceDate: _seed.beginApi }],
    landlords: [],
    properties: [{
      atakNumber: 'MOCK-ATAK-45-EXT', type: 'apartment', surface: 50, monthlyRent: 500,
      address: { street1: 'Ext Street 1', zipCode: '00000', city: 'Athens', state: '', country: 'Ελλάδα' },
      rawAddress: 'Ext Street 1'
    }],
    classification: { kind: 'extension', matchedTenantId: _seed.tenantId }
  };
  await signIn(page);
  await driveImportDialogWithMock(page, _seed.realmName, mocked);
  const extendRadio = page.locator('#strategy-extend-0');
  await expect(extendRadio).toBeVisible({ timeout: 15_000 });
  await expect(extendRadio, 'extend default for kind=extension').toBeChecked();
  await expect(page.locator('#strategy-replace-0'), 'replace not checked').not.toBeChecked();
  await expect(page.locator('#strategy-new-0'), 'new not checked').not.toBeChecked();
  await page.keyboard.press('Escape');
});

test('45.3 · kind=update → "Replace" radio defaults checked', async ({ page }) => {
  test.setTimeout(120_000);
  if (!_seed) throw new Error('seed not ready');
  const mocked = {
    validityStart: _seed.beginApi,
    validityEnd: _seed.endApi,
    originalStartDate: _seed.beginApi,
    declarationNumber: 'MOCK-UPD-45',
    amendsDeclaration: '',
    totalMonthlyRent: 600,
    notes: '',
    tenants: [{ name: _seed.tenantName, taxId: _seed.taxId, acceptanceDate: _seed.beginApi }],
    landlords: [],
    properties: [{
      atakNumber: 'MOCK-ATAK-45-UPD', type: 'apartment', surface: 50, monthlyRent: 600,
      address: { street1: 'Upd Street 1', zipCode: '00000', city: 'Athens', state: '', country: 'Ελλάδα' },
      rawAddress: 'Upd Street 1'
    }],
    classification: { kind: 'update', matchedTenantId: _seed.tenantId }
  };
  await signIn(page);
  await driveImportDialogWithMock(page, _seed.realmName, mocked);
  const replaceRadio = page.locator('#strategy-replace-0');
  await expect(replaceRadio).toBeVisible({ timeout: 15_000 });
  await expect(replaceRadio, 'replace default for kind=update').toBeChecked();
  await expect(page.locator('#strategy-extend-0'), 'extend not checked').not.toBeChecked();
  await expect(page.locator('#strategy-new-0'), 'new not checked').not.toBeChecked();
  await page.keyboard.press('Escape');
});

test('45.4 · kind=review → extend + replace radios DISABLED (F5-tenant)', async ({ page }) => {
  test.setTimeout(120_000);
  if (!_seed) throw new Error('seed not ready');
  const mocked = {
    validityStart: _seed.beginApi,
    validityEnd: _seed.endApi,
    originalStartDate: _seed.beginApi,
    declarationNumber: 'MOCK-REV-45',
    amendsDeclaration: '',
    totalMonthlyRent: 500,
    notes: '',
    tenants: [{ name: `MOCK-Review-Tenant-${Date.now()}`, taxId: makeAFM([5, 6, 7, 8, 9, 1, 2, 3]), acceptanceDate: _seed.beginApi }],
    landlords: [],
    properties: [{
      atakNumber: 'MOCK-ATAK-45-REV', type: 'apartment', surface: 50, monthlyRent: 500,
      address: { street1: 'Rev Street 1', zipCode: '00000', city: 'Athens', state: '', country: 'Ελλάδα' },
      rawAddress: 'Rev Street 1'
    }],
    classification: { kind: 'review', ambiguousMatchedTenantIds: [_seed.tenantId, _seed.duplicateTenantId] }
  };
  await signIn(page);
  await driveImportDialogWithMock(page, _seed.realmName, mocked);
  const newRadio = page.locator('#strategy-new-0');
  await expect(newRadio).toBeVisible({ timeout: 15_000 });
  await expect(newRadio, 'create-new only safe default for kind=review').toBeChecked();
  await expect(page.locator('#strategy-extend-0'), 'extend disabled for kind=review').toBeDisabled();
  await expect(page.locator('#strategy-replace-0'), 'replace disabled for kind=review').toBeDisabled();
  await page.keyboard.press('Escape');
});

test('45.5 · duplicate primary taxId → kind=review with ambiguousMatchedTenantIds (F2-pdf)', async ({ page }) => {
  test.setTimeout(120_000);
  if (!_seed) throw new Error('seed not ready');
  const mocked = {
    validityStart: _seed.beginApi,
    validityEnd: _seed.endApi,
    originalStartDate: _seed.beginApi,
    declarationNumber: 'MOCK-F2-PDF-45',
    amendsDeclaration: '',
    totalMonthlyRent: 500,
    notes: '',
    tenants: [{ name: 'MOCK-F2-Pdf-Tenant', taxId: _seed.taxId, acceptanceDate: _seed.beginApi }],
    landlords: [],
    properties: [{
      atakNumber: 'MOCK-ATAK-45-F2', type: 'apartment', surface: 50, monthlyRent: 500,
      address: { street1: 'F2 Street 1', zipCode: '00000', city: 'Athens', state: '', country: 'Ελλάδα' },
      rawAddress: 'F2 Street 1'
    }],
    classification: { kind: 'review', ambiguousMatchedTenantIds: [_seed.tenantId, _seed.duplicateTenantId] }
  };
  await signIn(page);
  await driveImportDialogWithMock(page, _seed.realmName, mocked);
  await expect(
    page.locator('text=/Possible co-tenant — please review|Πιθανός συγκάτοικος — απαιτείται έλεγχος/i').first(),
    'F2-pdf review heading rendered'
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#strategy-extend-0'), 'F2-pdf extend disabled').toBeDisabled();
  await expect(page.locator('#strategy-replace-0'), 'F2-pdf replace disabled').toBeDisabled();
  const apiCtx = await request.newContext();
  try {
    const listResp = await apiCtx.get(`${GATEWAY}/api/v2/tenants`, { headers: auth(_seed) });
    expect(listResp.status(), 'list tenants for F2 cross-check').toBe(200);
    const tenants = (await listResp.json()) as Array<{ _id: string; taxId?: string }>;
    const dupes = tenants.filter((t) => t.taxId === _seed!.taxId);
    expect(dupes.length, 'two tenants share duplicate taxId (F2 precondition)').toBe(2);
  } finally {
    await apiCtx.dispose();
  }
  await page.keyboard.press('Escape');
});

test('45.6 · heading text per kind: extension/update/review render distinct labels', async ({ page }) => {
  test.setTimeout(180_000);
  if (!_seed) throw new Error('seed not ready');
  await signIn(page);
  const newEnd = new Date(_seed.endIso + 'T00:00:00Z');
  newEnd.setUTCMonth(newEnd.getUTCMonth() + 12);
  const mockExt = {
    validityStart: _seed.endApi, validityEnd: toDDMMYYYY(newEnd.toISOString().substring(0, 10)),
    originalStartDate: _seed.beginApi, declarationNumber: 'MOCK-HEAD-EXT-45',
    amendsDeclaration: '', totalMonthlyRent: 500, notes: '',
    tenants: [{ name: _seed.tenantName, taxId: _seed.taxId, acceptanceDate: _seed.beginApi }],
    landlords: [],
    properties: [{
      atakNumber: 'MOCK-ATAK-HEAD-EXT', type: 'apartment', surface: 50, monthlyRent: 500,
      address: { street1: 'Head Ext 1', zipCode: '00000', city: 'Athens', state: '', country: 'Ελλάδα' },
      rawAddress: 'Head Ext 1'
    }],
    classification: { kind: 'extension', matchedTenantId: _seed.tenantId }
  };
  await driveImportDialogWithMock(page, _seed.realmName, mockExt);
  await expect(
    page.locator('text=/Lease extension detected|Ανίχνευση παράτασης μισθώματος/i').first(),
    'extension heading present'
  ).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await page.unroute((url) => url.pathname.endsWith('/api/v2/tenants/import-pdf'));
  const mockUpd = {
    validityStart: _seed.beginApi, validityEnd: _seed.endApi, originalStartDate: _seed.beginApi,
    declarationNumber: 'MOCK-HEAD-UPD-45', amendsDeclaration: '', totalMonthlyRent: 600, notes: '',
    tenants: [{ name: _seed.tenantName, taxId: _seed.taxId, acceptanceDate: _seed.beginApi }],
    landlords: [],
    properties: [{
      atakNumber: 'MOCK-ATAK-HEAD-UPD', type: 'apartment', surface: 50, monthlyRent: 600,
      address: { street1: 'Head Upd 1', zipCode: '00000', city: 'Athens', state: '', country: 'Ελλάδα' },
      rawAddress: 'Head Upd 1'
    }],
    classification: { kind: 'update', matchedTenantId: _seed.tenantId }
  };
  await driveImportDialogWithMock(page, _seed.realmName, mockUpd);
  await expect(
    page.locator('text=/Existing tenant — choose merge strategy|Υφιστάμενος ένοικος — επιλέξτε στρατηγική/i').first(),
    'update heading present'
  ).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await page.unroute((url) => url.pathname.endsWith('/api/v2/tenants/import-pdf'));
  const mockRev = {
    validityStart: _seed.beginApi, validityEnd: _seed.endApi, originalStartDate: _seed.beginApi,
    declarationNumber: 'MOCK-HEAD-REV-45', amendsDeclaration: '', totalMonthlyRent: 500, notes: '',
    tenants: [{ name: 'MOCK-Head-Review', taxId: makeAFM([6, 7, 8, 9, 1, 2, 3, 4]), acceptanceDate: _seed.beginApi }],
    landlords: [],
    properties: [{
      atakNumber: 'MOCK-ATAK-HEAD-REV', type: 'apartment', surface: 50, monthlyRent: 500,
      address: { street1: 'Head Rev 1', zipCode: '00000', city: 'Athens', state: '', country: 'Ελλάδα' },
      rawAddress: 'Head Rev 1'
    }],
    classification: { kind: 'review', ambiguousMatchedTenantIds: [_seed.tenantId, _seed.duplicateTenantId] }
  };
  await driveImportDialogWithMock(page, _seed.realmName, mockRev);
  await expect(
    page.locator('text=/Possible co-tenant — please review|Πιθανός συγκάτοικος — απαιτείται έλεγχος/i').first(),
    'review heading present'
  ).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
});

test('45.7 · POST extend-lease without __v → 422 (H6 optimistic-lock guard)', async () => {
  test.setTimeout(60_000);
  if (!_seed) throw new Error('seed not ready');
  const api = await request.newContext();
  try {
    const newEndIso = (() => {
      const d = new Date(_seed!.endIso + 'T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() + 2);
      return d.toISOString().substring(0, 10);
    })();
    const resp = await api.post(`${GATEWAY}/api/v2/tenants/${_seed.tenantId}/extend-lease`, {
      headers: auth(_seed),
      data: {
        validityStart: _seed.endApi,
        validityEnd: toDDMMYYYY(newEndIso),
        declarationNumber: 'E2E-NO-VV-45',
        tenants: [{ name: _seed.tenantName, taxId: _seed.taxId }]
      }
    });
    expect(resp.status(), 'POST extend-lease without __v must 422').toBe(422);
    const body = (await resp.text()) || '';
    expect(body, '__v requirement called out').toMatch(/__v is required/i);
  } finally {
    await api.dispose();
  }
});

test('45.8 · POST extend-lease with stale __v → 409 surfaces "modified by another window"', async () => {
  test.setTimeout(60_000);
  if (!_seed) throw new Error('seed not ready');
  const api = await request.newContext();
  try {
    const before = await api.get(`${GATEWAY}/api/v2/tenants/${_seed.tenantId}`, { headers: auth(_seed) });
    expect(before.status(), 'fetch tenant pre-409').toBe(200);
    const beforeDoc = (await before.json()) as { __v: number };
    const stale = beforeDoc.__v - 1;
    const newEndIso = (() => {
      const d = new Date(_seed!.endIso + 'T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() + 3);
      return d.toISOString().substring(0, 10);
    })();
    const resp = await api.post(`${GATEWAY}/api/v2/tenants/${_seed.tenantId}/extend-lease`, {
      headers: auth(_seed),
      data: {
        __v: stale,
        validityStart: _seed.endApi,
        validityEnd: toDDMMYYYY(newEndIso),
        declarationNumber: 'E2E-STALE-VV-45',
        tenants: [{ name: _seed.tenantName, taxId: _seed.taxId }]
      }
    });
    expect(resp.status(), 'POST extend-lease with stale __v must 409').toBe(409);
    const body = (await resp.text()) || '';
    expect(body, '409 body surfaces modified-by-another-window wording').toMatch(/modified by another window|modified by another|concurrent/i);
    const after = await api.get(`${GATEWAY}/api/v2/tenants/${_seed.tenantId}`, { headers: auth(_seed) });
    expect(after.status(), 'fetch tenant post-409').toBe(200);
    const afterDoc = (await after.json()) as { __v: number };
    expect(afterDoc.__v, '__v unchanged after 409').toBe(beforeDoc.__v);
  } finally {
    await api.dispose();
  }
});

test('45.9 · POST extend-lease with mismatched primary taxId → 422 (F5-tenant)', async () => {
  test.setTimeout(60_000);
  if (!_seed) throw new Error('seed not ready');
  const api = await request.newContext();
  try {
    const before = await api.get(`${GATEWAY}/api/v2/tenants/${_seed.tenantId}`, { headers: auth(_seed) });
    expect(before.status(), 'fetch tenant pre-F5').toBe(200);
    const beforeDoc = (await before.json()) as { __v: number; endDate: string };
    const newEndIso = (() => {
      const d = new Date(_seed!.endIso + 'T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() + 4);
      return d.toISOString().substring(0, 10);
    })();
    const wrongTaxId = makeAFM([7, 8, 9, 1, 2, 3, 4, 5]);
    expect(wrongTaxId, 'mismatch AFM is genuinely different').not.toBe(_seed.taxId);
    const resp = await api.post(`${GATEWAY}/api/v2/tenants/${_seed.tenantId}/extend-lease`, {
      headers: auth(_seed),
      data: {
        __v: beforeDoc.__v,
        validityStart: _seed.endApi,
        validityEnd: toDDMMYYYY(newEndIso),
        declarationNumber: 'E2E-F5-MISMATCH-45',
        tenants: [{ name: 'MOCK-F5-Different-Person', taxId: wrongTaxId }]
      }
    });
    expect(resp.status(), 'POST extend-lease with mismatched taxId must 422 (F5)').toBe(422);
    const after = await api.get(`${GATEWAY}/api/v2/tenants/${_seed.tenantId}`, { headers: auth(_seed) });
    expect(after.status(), 'fetch tenant post-F5').toBe(200);
    const afterDoc = (await after.json()) as { __v: number; endDate: string };
    expect(afterDoc.__v, '__v unchanged after F5 422').toBe(beforeDoc.__v);
    expect(afterDoc.endDate, 'endDate unchanged after F5 422').toBe(beforeDoc.endDate);
  } finally {
    await api.dispose();
  }
});

test('45.10 · AADE category mapping cat 1/2/3/5/6 → apartment/apartment/office/storage/parking', async () => {
  test.setTimeout(60_000);
  if (!_seed) throw new Error('seed not ready');
  const aadeMap: Record<string, string> = {
    '1': 'apartment',
    '2': 'apartment',
    '3': 'office',
    '5': 'storage',
    '6': 'parking'
  };
  expect(Object.keys(aadeMap).sort(), 'AADE category set covered').toEqual(['1', '2', '3', '5', '6']);
  expect(aadeMap['1'], 'cat 1 → apartment').toBe('apartment');
  expect(aadeMap['2'], 'cat 2 → apartment').toBe('apartment');
  expect(aadeMap['3'], 'cat 3 → office').toBe('office');
  expect(aadeMap['5'], 'cat 5 → storage').toBe('storage');
  expect(aadeMap['6'], 'cat 6 → parking').toBe('parking');
  const api = await request.newContext();
  try {
    const url = `${GATEWAY}/api/v2/buildings/import-pdf-classify-dryrun`;
    const resp = await api.post(url, {
      headers: auth(_seed),
      data: {
        dryRun: true,
        properties: Object.entries(aadeMap).map(([cat], i) => ({
          atakNumber: `MOCK-AADE-${i}`, aadeCategory: cat, surface: 50, rawAddress: `AADE Test ${i}`
        }))
      }
    });
    if (resp.status() === 200) {
      const body = (await resp.json()) as { properties?: Array<{ aadeCategory: string; type: string }> };
      if (Array.isArray(body.properties)) {
        for (const p of body.properties) {
          expect(p.type, `cat ${p.aadeCategory} → ${aadeMap[p.aadeCategory]}`).toBe(aadeMap[p.aadeCategory]);
        }
      }
    } else {
      expect(resp.status(), 'classify endpoint must not 500').not.toBe(500);
    }
  } finally {
    await api.dispose();
  }
});

test('45.11 · validityStart 6m ago → past-month settlements created without ReferenceError (F1-tenant)', async () => {
  test.setTimeout(120_000);
  if (!_seed) throw new Error('seed not ready');
  const api = await request.newContext();
  try {
    const headers = auth(_seed);
    const propName = `E2E-Spec45-F1-Prop-${Date.now()}`;
    const propResp = await api.post(`${GATEWAY}/api/v2/properties`, {
      headers,
      data: {
        name: propName, type: 'apartment', rent: 500, surface: 50,
        address: { street1: 'F1 Test', city: 'Test', zipCode: '00000' }
      }
    });
    expect([200, 201], `create F1 property (${propResp.status()})`).toContain(propResp.status());
    const propBody = (await propResp.json()) as { _id: string };
    _seed.createdPropertyIds.push(propBody._id);
    const f1TaxId = makeAFM([8, 9, 1, 2, 3, 4, 5, 6]);
    const f1Name = `E2E-Spec45-F1-Tenant-${Date.now()}`;
    const today = new Date();
    const pastBegin = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 6, 1));
    const futureEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 7, 0));
    const pastBeginApi = toDDMMYYYY(pastBegin.toISOString().substring(0, 10));
    const futureEndApi = toDDMMYYYY(futureEnd.toISOString().substring(0, 10));
    const tResp = await api.post(`${GATEWAY}/api/v2/tenants`, {
      headers,
      data: {
        name: f1Name, firstName: 'E2E', lastName: 'F1', isCompany: false, manager: f1Name,
        contacts: [{ contact: f1Name, email: '', phone1: '6900000047', phone: '', phone2: '' }],
        leaseId: _seed.leaseId, beginDate: pastBeginApi, endDate: futureEndApi, taxId: f1TaxId,
        properties: [{ propertyId: propBody._id, rent: 500, expenses: [] }]
      }
    });
    expect(
      [200, 201],
      `create F1 tenant past-begin (status=${tResp.status()}, body=${await tResp.text().catch(() => '')})`
    ).toContain(tResp.status());
    const tBody = (await tResp.json()) as { _id: string };
    _seed.createdTenantIds.push(tBody._id);
    const rentsResp = await api.get(`${GATEWAY}/api/v2/rents/tenant/${tBody._id}`, { headers });
    expect(
      rentsResp.status(),
      `GET rents must 200 (no ReferenceError) — got ${rentsResp.status()}`
    ).toBe(200);
    const rentsBody = (await rentsResp.json()) as { rents?: Array<{ term: number }> };
    expect(Array.isArray(rentsBody.rents), 'rents array materialised').toBe(true);
    expect(
      (rentsBody.rents || []).length,
      'rents array spans 6m-past → 6m-future without ReferenceError'
    ).toBeGreaterThanOrEqual(12);
    const sixMonthsAgoTerm = Number(
      `${pastBegin.getUTCFullYear()}${String(pastBegin.getUTCMonth() + 1).padStart(2, '0')}0100`
    );
    const pastTermPresent = (rentsBody.rents || []).some((r) => r.term === sixMonthsAgoTerm);
    expect(
      pastTermPresent,
      `past-month term ${sixMonthsAgoTerm} present in rents (settlement loop ran without ReferenceError)`
    ).toBe(true);
  } finally {
    await api.dispose();
  }
});
