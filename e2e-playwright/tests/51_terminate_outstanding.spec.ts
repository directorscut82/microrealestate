import { expect, test } from '@playwright/test';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

/**
 * Step 5b: terminate-with-money-open. Creates a tenant who genuinely owes rent,
 * opens the terminate dialog, and reads the Greek figures on screen.
 */
const BASE = process.env.GATEWAY_URL || 'http://192.168.0.96:1350';
const ACCOUNT_FILE = path.resolve(__dirname, '../../.secrets/landlord-account');
const account: Record<string, string> = fs.existsSync(ACCOUNT_FILE)
  ? dotenv.parse(fs.readFileSync(ACCOUNT_FILE))
  : {};
const EMAIL = process.env.LANDLORD_EMAIL || account.EMAIL || '';
const PASSWORD = process.env.LANDLORD_PASSWORD || account.PASSWORD || '';
const REALM = process.env.LANDLORD_REALM || account.REALM || 'landlord';
const STAMP = String(Date.now()).slice(-6);

let token = '';
let orgId = '';
const propIds: string[] = [];
const tenantIds: string[] = [];

async function api(method: string, route: string, body?: unknown) {
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
  const txt = await res.text();
  let json: any = null;
  try { json = txt ? JSON.parse(txt) : null; } catch { json = txt; }
  return { status: res.status, json };
}

function syntheticTaxId(): string {
  const digits = [9, 9, 9, 0, 0, 0, 0, 2];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += digits[i] * Math.pow(2, 8 - i);
  return digits.join('') + String((sum % 11) % 10);
}

test.beforeAll(async () => {
  const r = await fetch(`${BASE}/api/v2/authenticator/landlord/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD })
  });
  token = (await r.json()).accessToken;
  expect(token).toBeTruthy();
  const realms = await (await fetch(`${BASE}/api/v2/realms`, {
    headers: { Authorization: `Bearer ${token}`, Origin: BASE }
  })).json();
  orgId = ((realms || []).find((x: any) => x.name === REALM) || realms[0])._id;
});

test.afterAll(async () => {
  // T2's write-off leaves a recorded discount on 4 months, and DELETE /tenants
  // refuses a tenant whose rents carry money ("some rents have been paid") —
  // that guard is correct, so the first version of this teardown leaked 5
  // tenants + 5 properties into the live realm. Strip every promo/discount and
  // payment first, then delete; properties only release once no tenant refers
  // to them.
  for (const id of tenantIds) {
    const ledger = await api('GET', `/rents/tenant/${id}`);
    const dirty = (ledger.json?.rents || []).filter(
      (r: any) =>
        Number(r.discount) > 0 ||
        Number(r.promo) > 0 ||
        (r.payments || []).length > 0
    );
    for (const r of dirty) {
      const term = String(r.term);
      await api('PATCH', `/rents/payment/${id}/${term}`, {
        _id: id,
        month: Number(term.slice(4, 6)),
        year: Number(term.slice(0, 4)),
        payments: [],
        description: '',
        extracharge: 0,
        noteextracharge: '',
        promo: 0,
        notepromo: ''
      });
    }
    const r = await api('DELETE', `/tenants/${id}`);
    if (r.status !== 200) console.log('CLEANUP tenant', r.status, JSON.stringify(r.json).slice(0, 90));
  }
  for (const id of propIds) {
    const r = await api('DELETE', `/properties/${id}`);
    if (r.status !== 200) console.log('CLEANUP prop', r.status, JSON.stringify(r.json).slice(0, 90));
  }
});

test('T1 terminating with unpaid rent shows the open money and offers a write-off', async ({ page }) => {
  // A lease that STARTED last year and runs into next year, never paid → real
  // arrears both before and after any termination date in between.
  const prop = await api('POST', '/properties', {
    name: `E2E-TERM-PROP-${STAMP}`,
    type: 'apartment', surface: 60, rent: 400,
    address: { street1: 'ΟΔΟΣ ΔΟΚΙΜΗΣ 2', zipCode: '11111', city: 'ΔΟΚΙΜΗ' }
  });
  expect(prop.status, JSON.stringify(prop.json)).toBe(200);
  propIds.push(prop.json._id);

  const y = new Date().getFullYear();
  const tenant = await api('POST', '/tenants', {
    name: `E2E-TERM-${STAMP}`,
    isCompany: false, firstName: 'E2E', lastName: `TERM-${STAMP}`,
    taxId: syntheticTaxId(),
    beginDate: `01/01/${y}`,
    endDate: `31/12/${y + 1}`,
    guaranty: 800,
    properties: [{ propertyId: prop.json._id, rent: 400 }]
  });
  expect(tenant.status, JSON.stringify(tenant.json)).toBe(200);
  tenantIds.push(tenant.json._id);

  await page.goto(`${BASE}/landlord/el/signin`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/Email/i).fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /Σύνδεση/ }).click();
  await page.waitForURL(/\/landlord\/el\/(?!signin)/, { timeout: 45000 });

  await page.goto(`${BASE}/landlord/el/${REALM}/tenants/${tenant.json._id}`, {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: /Τερματισμός/ }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });

  // Pick a termination date mid-lease so there are unpaid months on BOTH sides.
  await dialog.locator('#terminationDate').fill(`${y}-06-30`);
  await page.waitForTimeout(1200);

  await expect(dialog.getByText(/Οφειλές που παραμένουν/)).toBeVisible({ timeout: 10000 });
  await expect(dialog.getByText(/ανεξόφλητοι μήνες έως τον τερματισμό/)).toBeVisible();
  await expect(dialog.getByText(/ΜΕΤΑ την ημερομηνία τερματισμού/)).toBeVisible();
  await expect(dialog.getByText(/Παρακρατούμενη εγγύηση/)).toBeVisible();
  await expect(dialog.getByText(/Λογιστική διαγραφή των/)).toBeVisible();

  // The FIGURE must be right, not merely present. `totalToPay` includes the
  // carried balance, so a naive per-month sum overstates the debt (measured
  // 6,5x on live data). The engine's own authority is -newBalance at the cut
  // term; assert the panel agrees with it.
  const ledger = await api('GET', `/rents/tenant/${tenant.json._id}`);
  const rents = (ledger.json?.rents || [])
    .slice()
    .sort((a: any, b: any) => a.term - b.term);
  const cutTerm = Number(`${y}06`);
  const keptRents = rents.filter(
    (r: any) => Math.floor(Number(r.term) / 10000) <= cutTerm
  );
  const last = keptRents[keptRents.length - 1];
  const engineKept =
    Math.round(Math.max(0, -(Number(last?.newBalance) || 0)) * 100) / 100;
  expect(engineKept, 'the fixture must actually owe money up to the cut').toBeGreaterThan(0);

  const panel = await dialog
    .getByText(/ανεξόφλητοι μήνες έως τον τερματισμό/)
    .innerText();
  console.log('ENGINE_KEPT', engineKept, '| PANEL_TEXT', panel);
  // Greek locale renders 1.336,00 € — normalise to a comparable number.
  const shown = (panel.match(/([\d.,]+)\s*€/) || [])[1] || '';
  const shownNum = Number(shown.replace(/\./g, '').replace(',', '.'));
  expect(shownNum, `panel showed ${shown} for engine ${engineKept}`).toBeCloseTo(
    engineKept,
    2
  );

  await page.screenshot({ path: '/tmp/t1-terminate-open-money.png' });
});

test('T2 the write-off records a settlement discount and clears the arrears', async ({
  page
}) => {
  // Independent fixture: T1's tenant is untouched so its panel assertions stay
  // reproducible. Same shape — a year-long unpaid lease with a deposit.
  const prop = await api('POST', '/properties', {
    name: `E2E-WOFF-PROP-${STAMP}`,
    type: 'apartment', surface: 55, rent: 300,
    address: { street1: 'ΟΔΟΣ ΒΗΤΑ 3', zipCode: '11111', city: 'ΔΟΚΙΜΗ' }
  });
  expect(prop.status, JSON.stringify(prop.json)).toBe(200);
  propIds.push(prop.json._id);

  const y = new Date().getFullYear();
  const tenant = await api('POST', '/tenants', {
    name: `E2E-WOFF-${STAMP}`,
    isCompany: false, firstName: 'E2E', lastName: `WOFF-${STAMP}`,
    taxId: syntheticTaxId(),
    beginDate: `01/01/${y}`,
    endDate: `31/12/${y}`,
    guaranty: 300,
    properties: [{ propertyId: prop.json._id, rent: 300 }]
  });
  expect(tenant.status, JSON.stringify(tenant.json)).toBe(200);
  tenantIds.push(tenant.json._id);

  const cutTerm = Number(`${y}04`);
  const before = await api('GET', `/rents/tenant/${tenant.json._id}`);
  const bRents = (before.json?.rents || [])
    .slice()
    .sort((a: any, b: any) => a.term - b.term)
    .filter((r: any) => Math.floor(Number(r.term) / 10000) <= cutTerm);
  const engineBefore =
    Math.round(
      Math.max(0, -(Number(bRents[bRents.length - 1]?.newBalance) || 0)) * 100
    ) / 100;
  expect(engineBefore, 'the fixture must owe money up to the cut').toBeGreaterThan(0);
  console.log('ARREARS_BEFORE', engineBefore);

  await page.goto(`${BASE}/landlord/el/signin`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/Email/i).fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /Σύνδεση/ }).click();
  await page.waitForURL(/\/landlord\/el\/(?!signin)/, { timeout: 45000 });

  await page.goto(`${BASE}/landlord/el/${REALM}/tenants/${tenant.json._id}`, {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /Τερματισμός/ }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });
  await dialog.locator('#terminationDate').fill(`${y}-04-30`);
  await page.waitForTimeout(1200);

  // Tick the write-off, then terminate.
  const box = dialog.locator('input[type="checkbox"]').first();
  await expect(box).toBeVisible({ timeout: 10000 });
  await box.check();
  // Ticking it must disclose the limit measured below: the discount settles each
  // month, but later months keep their carried balance. Without this on screen the
  // landlord reads the unchanged trailing total as a failed write-off.
  await expect(
    dialog.getByText(/το μεταφερόμενο υπόλοιπο των επόμενων μηνών δεν ανακαθορίζεται/)
  ).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: '/tmp/t2-writeoff-caveat.png' });
  await dialog.getByRole('button', { name: /^Τερματισμός$/ }).click();

  await expect(dialog).toBeHidden({ timeout: 30000 });
  await page.waitForTimeout(2500);

  // PRIMARY ARTIFACT: the ledger the server wrote.
  const after = await api('GET', `/rents/tenant/${tenant.json._id}`);
  const aRents = (after.json?.rents || [])
    .slice()
    .sort((a: any, b: any) => a.term - b.term);

  // 1. The termination landed.
  expect(after.json?.occupant?.terminationDate, 'termination must be recorded').toBeTruthy();

  // 2. Months after the cut are gone (Contract.create truncates at the cut).
  const past = aRents.filter(
    (r: any) => Math.floor(Number(r.term) / 10000) > cutTerm
  );
  console.log('MONTHS_AFTER_CUT_REMAINING', past.length);
  expect(past.length, 'terminating truncates the series at the cut').toBe(0);

  // 3. The write-off is RECORDED as a discount, not silently dropped.
  const discounted = aRents.filter((r: any) => Number(r.discount) > 0);
  const totalDiscount =
    Math.round(
      discounted.reduce((s: number, r: any) => s + (Number(r.discount) || 0), 0) * 100
    ) / 100;
  console.log(
    'DISCOUNTED_MONTHS', discounted.length,
    'TOTAL_DISCOUNT', totalDiscount,
    'NOTES', JSON.stringify(aRents.map((r: any) => r.notepromo).filter(Boolean))
  );
  expect(discounted.length, 'the write-off must record a discount').toBeGreaterThan(0);

  // 4. Each written-off month is individually settled. NOT asserted: that the
  //    tenant's trailing cumulative balance drops to zero. Measured on the live
  //    engine — a discount zeroes its OWN month, but the carried `balance` baked
  //    into later months is deliberately NOT rebuilt: the forward carry-in sweep
  //    skips frozen rents (contract.ts:218) and a past unpaid term is always
  //    frozen ("closed months are immutable; arrears adjust via settlements, not
  //    re-pricing", contract.ts payTerm). A plain tenant PATCH does not rebuild
  //    it either. So the correct, design-conformant assertion is per written-off
  //    month, not on the trailing carry.
  const writtenOff = aRents.filter(
    (r: any) => Number(r.discount) > 0
  );
  for (const r of writtenOff) {
    const own =
      Math.round(
        ((Number(r.totalToPay) || 0) - (Number(r.balance) || 0)) * 100
      ) / 100;
    expect(
      own,
      `month ${r.term} own charge must be settled by the write-off (was ${own})`
    ).toBeLessThan(0.02);
  }
  expect(
    Math.round(
      writtenOff.reduce((s: number, r: any) => s + (Number(r.discount) || 0), 0) * 100
    ) / 100,
    'the recorded discount must equal the arrears the panel offered to write off'
  ).toBeCloseTo(engineBefore, 2);

  const last = aRents[aRents.length - 1];
  console.log(
    'ARREARS_AFTER (trailing carry, intentionally not zero)',
    Math.round(Math.max(0, -(Number(last?.newBalance) || 0)) * 100) / 100
  );

  await page.screenshot({ path: '/tmp/t2-writeoff-done.png' });
});

test('T3 a single unpaid month renders GREEK SINGULAR, not "1 ανεξόφλητοι μήνες"', async ({
  page
}) => {
  // Regression for a defect proven in the browser: the count strings had no
  // _one sibling, so next-translate fell through to the plural and rendered
  // «1 ανεξόφλητοι μήνες» — a numeral 1 against a plural adjective+noun. The app
  // already had 15 _one/_other families; these two keys just ignored the
  // convention. A 2-month lease cut after month 1 gives exactly one kept month
  // and one dropped month, exercising BOTH singular branches at once.
  const prop = await api('POST', '/properties', {
    name: `E2E-SING-PROP-${STAMP}`,
    type: 'apartment', surface: 45, rent: 250,
    address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1', zipCode: '11111', city: 'ΔΟΚΙΜΗ' }
  });
  expect(prop.status, JSON.stringify(prop.json)).toBe(200);
  propIds.push(prop.json._id);

  // The lease must still be RUNNING: a lease whose endDate is in the past shows
  // «Τερματισμένο» and has no Τερματισμός button at all (observed on screen).
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yy = now.getFullYear();
  const nextMonth = new Date(yy, now.getMonth() + 2, 0); // last day of next month
  const endDate = `${String(nextMonth.getDate()).padStart(2, '0')}/${String(
    nextMonth.getMonth() + 1
  ).padStart(2, '0')}/${nextMonth.getFullYear()}`;

  const tenant = await api('POST', '/tenants', {
    name: `E2E-SING-${STAMP}`,
    isCompany: false, firstName: 'E2E', lastName: `SING-${STAMP}`,
    taxId: syntheticTaxId(),
    beginDate: `01/${mm}/${yy}`,
    endDate,
    guaranty: 250,
    properties: [{ propertyId: prop.json._id, rent: 250 }]
  });
  expect(tenant.status, JSON.stringify(tenant.json)).toBe(200);
  tenantIds.push(tenant.json._id);

  await page.goto(`${BASE}/landlord/el/signin`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/Email/i).fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /Σύνδεση/ }).click();
  await page.waitForURL(/\/landlord\/el\/(?!signin)/, { timeout: 45000 });
  await page.goto(`${BASE}/landlord/el/${REALM}/tenants/${tenant.json._id}`, {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /Τερματισμός/ }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });

  // Cut at the end of the CURRENT month → 1 kept, 1 dropped.
  const lastDayThis = new Date(yy, now.getMonth() + 1, 0).getDate();
  await dialog.locator('#terminationDate').fill(`${yy}-${mm}-${lastDayThis}`);
  await page.waitForTimeout(1500);

  const panelText = await dialog
    .locator('div')
    .filter({ hasText: /ανεξόφλητ/ })
    .last()
    .innerText();
  console.log('SINGULAR_PANEL', JSON.stringify(panelText));

  // The bug, stated as an assertion: a plural noun must never follow "1".
  expect(panelText, 'plural must not follow the numeral 1').not.toMatch(
    /\b1 ανεξόφλητοι μήνες/
  );
  expect(panelText).toMatch(/1 ανεξόφλητος μήνας/);

  await page.screenshot({ path: '/tmp/t3-singular.png' });
});
