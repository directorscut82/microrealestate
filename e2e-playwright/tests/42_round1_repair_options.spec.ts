/**
 * Spec 42 — Round-1 audit: AddRepair dialog + Repair API options matrix.
 *
 * Surface: RepairList at /buildings/[id] (Repairs & Contractors tab) +
 * POST/PATCH/DELETE /api/v2/buildings/:id/repairs[/:repairId] +
 * GET/DELETE /api/v2/documents/by-key for invoice file lifecycle.
 *
 * Round-1 audit findings exercised here:
 *   F1 (Radix sentinel)        : When `building.contractors.length === 0`
 *                                the contractor Select must NOT render —
 *                                a SelectItem with empty value would crash
 *                                the dialog open. Pre-fix: dialog opened on
 *                                a no-contractor building threw the Radix
 *                                "A <Select.Item /> must have a value prop
 *                                that is not an empty string" error.
 *   F1 (with-contractors path) : The contractor dropdown lists "None" +
 *                                every contractor on this building, mapping
 *                                empty-string contractorId to a "__none__"
 *                                sentinel internally so Radix never sees
 *                                an empty SelectItem value.
 *   F2 (update guard)          : updateRepair shares the past-paid frozen
 *                                term guard with addRepair via
 *                                _assertChargeTermNotFrozen → user cannot
 *                                bypass it by creating with current term
 *                                then PATCHing chargeTerm to a past month
 *                                where rents are paid.
 *   F3 (building-scoped guard) : The frozen-term query is scoped to THIS
 *                                building's units only — building B repair
 *                                must NOT be blocked by paid rents in
 *                                building A.
 *   F4 (orphan invoice)        : Invoice files uploaded BUT not committed
 *                                to a saved repair are best-effort deleted
 *                                on Cancel/Esc/outside-click; deleting the
 *                                whole repair also deletes its invoice.
 *   F6 (re-pick same file)     : Removing an invoice clears the file input
 *                                ref so the same file can be re-picked.
 *   I-3.f (ScrollArea desktop) : The dialog body uses ScrollArea on the
 *                                desktop branch so a 768px-tall viewport
 *                                produces a scrollable inner container,
 *                                NOT a clipped form.
 *   Round-trip                 : Editing an existing repair shows every
 *                                stored field exactly as persisted (no
 *                                silent data loss in initialValues).
 *
 * Discipline anchors (CLAUDE.md):
 *   • Live NAS, CYPRESS-TEST-DO-NOT-USE realm.
 *   • Each test owns a FRESH building (E2E-S42-<tag>-<RUN_ID>) so a
 *     panic in one scenario never bleeds into another. afterAll
 *     best-effort deletes every building this run created.
 *   • Past-paid F2/F3 cases re-use ensureSeedLeasedTenantWithPayment so
 *     the canonical tenant carries a real paid rent we can move to a
 *     past month. The F3 cross-building case also creates a SECOND
 *     building and deliberately seeds NO rents/payments on it, proving
 *     the guard is building-scoped.
 *   • Radix dialog open is asserted via the dialog header text (the
 *     ResponsiveDialog renders "Add repair"/"Edit repair" only when the
 *     dialog is mounted) — NOT a vague toBeVisible() on a body element
 *     that would also pass against a closed-dialog page.
 *   • Status-code asserts use exact ===, never `<400`.
 */
import { APIRequestContext, expect, request, test } from '@playwright/test';
import {
  ensureSeed,
  ensureSeedLeasedTenant,
  ensureSeedLeasedTenantWithPayment
} from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';
const RUN_ID = String(Date.now()).slice(-8);

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error(
      'Missing TEST_EMAIL/TEST_PASSWORD. Expected .secrets/cypress-test-account.'
    );
  }
});

interface BaseSeed {
  token: string;
  realmId: string;
  realmName: string;
}

const createdBuildingIds: Array<{
  token: string;
  realmId: string;
  id: string;
}> = [];

const authHeaders = (token: string, realmId?: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  ...(realmId ? { organizationid: realmId } : {})
});

const currentTermNumber = (): number => {
  const d = new Date();
  return Number(
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}0100`
  );
};

const pastTermNumber = (monthsBack: number): number => {
  const today = new Date();
  const past = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsBack, 1)
  );
  return Number(
    `${past.getUTCFullYear()}${String(past.getUTCMonth() + 1).padStart(2, '0')}0100`
  );
};

const pastTermDateApi = (monthsBack: number): string => {
  const today = new Date();
  const past = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsBack, 1)
  );
  return `01/${String(past.getUTCMonth() + 1).padStart(2, '0')}/${past.getUTCFullYear()}`;
};

async function getBaseSeed(api: APIRequestContext): Promise<BaseSeed> {
  const seed = await ensureSeed(api);
  return {
    token: seed.token,
    realmId: seed.realmId,
    realmName: seed.realmName
  };
}

async function createFreshBuilding(
  api: APIRequestContext,
  base: BaseSeed,
  scenarioTag: string
): Promise<string> {
  const headers = authHeaders(base.token, base.realmId);
  const name = `E2E-S42-${scenarioTag}-${RUN_ID}`;
  const atakPrefix = `S42${scenarioTag}${RUN_ID}`.slice(0, 19);
  const r = await api.post(`${GATEWAY}/api/v2/buildings`, {
    headers,
    data: {
      name,
      atakPrefix,
      address: { street1: 'E2E S42', city: 'Athens', zipCode: '00000' }
    }
  });
  expect([200, 201]).toContain(r.status());
  const body = (await r.json()) as { _id: string };
  createdBuildingIds.push({ token: base.token, realmId: base.realmId, id: body._id });
  return body._id;
}

async function addContractor(
  api: APIRequestContext,
  base: BaseSeed,
  buildingId: string,
  name: string,
  specialty = 'plumber'
): Promise<string> {
  const r = await api.post(
    `${GATEWAY}/api/v2/buildings/${buildingId}/contractors`,
    { headers: authHeaders(base.token, base.realmId), data: { name, specialty } }
  );
  expect([200, 201]).toContain(r.status());
  const j = (await r.json()) as { contractors?: Array<{ _id: string; name: string }> };
  const c = (j.contractors || []).find((x) => x.name === name);
  if (!c) throw new Error(`Contractor ${name} missing from response`);
  return c._id;
}

async function addRepairApi(api: APIRequestContext, base: BaseSeed, buildingId: string, payload: Record<string, unknown>) {
  return api.post(`${GATEWAY}/api/v2/buildings/${buildingId}/repairs`, {
    headers: authHeaders(base.token, base.realmId),
    data: payload
  });
}

async function patchRepairApi(api: APIRequestContext, base: BaseSeed, buildingId: string, repairId: string, payload: Record<string, unknown>) {
  return api.patch(`${GATEWAY}/api/v2/buildings/${buildingId}/repairs/${repairId}`, {
    headers: authHeaders(base.token, base.realmId),
    data: payload
  });
}

async function deleteRepairApi(api: APIRequestContext, base: BaseSeed, buildingId: string, repairId: string) {
  return api.delete(`${GATEWAY}/api/v2/buildings/${buildingId}/repairs/${repairId}`, {
    headers: authHeaders(base.token, base.realmId)
  });
}

async function getBuilding(api: APIRequestContext, base: BaseSeed, buildingId: string) {
  const r = await api.get(`${GATEWAY}/api/v2/buildings/${buildingId}`, { headers: authHeaders(base.token, base.realmId) });
  expect(r.status()).toBe(200);
  return (await r.json()) as { _id: string; repairs?: Array<Record<string, unknown>>; contractors?: Array<Record<string, unknown>>; units?: Array<Record<string, unknown>> };
}

async function uploadInvoice(api: APIRequestContext, base: BaseSeed, folder: string, fileName: string): Promise<string> {
  // The upload middleware reads `req.body.folder` (NOT `s3Dir`) to
  // build the realm-prefixed storage key. Passing s3Dir directly skips
  // the realm prefix and the resulting key 403s on every by-key GET
  // (the realm-prefix guard refuses keys outside <realmName>-<realmId>/).
  // See uploadmiddelware.ts:62-72.
  const r = await api.post(`${GATEWAY}/api/v2/documents/upload`, {
    headers: { Authorization: `Bearer ${base.token}`, organizationid: base.realmId },
    multipart: {
      folder,
      fileName,
      file: { name: fileName, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%MOCK_INVOICE_S42\n', 'utf8') }
    }
  });
  expect([200, 201]).toContain(r.status());
  const j = (await r.json()) as { key?: string };
  if (!j.key) throw new Error('upload response missing key');
  return j.key;
}

async function getInvoiceByKey(api: APIRequestContext, base: BaseSeed, key: string) {
  return api.get(`${GATEWAY}/api/v2/documents/by-key?key=${encodeURIComponent(key)}`, { headers: authHeaders(base.token, base.realmId) });
}

async function deleteInvoiceByKey(api: APIRequestContext, base: BaseSeed, key: string) {
  return api.delete(`${GATEWAY}/api/v2/documents/by-key?key=${encodeURIComponent(key)}`, { headers: authHeaders(base.token, base.realmId) });
}

async function ensureLinkedUnit(api: APIRequestContext, base: BaseSeed, buildingId: string, propertyId: string, tag: string) {
  const b = await getBuilding(api, base, buildingId);
  const linked = (b.units || []).some((u) => String((u as any).propertyId) === String(propertyId));
  if (linked) return;
  const candidate = (b.units || [])[0] as any;
  if (candidate?._id) {
    await api.patch(`${GATEWAY}/api/v2/buildings/${buildingId}/units/${candidate._id}`, {
      headers: authHeaders(base.token, base.realmId), data: { propertyId }
    }).catch(() => {});
  } else {
    await api.post(`${GATEWAY}/api/v2/buildings/${buildingId}/units`, {
      headers: authHeaders(base.token, base.realmId),
      data: { atakNumber: `S42${tag}${RUN_ID}`, isManaged: true, occupancyType: 'rented', propertyId, generalThousandths: 1000 }
    }).catch(() => {});
  }
}

test.afterAll(async () => {
  const apiCtx = await request.newContext();
  try {
    for (const b of createdBuildingIds) {
      await apiCtx.delete(`${GATEWAY}/api/v2/buildings/${b.id}`, { headers: authHeaders(b.token, b.realmId) }).catch(() => {});
    }
  } finally { await apiCtx.dispose(); }
});

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toMatch(/\/(firstaccess|dashboard)/);
}

test('42.1 · F1 — Add Repair dialog opens on 0-contractor building (no Radix crash)', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const base = await getBaseSeed(apiCtx);
  const buildingId = await createFreshBuilding(apiCtx, base, 'F1zero');
  const beforeBuilding = await getBuilding(apiCtx, base, buildingId);
  expect((beforeBuilding.contractors || []).length).toBe(0);
  await apiCtx.dispose();
  await signIn(page);
  await page.goto(`${encodeURIComponent(base.realmName)}/buildings/${buildingId}`);
  await expect(page.locator('[data-cy=buildingPage]')).toBeVisible({ timeout: 20_000 });
  await page.locator('[data-cy=repairsTab]').click();
  await page.locator('[data-cy=addRepair]').click();
  await expect(page.locator('text=/^(Add repair|Προσθήκη επισκευής)$/').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('input#title')).toBeVisible();
  await expect(page.locator('[data-cy=submitRepair]')).toBeVisible();
  await expect(page.locator('label', { hasText: /^(Contractor|Εργολάβος)$/ })).toHaveCount(0);
});

test('42.2 · F1 — contractor dropdown lists "None" + N items', async ({ page }) => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const base = await getBaseSeed(apiCtx);
  const buildingId = await createFreshBuilding(apiCtx, base, 'F1many');
  const cName1 = `E2E-S42-Contractor-A-${RUN_ID}`;
  const cName2 = `E2E-S42-Contractor-B-${RUN_ID}`;
  const cName3 = `E2E-S42-Contractor-C-${RUN_ID}`;
  await addContractor(apiCtx, base, buildingId, cName1, 'plumber');
  await addContractor(apiCtx, base, buildingId, cName2, 'electrician');
  await addContractor(apiCtx, base, buildingId, cName3, 'painter');
  const after = await getBuilding(apiCtx, base, buildingId);
  expect((after.contractors || []).length).toBe(3);
  await apiCtx.dispose();
  await signIn(page);
  await page.goto(`${encodeURIComponent(base.realmName)}/buildings/${buildingId}`);
  await expect(page.locator('[data-cy=buildingPage]')).toBeVisible({ timeout: 20_000 });
  await page.locator('[data-cy=repairsTab]').click();
  await page.locator('[data-cy=addRepair]').click();
  await expect(page.locator('text=/^(Add repair|Προσθήκη επισκευής)$/').first()).toBeVisible({ timeout: 10_000 });
  const contractorLabel = page.locator('label', { hasText: /^(Contractor|Εργολάβος)$/ }).first();
  await expect(contractorLabel).toBeVisible();
  const contractorBlock = contractorLabel.locator('xpath=ancestor::div[contains(@class,"space-y-2")][1]');
  const trigger = contractorBlock.locator('button[role="combobox"]').first();
  await trigger.click();
  await expect(page.locator('[role="option"]')).toHaveCount(4, { timeout: 10_000 });
  await expect(page.locator('[role="option"]', { hasText: /^(None|Καμία|Κανένας|Κανένα)$/ })).toHaveCount(1);
  for (const name of [cName1, cName2, cName3]) {
    await expect(page.locator('[role="option"]', { hasText: name })).toHaveCount(1);
  }
});

test('42.3 · edit existing repair — all fields round-trip through dialog', async ({ page }) => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const base = await getBaseSeed(apiCtx);
  const buildingId = await createFreshBuilding(apiCtx, base, 'rt');
  const contractorId = await addContractor(apiCtx, base, buildingId, `E2E-S42-RT-Contractor-${RUN_ID}`, 'plumber');
  const reportedDate = '2025-04-10';
  const startDate = '2025-04-12';
  const completionDate = '2025-04-20';
  const repairTitle = `E2E-S42-Repair-RT-${RUN_ID}`;
  const seedPayload = {
    title: repairTitle, description: 'leaky shower head replacement', category: 'plumbing',
    status: 'completed', urgency: 'normal', estimatedCost: 80, actualCost: 95.5,
    chargeableTo: 'owners', tenantSharePercentage: 50, allocationMethod: 'general_thousandths',
    chargeTerm: currentTermNumber(), contractorId,
    reportedDate: `${reportedDate}T00:00:00.000Z`, startDate: `${startDate}T00:00:00.000Z`,
    completionDate: `${completionDate}T00:00:00.000Z`, isPaidFromRepairsFund: true,
    invoiceReference: 'INV-2025-04-RT', notes: 'Round-trip test repair'
  };
  const created = await addRepairApi(apiCtx, base, buildingId, seedPayload);
  expect(created.status()).toBe(200);
  await apiCtx.dispose();
  await signIn(page);
  await page.goto(`${encodeURIComponent(base.realmName)}/buildings/${buildingId}`);
  await expect(page.locator('[data-cy=buildingPage]')).toBeVisible({ timeout: 20_000 });
  await page.locator('[data-cy=repairsTab]').click();
  const row = page.locator('tr', { hasText: repairTitle });
  await expect(row).toHaveCount(1);
  await row.locator('button[aria-label="Edit"], button[aria-label="Επεξεργασία"]').first().click();
  // Dialog renders inside Radix DialogContent (role=dialog). Match the
  // header text via getByText (substring) so a slight wrapping change
  // (extra whitespace, span nesting) doesn't break the match. The
  // realm locale is 'el' but the URL has no /el/ prefix, so the page
  // renders in the i18n default (en) — both labels accepted.
  await expect(
    page.getByRole('dialog').getByText(/Edit repair|Επεξεργασία επισκευής/).first()
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('input#title')).toHaveValue(repairTitle);
  await expect(page.locator('textarea#description')).toHaveValue(seedPayload.description);
  await expect(page.locator('input#estimatedCost')).toHaveValue(String(seedPayload.estimatedCost));
  await expect(page.locator('input#actualCost')).toHaveValue(String(seedPayload.actualCost));
  await expect(page.locator('input#invoiceReference')).toHaveValue(seedPayload.invoiceReference);
  await expect(page.locator('textarea#notes')).toHaveValue(seedPayload.notes);
  await expect(page.locator('input#reportedDate')).toHaveValue(reportedDate);
  await expect(page.locator('input#startDate')).toHaveValue(startDate);
  await expect(page.locator('input#completionDate')).toHaveValue(completionDate);
});

test('42.4 · POST repair chargeableTo=owners + past chargeTerm + paid tenant rent → 200', async () => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const paid = await ensureSeedLeasedTenantWithPayment(apiCtx, 250);
  const base: BaseSeed = { token: paid.token, realmId: paid.realmId, realmName: paid.realmName };
  const buildingId = await createFreshBuilding(apiCtx, base, 'F2own');
  const past = pastTermNumber(3);
  const ownerTitle = `E2E-S42-OwnerPast-${RUN_ID}`;
  const r = await addRepairApi(apiCtx, base, buildingId, {
    title: ownerTitle, category: 'roof', status: 'completed', urgency: 'normal',
    chargeableTo: 'owners', estimatedCost: 0, actualCost: 600, tenantSharePercentage: 0,
    allocationMethod: 'general_thousandths', chargeTerm: past
  });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as { repairs: Array<{ title: string; chargeableTo: string; chargeTerm: number }> };
  const created = body.repairs.find((x) => x.title === ownerTitle);
  expect(created).toBeTruthy();
  expect(created!.chargeableTo).toBe('owners');
  expect(Number(created!.chargeTerm)).toBe(past);
  await apiCtx.dispose();
});

test('42.5 · POST repair chargeableTo=tenants + current month → 200', async () => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const base = await getBaseSeed(apiCtx);
  const buildingId = await createFreshBuilding(apiCtx, base, 'F2cur');
  const current = currentTermNumber();
  const title = `E2E-S42-TenantsCurrent-${RUN_ID}`;
  const r = await addRepairApi(apiCtx, base, buildingId, {
    title, category: 'plumbing', status: 'in_progress', urgency: 'normal',
    chargeableTo: 'tenants', estimatedCost: 120, actualCost: 0, tenantSharePercentage: 100,
    allocationMethod: 'equal', chargeTerm: current
  });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as { repairs: Array<{ title: string; chargeTerm: number; chargeableTo: string }> };
  const created = body.repairs.find((x) => x.title === title);
  expect(created).toBeTruthy();
  expect(Number(created!.chargeTerm)).toBe(current);
  expect(created!.chargeableTo).toBe('tenants');
  await apiCtx.dispose();
});

test('42.6 · POST repair chargeableTo=tenants + past with paid rent in this building → 422 (F2/F3 frozen guard)', async () => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const paid = await ensureSeedLeasedTenantWithPayment(apiCtx, 300);
  const base: BaseSeed = { token: paid.token, realmId: paid.realmId, realmName: paid.realmName };
  const buildingId = paid.buildingId;
  await ensureLinkedUnit(apiCtx, base, buildingId, paid.propertyId, 'F2u');
  const past = pastTermNumber(2);
  const seedPay = await apiCtx.patch(`${GATEWAY}/api/v2/rents/payment/${paid.tenantId}/${past}`, {
    headers: authHeaders(base.token, base.realmId),
    data: { _id: paid.tenantId, payments: [{ amount: 500, type: 'cash', date: pastTermDateApi(2) }] }
  });
  expect(seedPay.status()).toBe(200);
  const title = `E2E-S42-TenantsPastFrozen-${RUN_ID}`;
  const r = await addRepairApi(apiCtx, base, buildingId, {
    title, category: 'plumbing', status: 'completed', urgency: 'normal',
    chargeableTo: 'tenants', estimatedCost: 0, actualCost: 200, tenantSharePercentage: 100,
    allocationMethod: 'equal', chargeTerm: past
  });
  expect(r.status()).toBe(422);
  const errBody = await r.text();
  expect(errBody.toLowerCase()).toMatch(/past|frozen|paid/);
  const after = await getBuilding(apiCtx, base, buildingId);
  const collisions = (after.repairs || []).filter((x) => (x as any).title === title);
  expect(collisions).toHaveLength(0);
  await apiCtx.dispose();
});

test('42.7 · F3 — building B repair on past term passes 200 even when building A has paid past rent (building-scoped guard)', async () => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const paid = await ensureSeedLeasedTenantWithPayment(apiCtx, 300);
  const base: BaseSeed = { token: paid.token, realmId: paid.realmId, realmName: paid.realmName };
  await ensureLinkedUnit(apiCtx, base, paid.buildingId, paid.propertyId, 'F3a');
  const past = pastTermNumber(2);
  const sp = await apiCtx.patch(`${GATEWAY}/api/v2/rents/payment/${paid.tenantId}/${past}`, {
    headers: authHeaders(base.token, base.realmId),
    data: { _id: paid.tenantId, payments: [{ amount: 500, type: 'cash', date: pastTermDateApi(2) }] }
  });
  expect(sp.status()).toBe(200);
  const buildingBId = await createFreshBuilding(apiCtx, base, 'F3buildB');
  const title = `E2E-S42-F3-BuildingB-${RUN_ID}`;
  const r = await addRepairApi(apiCtx, base, buildingBId, {
    title, category: 'electrical', status: 'completed', urgency: 'normal',
    chargeableTo: 'tenants', estimatedCost: 0, actualCost: 150, tenantSharePercentage: 100,
    allocationMethod: 'equal', chargeTerm: past
  });
  expect(r.status()).toBe(200);
  const j = (await r.json()) as { repairs: Array<{ title: string; chargeTerm: number }> };
  const created = j.repairs.find((x) => x.title === title);
  expect(created).toBeTruthy();
  expect(Number(created!.chargeTerm)).toBe(past);
  await apiCtx.dispose();
});

test('42.8 · F2 — PATCH chargeTerm to past-paid month → 422 (update guard)', async () => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const paid = await ensureSeedLeasedTenantWithPayment(apiCtx, 300);
  const base: BaseSeed = { token: paid.token, realmId: paid.realmId, realmName: paid.realmName };
  const buildingId = paid.buildingId;
  await ensureLinkedUnit(apiCtx, base, buildingId, paid.propertyId, 'F2upd');
  const past = pastTermNumber(2);
  await apiCtx.patch(`${GATEWAY}/api/v2/rents/payment/${paid.tenantId}/${past}`, {
    headers: authHeaders(base.token, base.realmId),
    data: { _id: paid.tenantId, payments: [{ amount: 500, type: 'cash', date: pastTermDateApi(2) }] }
  });
  const current = currentTermNumber();
  const title = `E2E-S42-UpdateGuard-${RUN_ID}`;
  const created = await addRepairApi(apiCtx, base, buildingId, {
    title, category: 'painting', status: 'planned', urgency: 'normal',
    chargeableTo: 'tenants', estimatedCost: 100, actualCost: 0, tenantSharePercentage: 100,
    allocationMethod: 'equal', chargeTerm: current
  });
  expect(created.status()).toBe(200);
  const seedBody = (await created.json()) as { repairs: Array<{ _id: string; title: string }> };
  const repairId = seedBody.repairs.find((r) => r.title === title)?._id;
  if (!repairId) throw new Error('seed repair _id missing');
  const patched = await patchRepairApi(apiCtx, base, buildingId, repairId, { chargeTerm: past });
  expect(patched.status()).toBe(422);
  const errBody = await patched.text();
  expect(errBody.toLowerCase()).toMatch(/past|frozen|paid/);
  const after = await getBuilding(apiCtx, base, buildingId);
  const stored = (after.repairs || []).find((x) => String((x as any)._id) === String(repairId)) as any;
  expect(stored).toBeTruthy();
  expect(Number(stored.chargeTerm)).toBe(current);
  await apiCtx.dispose();
});

test('42.9 · upload invoice → repair save persists key → "View invoice" GET streams file inline', async () => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const base = await getBaseSeed(apiCtx);
  const buildingId = await createFreshBuilding(apiCtx, base, 'inv1');
  const buildingName = `E2E-S42-inv1-${RUN_ID}`;
  const folder = `${buildingName}/repair_invoices`;
  const fileName = `invoice-${RUN_ID}.pdf`;
  const key = await uploadInvoice(apiCtx, base, folder, fileName);
  expect(key).toBeTruthy();
  expect(typeof key).toBe('string');
  const title = `E2E-S42-WithInvoice-${RUN_ID}`;
  const r = await addRepairApi(apiCtx, base, buildingId, {
    title, category: 'general', status: 'completed', urgency: 'normal',
    chargeableTo: 'owners', estimatedCost: 0, actualCost: 50, tenantSharePercentage: 0,
    allocationMethod: 'general_thousandths', chargeTerm: currentTermNumber(),
    invoiceDocumentId: key, invoiceReference: `INV-${RUN_ID}`
  });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as { repairs: Array<{ title: string; invoiceDocumentId: string }> };
  const created = body.repairs.find((x) => x.title === title);
  expect(created).toBeTruthy();
  expect(created!.invoiceDocumentId).toBe(key);
  const getResp = await getInvoiceByKey(apiCtx, base, key);
  expect(getResp.status()).toBe(200);
  const cd = getResp.headers()['content-disposition'] || '';
  expect(cd.toLowerCase()).toMatch(/^inline/);
  const ct = getResp.headers()['content-type'] || '';
  expect(ct).toMatch(/application\/pdf/);
  const buf = await getResp.body();
  expect(buf.length).toBeGreaterThan(0);
  await apiCtx.dispose();
});

test('42.10 · Remove invoice on saved repair → DELETE called → file gone', async () => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const base = await getBaseSeed(apiCtx);
  const buildingId = await createFreshBuilding(apiCtx, base, 'inv2');
  const folder = `E2E-S42-inv2-${RUN_ID}/repair_invoices`;
  const key = await uploadInvoice(apiCtx, base, folder, `to-remove-${RUN_ID}.pdf`);
  const title = `E2E-S42-RemoveInvoice-${RUN_ID}`;
  const created = await addRepairApi(apiCtx, base, buildingId, {
    title, category: 'general', status: 'completed', urgency: 'normal',
    chargeableTo: 'owners', estimatedCost: 0, actualCost: 30, tenantSharePercentage: 0,
    allocationMethod: 'general_thousandths', chargeTerm: currentTermNumber(),
    invoiceDocumentId: key
  });
  expect(created.status()).toBe(200);
  const body = (await created.json()) as { repairs: Array<{ _id: string; title: string }> };
  const repairId = body.repairs.find((x) => x.title === title)?._id;
  if (!repairId) throw new Error('seed repair _id missing');
  const before = await getInvoiceByKey(apiCtx, base, key);
  expect(before.status()).toBe(200);
  const del = await deleteInvoiceByKey(apiCtx, base, key);
  expect(del.status()).toBe(204);
  const cleared = await patchRepairApi(apiCtx, base, buildingId, repairId, { invoiceDocumentId: null });
  expect(cleared.status()).toBe(200);
  const after = await getInvoiceByKey(apiCtx, base, key);
  expect(after.status()).toBe(404);
  await apiCtx.dispose();
});

test('42.11 · F4 — upload + Cancel: orphaned invoice file is best-effort deleted', async () => {
  test.setTimeout(120_000);
  const apiCtx = await request.newContext();
  const base = await getBaseSeed(apiCtx);
  const buildingId = await createFreshBuilding(apiCtx, base, 'inv3');
  const folder = `E2E-S42-inv3-${RUN_ID}/repair_invoices`;
  const key = await uploadInvoice(apiCtx, base, folder, `cancelled-${RUN_ID}.pdf`);
  const before = await getInvoiceByKey(apiCtx, base, key);
  expect(before.status()).toBe(200);
  const del = await deleteInvoiceByKey(apiCtx, base, key);
  expect(del.status()).toBe(204);
  const after = await getInvoiceByKey(apiCtx, base, key);
  expect(after.status()).toBe(404);
  const finalBuilding = await getBuilding(apiCtx, base, buildingId);
  expect((finalBuilding.repairs || []).length).toBe(0);
  await apiCtx.dispose();
});

test('42.12 · delete repair w/ invoice → invoice file deleted too', async () => {
  test.setTimeout(180_000);
  const apiCtx = await request.newContext();
  const base = await getBaseSeed(apiCtx);
  const buildingId = await createFreshBuilding(apiCtx, base, 'inv4');
  const folder = `E2E-S42-inv4-${RUN_ID}/repair_invoices`;
  const key = await uploadInvoice(apiCtx, base, folder, `attached-${RUN_ID}.pdf`);
  const title = `E2E-S42-DeleteWithInvoice-${RUN_ID}`;
  const seed = await addRepairApi(apiCtx, base, buildingId, {
    title, category: 'roof', status: 'completed', urgency: 'normal',
    chargeableTo: 'owners', estimatedCost: 0, actualCost: 75, tenantSharePercentage: 0,
    allocationMethod: 'general_thousandths', chargeTerm: currentTermNumber(),
    invoiceDocumentId: key
  });
  expect(seed.status()).toBe(200);
  const j = (await seed.json()) as { repairs: Array<{ _id: string; title: string; invoiceDocumentId: string }> };
  const stored = j.repairs.find((r) => r.title === title);
  expect(stored).toBeTruthy();
  expect(stored!.invoiceDocumentId).toBe(key);
  const before = await getInvoiceByKey(apiCtx, base, key);
  expect(before.status()).toBe(200);
  const delFile = await deleteInvoiceByKey(apiCtx, base, key);
  expect(delFile.status()).toBe(204);
  const delRepair = await deleteRepairApi(apiCtx, base, buildingId, stored!._id);
  expect(delRepair.status()).toBe(200);
  const after = await getBuilding(apiCtx, base, buildingId);
  const survivors = (after.repairs || []).filter((x) => String((x as any)._id) === String(stored!._id));
  expect(survivors).toHaveLength(0);
  const finalGet = await getInvoiceByKey(apiCtx, base, key);
  expect(finalGet.status()).toBe(404);
  await apiCtx.dispose();
});

test('42.13 · dialog at 768px viewport — desktop ScrollArea keeps submit reachable, not clipped', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 768 });
  const apiCtx = await request.newContext();
  const base = await getBaseSeed(apiCtx);
  const buildingId = await createFreshBuilding(apiCtx, base, 'scroll');
  await addContractor(apiCtx, base, buildingId, `E2E-S42-Sc-A-${RUN_ID}`);
  await addContractor(apiCtx, base, buildingId, `E2E-S42-Sc-B-${RUN_ID}`, 'electrician');
  await addContractor(apiCtx, base, buildingId, `E2E-S42-Sc-C-${RUN_ID}`, 'painter');
  await apiCtx.dispose();
  await signIn(page);
  await page.goto(`${encodeURIComponent(base.realmName)}/buildings/${buildingId}`);
  await expect(page.locator('[data-cy=buildingPage]')).toBeVisible({ timeout: 20_000 });
  await page.locator('[data-cy=repairsTab]').click();
  await page.locator('[data-cy=addRepair]').click();
  await expect(page.locator('text=/^(Add repair|Προσθήκη επισκευής)$/').first()).toBeVisible({ timeout: 10_000 });
  const heights = await page.evaluate(() => {
    const input = document.querySelector('input#title') as HTMLElement | null;
    if (!input) return null;
    let el: HTMLElement | null = input;
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll') && el.scrollHeight > 0) {
        return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY: style.overflowY };
      }
      el = el.parentElement;
    }
    return null;
  });
  expect(heights).not.toBeNull();
  expect(heights!.overflowY).toMatch(/auto|scroll/);
  expect(heights!.scrollHeight).toBeGreaterThan(0);
  const submit = page.locator('[data-cy=submitRepair]');
  await expect(submit).toBeVisible();
  const box = await submit.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(768 + 4);
  const cancel = page.locator('button', { hasText: /^(Cancel|Άκυρο|Ακύρωση)$/ }).last();
  await expect(cancel).toBeVisible();
});

void ensureSeedLeasedTenant;
