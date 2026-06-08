import { test, expect } from '@playwright/test';
import { ensureSeed } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

/**
 * Tier C — format validators (server-side):
 *  - C1 AFM checksum on tenant creation.
 *  - C2 Greek postal code (5 digits) on property + building creation.
 *  - C3 IBAN mod-97 on building.bankInfo.iban (optional but, when set,
 *       must be valid).
 */

async function postTenant(request: any, seed: any, body: any) {
  return request.post(`${GATEWAY}/api/v2/tenants`, {
    headers: {
      Authorization: `Bearer ${seed.token}`,
      organizationid: seed.realmId,
      'Content-Type': 'application/json'
    },
    data: body
  });
}
async function postProperty(request: any, seed: any, body: any) {
  return request.post(`${GATEWAY}/api/v2/properties`, {
    headers: {
      Authorization: `Bearer ${seed.token}`,
      organizationid: seed.realmId,
      'Content-Type': 'application/json'
    },
    data: body
  });
}
async function postBuilding(request: any, seed: any, body: any) {
  return request.post(`${GATEWAY}/api/v2/buildings`, {
    headers: {
      Authorization: `Bearer ${seed.token}`,
      organizationid: seed.realmId,
      'Content-Type': 'application/json'
    },
    data: body
  });
}

test.describe.serial('Tier C: format validators', () => {
  test('C1: rejects tenant with bad AFM checksum', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await postTenant(request, seed, {
      name: `E2E-C1-Bad-${Math.floor(Math.random() * 100000)}`,
      firstName: 'Bad',
      lastName: 'AFM',
      taxId: '111111111', // 9 digits but invalid checksum (1 != ((sum%11)%10))
      manager: 'Bad AFM',
      beginDate: '01/01/2026',
      isCompany: false
    });
    expect(r.status(), 'bad AFM checksum').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toMatch(/AFM|taxId/);
  });

  test('C1: accepts tenant with valid AFM checksum', async ({ request }) => {
    const seed = await ensureSeed(request);
    // 090000045 = (0,9,0,0,0,0,0,4) weighted sum...
    // Pick a known-good AFM by computing one:
    const digits = [1, 2, 3, 4, 5, 6, 7, 8];
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += digits[i] * Math.pow(2, 8 - i);
    const check = (sum % 11) % 10;
    const validAfm = digits.join('') + check.toString();
    const unique = `E2E-C1-Valid-${Math.floor(Math.random() * 100000)}`;
    const r = await postTenant(request, seed, {
      name: unique,
      firstName: 'Valid',
      lastName: unique,
      taxId: validAfm,
      manager: unique,
      beginDate: '01/01/2026',
      isCompany: false
    });
    expect(r.status(), `valid AFM ${validAfm}`).toBe(200);
    const body = await r.json();
    await request.delete(`${GATEWAY}/api/v2/tenants`, {
      headers: {
        Authorization: `Bearer ${seed.token}`,
        organizationid: seed.realmId,
        'Content-Type': 'application/json'
      },
      data: { ids: [body._id] }
    });
  });

  test('C2: rejects property with non-5-digit postal code', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await postProperty(request, seed, {
      name: `E2E-C2-Prop-${Math.floor(Math.random() * 100000)}`,
      type: 'apartment',
      surface: 50,
      address: { street1: 'Test', city: 'Athens', zipCode: '1234' } // 4 digits
    });
    expect(r.status(), 'bad postal code on property').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('zipCode');
  });

  test('C2: rejects building with non-5-digit postal code', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await postBuilding(request, seed, {
      name: `E2E-C2-Bldg-${Math.floor(Math.random() * 100000)}`,
      atakPrefix: `${Math.floor(Math.random() * 100000000)}`,
      address: { street1: 'Test', city: 'Athens', zipCode: 'ABCDE' }
    });
    expect(r.status(), 'non-numeric postal code').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('zipCode');
  });

  test('C3: rejects building with malformed IBAN', async ({ request }) => {
    const seed = await ensureSeed(request);
    const unique = Math.floor(Math.random() * 100000000).toString();
    const r = await postBuilding(request, seed, {
      name: `E2E-C3-Bldg-${unique}`,
      atakPrefix: unique,
      address: { street1: 'Test', city: 'Athens', zipCode: '12345' },
      bankInfo: { iban: 'GR00 1234 5678' } // structurally invalid
    });
    expect(r.status(), 'malformed IBAN').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('iban');
  });

  test('C3: accepts building with valid IBAN (Greek 27-char)', async ({ request }) => {
    const seed = await ensureSeed(request);
    const unique = Math.floor(Math.random() * 100000000).toString();
    const r = await postBuilding(request, seed, {
      name: `E2E-C3-Bldg-Valid-${unique}`,
      atakPrefix: unique,
      address: { street1: 'Test', city: 'Athens', zipCode: '12345' },
      // Known-good Greek IBAN — valid under mod-97.
      // Source: https://en.wikipedia.org/wiki/International_Bank_Account_Number
      bankInfo: { iban: 'GR1601101250000000012300695' }
    });
    expect(r.status(), 'valid Greek IBAN').toBe(200);
    const body = await r.json();
    await request.delete(`${GATEWAY}/api/v2/buildings`, {
      headers: {
        Authorization: `Bearer ${seed.token}`,
        organizationid: seed.realmId,
        'Content-Type': 'application/json'
      },
      data: { ids: [body._id] }
    });
  });
});
