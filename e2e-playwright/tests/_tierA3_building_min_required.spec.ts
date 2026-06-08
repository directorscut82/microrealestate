import { test, expect } from '@playwright/test';
import { ensureSeed } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

/**
 * Tier A3 — Building min-required server validation.
 *
 * Server: services/api/src/managers/buildingmanager.ts add()
 * Required at creation:
 *   - name (already enforced)
 *   - atakPrefix (already enforced)
 *   - address.street1, address.city, address.zipCode (NEW)
 *
 * Units / manager / bankInfo intentionally stay optional — Tier B9 surfaces
 * them as a tile warning ("Ελλειπή στοιχεία (X)"), not a creation block.
 *
 * E9 import path (in buildingmanager itself, around line 1159) bypasses
 * this add() and creates Buildings directly via `new Collections.Building`
 * with parsed address; imports remain unaffected.
 */

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

test.describe.serial('Tier A3: building min-required at creation', () => {
  test('rejects payload missing address.street1', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await postBuilding(request, seed, {
      name: `E2E-A3-NoStreet-${Math.floor(Math.random() * 100000)}`,
      atakPrefix: `${Math.floor(Math.random() * 100000000)}`,
      address: { city: 'Athens', zipCode: '11111' }
    });
    expect(r.status(), 'missing street1').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('street1');
  });

  test('rejects payload missing address.city', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await postBuilding(request, seed, {
      name: `E2E-A3-NoCity-${Math.floor(Math.random() * 100000)}`,
      atakPrefix: `${Math.floor(Math.random() * 100000000)}`,
      address: { street1: 'Test 12', zipCode: '11111' }
    });
    expect(r.status(), 'missing city').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('city');
  });

  test('rejects payload missing address.zipCode', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await postBuilding(request, seed, {
      name: `E2E-A3-NoZip-${Math.floor(Math.random() * 100000)}`,
      atakPrefix: `${Math.floor(Math.random() * 100000000)}`,
      address: { street1: 'Test 12', city: 'Athens' }
    });
    expect(r.status(), 'missing zipCode').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('zipCode');
  });

  test('accepts a valid building payload (no units)', async ({ request }) => {
    const seed = await ensureSeed(request);
    const unique = Math.floor(Math.random() * 100000000).toString();
    const r = await postBuilding(request, seed, {
      name: `E2E-A3-Valid-${unique}`,
      atakPrefix: unique,
      address: {
        street1: 'Test 5',
        city: 'Athens',
        zipCode: '12345'
      }
    });
    expect(r.status(), 'valid create').toBe(200);
    const body = await r.json();
    expect(body._id).toBeTruthy();
    expect(body.address.street1).toBe('Test 5');
    expect(body.address.city).toBe('Athens');
    expect(body.address.zipCode).toBe('12345');

    // Cleanup
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
