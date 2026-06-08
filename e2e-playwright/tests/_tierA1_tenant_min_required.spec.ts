import { test, expect } from '@playwright/test';
import { ensureSeed } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

/**
 * Tier A1 — Tenant min-required server validation.
 *
 * Server: services/api/src/managers/occupantmanager.ts add()
 * - Natural person: firstName + lastName + taxId required
 * - Legal entity: company + legalForm + taxId required
 * - taxId always required
 *
 * AADE PDF imports must continue to succeed because they carry these
 * fields. Phone/email are NOT validated here — those are warnings on
 * the tile post-create (Tier B9 + Tier C3).
 */

test.describe.serial('Tier A1: tenant min-required at creation', () => {
  test('rejects payload missing firstName', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await request.post(`${GATEWAY}/api/v2/tenants`, {
      headers: {
        Authorization: `Bearer ${seed.token}`,
        organizationid: seed.realmId,
        'Content-Type': 'application/json'
      },
      data: {
        name: 'No Firstname',
        lastName: 'Onlylast',
        taxId: '123456789',
        beginDate: '01/01/2026',
        isCompany: false
      }
    });
    expect(r.status(), 'missing firstName').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('firstName');
  });

  test('rejects payload missing lastName', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await request.post(`${GATEWAY}/api/v2/tenants`, {
      headers: {
        Authorization: `Bearer ${seed.token}`,
        organizationid: seed.realmId,
        'Content-Type': 'application/json'
      },
      data: {
        name: 'Onlyfirst',
        firstName: 'Onlyfirst',
        taxId: '123456789',
        beginDate: '01/01/2026',
        isCompany: false
      }
    });
    expect(r.status(), 'missing lastName').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('lastName');
  });

  test('rejects payload missing taxId', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await request.post(`${GATEWAY}/api/v2/tenants`, {
      headers: {
        Authorization: `Bearer ${seed.token}`,
        organizationid: seed.realmId,
        'Content-Type': 'application/json'
      },
      data: {
        name: 'Test NoTax',
        firstName: 'Test',
        lastName: 'NoTax',
        beginDate: '01/01/2026',
        isCompany: false
      }
    });
    expect(r.status(), 'missing taxId').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('taxId');
  });

  test('rejects company payload missing legalForm', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await request.post(`${GATEWAY}/api/v2/tenants`, {
      headers: {
        Authorization: `Bearer ${seed.token}`,
        organizationid: seed.realmId,
        'Content-Type': 'application/json'
      },
      data: {
        name: 'Acme SA',
        company: 'Acme SA',
        taxId: '987654321',
        beginDate: '01/01/2026',
        isCompany: true
      }
    });
    expect(r.status(), 'company without legalForm').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('legalForm');
  });

  test('accepts a valid natural-person payload', async ({ request }) => {
    const seed = await ensureSeed(request);
    const unique = `E2E-A1-Valid-${Math.floor(Math.random() * 100000)}`;
    const r = await request.post(`${GATEWAY}/api/v2/tenants`, {
      headers: {
        Authorization: `Bearer ${seed.token}`,
        organizationid: seed.realmId,
        'Content-Type': 'application/json'
      },
      data: {
        name: unique,
        firstName: 'Tier',
        lastName: unique,
        taxId: '111222333',
        manager: unique,
        beginDate: '01/01/2026',
        stepperMode: true,
        isCompany: false
      }
    });
    expect(r.status(), 'valid create').toBe(200);
    const body = await r.json();
    expect(body._id).toBeTruthy();

    // Cleanup: archive the tenant immediately (we don't want test fixtures
    // accumulating). Per fix-discipline, mongo readback first to confirm
    // the document exists, then archive (delete is denied if there are
    // payments).
    const got = await request.get(`${GATEWAY}/api/v2/tenants/${body._id}`, {
      headers: {
        Authorization: `Bearer ${seed.token}`,
        organizationid: seed.realmId
      }
    });
    expect(got.status()).toBe(200);
    const tenantDoc = await got.json();
    expect(tenantDoc.firstName).toBe('Tier');
    expect(tenantDoc.lastName).toBe(unique);
    expect(tenantDoc.taxId).toBe('111222333');

    await request.delete(`${GATEWAY}/api/v2/tenants`, {
      headers: {
        Authorization: `Bearer ${seed.token}`,
        organizationid: seed.realmId,
        'Content-Type': 'application/json'
      },
      data: { ids: [body._id] }
    });
  });
});
