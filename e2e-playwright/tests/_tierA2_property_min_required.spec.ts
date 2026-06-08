import { test, expect } from '@playwright/test';
import { ensureSeed } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

/**
 * Tier A2 — Property min-required server validation.
 *
 * Server: services/api/src/managers/propertymanager.ts add()
 * Required at creation:
 *   - name (already enforced)
 *   - type (already enforced via PROPERTY_TYPES enum)
 *   - surface (already enforced, type-aware lower bound)
 *   - address.street1, address.city, address.zipCode (NEW)
 *
 * Rent (price) stays optional per user instruction (rent changes; not
 * required at creation).
 *
 * E9 import path bypasses propertymanager.add() and creates via
 * Collections.Property.create() directly with address from the building,
 * so import flow is unaffected.
 */

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

test.describe.serial('Tier A2: property min-required at creation', () => {
  test('rejects payload missing address.street1', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await postProperty(request, seed, {
      name: 'E2E-A2-NoStreet',
      type: 'apartment',
      surface: 50,
      address: { city: 'Athens', zipCode: '11111' }
    });
    expect(r.status(), 'missing street1').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('street1');
  });

  test('rejects payload missing address.city', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await postProperty(request, seed, {
      name: 'E2E-A2-NoCity',
      type: 'apartment',
      surface: 50,
      address: { street1: 'Test 12', zipCode: '11111' }
    });
    expect(r.status(), 'missing city').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('city');
  });

  test('rejects payload missing address.zipCode', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await postProperty(request, seed, {
      name: 'E2E-A2-NoZip',
      type: 'apartment',
      surface: 50,
      address: { street1: 'Test 12', city: 'Athens' }
    });
    expect(r.status(), 'missing zipCode').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('zipCode');
  });

  test('accepts a valid property payload (rent omitted)', async ({ request }) => {
    const seed = await ensureSeed(request);
    const unique = `E2E-A2-Valid-${Math.floor(Math.random() * 100000)}`;
    const r = await postProperty(request, seed, {
      name: unique,
      type: 'apartment',
      surface: 60,
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
    await request.delete(`${GATEWAY}/api/v2/properties`, {
      headers: {
        Authorization: `Bearer ${seed.token}`,
        organizationid: seed.realmId,
        'Content-Type': 'application/json'
      },
      data: { ids: [body._id] }
    });
  });
});
