import { test, expect } from '@playwright/test';
import { ensureSeed, ensureSeedLease } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

/**
 * Tier D — cross-entity bugs:
 *  - D-B5: terminationDate === beginDate → 422 (was silently accepted).
 *  - D-B6: energyCertificate.issueDate distinguishes invalid from future.
 */

const VALID_AFM = '123456783'; // checksum-valid

test.describe.serial('Tier D: cross-entity validators', () => {
  test('D-B5: rejects PATCH with terminationDate === beginDate', async ({ request }) => {
    const seed = await ensureSeed(request);
    const lease = await ensureSeedLease(request);
    const auth = {
      Authorization: `Bearer ${seed.token}`,
      'Content-Type': 'application/json',
      organizationid: seed.realmId
    };
    // Create a dedicated property so we don't collide with leftover
    // tenant fixtures from prior runs holding E2E-Property.
    const propUnique = `E2E-D5-Prop-${Math.floor(Math.random() * 100000)}`;
    const propCreate = await request.post(`${GATEWAY}/api/v2/properties`, {
      headers: auth,
      data: {
        name: propUnique,
        type: 'apartment',
        surface: 50,
        address: { street1: 'Test', city: 'Athens', zipCode: '12345' }
      }
    });
    expect(propCreate.status(), 'create dedicated property').toBe(200);
    const propDoc = await propCreate.json();

    const unique = `E2E-D5-${Math.floor(Math.random() * 100000)}`;
    // Create a tenant first
    const create = await request.post(`${GATEWAY}/api/v2/tenants`, {
      headers: auth,
      data: {
        name: unique,
        firstName: 'D5',
        lastName: unique,
        taxId: VALID_AFM,
        manager: unique,
        beginDate: '01/01/2026',
        endDate: '31/12/2026',
        leaseId: lease.leaseId,
        isCompany: false,
        properties: [
          {
            propertyId: propDoc._id,
            entryDate: '01/01/2026',
            exitDate: '31/12/2026',
            rent: 100
          }
        ]
      }
    });
    expect(create.status(), 'create tenant').toBe(200);
    const created = await create.json();

    // PATCH with terminationDate === beginDate
    const patch = await request.patch(`${GATEWAY}/api/v2/tenants/${created._id}`, {
      headers: auth,
      data: {
        ...created,
        terminationDate: '01/01/2026' // same as beginDate
      }
    });
    expect(patch.status(), 'termination==begin').toBeGreaterThanOrEqual(400);
    expect([422, 400]).toContain(patch.status());

    // Cleanup tenant first (delete is denied if there are payments — none here)
    await request.delete(`${GATEWAY}/api/v2/tenants`, {
      headers: auth,
      data: { ids: [created._id] }
    });
    // Then the dedicated property
    await request.delete(`${GATEWAY}/api/v2/properties`, {
      headers: auth,
      data: { ids: [propDoc._id] }
    });
  });

  test('D-B6: rejects property energyCertificate with invalid date string', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await request.post(`${GATEWAY}/api/v2/properties`, {
      headers: {
        Authorization: `Bearer ${seed.token}`,
        organizationid: seed.realmId,
        'Content-Type': 'application/json'
      },
      data: {
        name: `E2E-D6-Bad-${Math.floor(Math.random() * 100000)}`,
        type: 'apartment',
        surface: 50,
        address: { street1: 'Test', city: 'Athens', zipCode: '12345' },
        energyCertificate: { issueDate: 'not-a-date' }
      }
    });
    expect(r.status(), 'invalid energyCertificate.issueDate').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toMatch(/energyCertificate|valid date/i);
  });

  test('D-B6: rejects property energyCertificate.issueDate set in the future', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await request.post(`${GATEWAY}/api/v2/properties`, {
      headers: {
        Authorization: `Bearer ${seed.token}`,
        organizationid: seed.realmId,
        'Content-Type': 'application/json'
      },
      data: {
        name: `E2E-D6-Future-${Math.floor(Math.random() * 100000)}`,
        type: 'apartment',
        surface: 50,
        address: { street1: 'Test', city: 'Athens', zipCode: '12345' },
        energyCertificate: { issueDate: '2099-01-01' }
      }
    });
    expect(r.status(), 'future energyCertificate.issueDate').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('future');
  });
});
