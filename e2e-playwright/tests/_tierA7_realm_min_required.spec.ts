import { test, expect } from '@playwright/test';
import { getAccessToken } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

/**
 * Tier A7 — Realm min-required server validation.
 *
 * Server: services/api/src/managers/realmmanager.ts add() + _hasRequiredFields
 * Required at creation:
 *   - name (already enforced)
 *   - locale (already enforced via LOCALES enum)
 *   - currency (already enforced)
 *   - members[].role === 'administrator' (already enforced — caller email
 *     auto-injected as sole admin)
 *   - if isCompany=true: companyInfo.name + companyInfo.legalStructure +
 *     companyInfo.ein (NEW)
 *
 * The route POST /api/v2/realms creates a NEW realm and writes to the test
 * account's accessible-realm list. To avoid polluting the test account
 * with one-shot fixtures, every accept-case is followed by an immediate
 * DELETE. Reject-cases never persist.
 */

async function postRealm(request: any, token: string, body: any) {
  return request.post(`${GATEWAY}/api/v2/realms`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    data: body
  });
}

test.describe.serial('Tier A7: realm min-required at creation', () => {
  test('rejects company realm missing companyInfo.name', async ({ request }) => {
    const token = await getAccessToken(request);
    const r = await postRealm(request, token, {
      name: `E2E-A7-NoCoName-${Math.floor(Math.random() * 100000)}`,
      locale: 'el',
      currency: 'EUR',
      isCompany: true,
      companyInfo: { legalStructure: 'AE', ein: '123456789' }
    });
    expect(r.status(), 'company missing companyInfo.name').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('companyInfo.name');
  });

  test('rejects company realm missing legalStructure', async ({ request }) => {
    const token = await getAccessToken(request);
    const r = await postRealm(request, token, {
      name: `E2E-A7-NoLegal-${Math.floor(Math.random() * 100000)}`,
      locale: 'el',
      currency: 'EUR',
      isCompany: true,
      companyInfo: { name: 'Test SA', ein: '123456789' }
    });
    expect(r.status(), 'company missing legalStructure').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('legalStructure');
  });

  test('rejects company realm missing ein', async ({ request }) => {
    const token = await getAccessToken(request);
    const r = await postRealm(request, token, {
      name: `E2E-A7-NoEin-${Math.floor(Math.random() * 100000)}`,
      locale: 'el',
      currency: 'EUR',
      isCompany: true,
      companyInfo: { name: 'Test SA', legalStructure: 'AE' }
    });
    expect(r.status(), 'company missing ein').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('ein');
  });

  test('accepts personal-account realm without companyInfo', async ({ request }) => {
    const token = await getAccessToken(request);
    const unique = `E2E-A7-Personal-${Math.floor(Math.random() * 100000)}`;
    const r = await postRealm(request, token, {
      name: unique,
      locale: 'el',
      currency: 'EUR',
      isCompany: false
    });
    expect(r.status(), 'valid personal-account create').toBe(200);
    const body = await r.json();
    expect(body._id).toBeTruthy();
    expect(body.name).toBe(unique);

    // Cleanup: delete this realm so we don't pollute the test account
    await request.delete(`${GATEWAY}/api/v2/realms/${body._id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  });

  test('accepts company realm with all companyInfo fields', async ({ request }) => {
    const token = await getAccessToken(request);
    const unique = `E2E-A7-Company-${Math.floor(Math.random() * 100000)}`;
    const r = await postRealm(request, token, {
      name: unique,
      locale: 'el',
      currency: 'EUR',
      isCompany: true,
      companyInfo: {
        name: 'Test SA',
        legalStructure: 'AE',
        ein: '987654321'
      }
    });
    expect(r.status(), 'valid company create').toBe(200);
    const body = await r.json();
    expect(body._id).toBeTruthy();

    // Cleanup
    await request.delete(`${GATEWAY}/api/v2/realms/${body._id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  });
});
