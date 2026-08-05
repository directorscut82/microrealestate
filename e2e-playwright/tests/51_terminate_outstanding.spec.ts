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
  for (const id of tenantIds) {
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

  await expect(dialog.getByText(/Χρήματα που παραμένουν ανοιχτά/)).toBeVisible({ timeout: 10000 });
  await expect(dialog.getByText(/ανεξόφλητοι μήνες έως τον τερματισμό/)).toBeVisible();
  await expect(dialog.getByText(/ΜΕΤΑ την ημερομηνία τερματισμού/)).toBeVisible();
  await expect(dialog.getByText(/Εγγύηση που κρατείται/)).toBeVisible();
  await expect(dialog.getByText(/Διαγραφή των/)).toBeVisible();

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
