import { test, expect } from '@playwright/test';
import { ensureSeed } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

/**
 * Tier A4 — Lease min-required server validation.
 *
 * Server: services/api/src/managers/leasemanager.ts add()
 * Required at creation:
 *   - name (already enforced — trimmed, non-empty, unique within realm)
 *   - numberOfTerms (already required, ≥1, ≤1000)
 *   - timeRange (NOW required — was silently optional, made the lease
 *     undriveable downstream)
 *
 * Duplicate-name guard within realm already in place (Wave-24 B11).
 */

async function postLease(request: any, seed: any, body: any) {
  return request.post(`${GATEWAY}/api/v2/leases`, {
    headers: {
      Authorization: `Bearer ${seed.token}`,
      organizationid: seed.realmId,
      'Content-Type': 'application/json'
    },
    data: body
  });
}

test.describe.serial('Tier A4: lease min-required at creation', () => {
  test('rejects payload missing timeRange', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await postLease(request, seed, {
      name: `E2E-A4-NoTime-${Math.floor(Math.random() * 100000)}`,
      numberOfTerms: 12
    });
    expect(r.status(), 'missing timeRange').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('timeRange');
  });

  test('rejects payload missing numberOfTerms', async ({ request }) => {
    const seed = await ensureSeed(request);
    const r = await postLease(request, seed, {
      name: `E2E-A4-NoTerms-${Math.floor(Math.random() * 100000)}`,
      timeRange: 'months'
    });
    expect(r.status(), 'missing numberOfTerms').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('numberOfTerms');
  });

  test('rejects duplicate name within realm', async ({ request }) => {
    const seed = await ensureSeed(request);
    const dupName = `E2E-A4-Dup-${Math.floor(Math.random() * 100000)}`;

    // First create succeeds
    const r1 = await postLease(request, seed, {
      name: dupName,
      numberOfTerms: 12,
      timeRange: 'months',
      active: true
    });
    expect(r1.status(), 'first create').toBe(200);
    const created = await r1.json();

    // Second with same name fails 422
    const r2 = await postLease(request, seed, {
      name: dupName,
      numberOfTerms: 6,
      timeRange: 'months',
      active: true
    });
    expect(r2.status(), 'duplicate name').toBe(422);
    const body = await r2.json();
    expect(JSON.stringify(body)).toContain('already exists');

    // Cleanup the first
    await request.delete(`${GATEWAY}/api/v2/leases`, {
      headers: {
        Authorization: `Bearer ${seed.token}`,
        organizationid: seed.realmId,
        'Content-Type': 'application/json'
      },
      data: { ids: [created._id] }
    });
  });

  test('accepts a valid lease payload', async ({ request }) => {
    const seed = await ensureSeed(request);
    const unique = `E2E-A4-Valid-${Math.floor(Math.random() * 100000)}`;
    const r = await postLease(request, seed, {
      name: unique,
      numberOfTerms: 24,
      timeRange: 'months',
      active: true
    });
    expect(r.status(), 'valid create').toBe(200);
    const body = await r.json();
    expect(body._id).toBeTruthy();
    expect(body.numberOfTerms).toBe(24);
    expect(body.timeRange).toBe('months');
    expect(body.active).toBe(true);

    // Cleanup
    await request.delete(`${GATEWAY}/api/v2/leases`, {
      headers: {
        Authorization: `Bearer ${seed.token}`,
        organizationid: seed.realmId,
        'Content-Type': 'application/json'
      },
      data: { ids: [body._id] }
    });
  });
});
