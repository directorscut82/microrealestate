import { test, expect, request } from '@playwright/test';
import { ensureSeedLease } from './lib/api';

/**
 * Reproduces wave-24 A7. Pre-fix, leasemanager.update() read req.body._id, so
 * a caller could PATCH lease A's URL with a body claiming _id=B and the
 * server would silently mutate lease B — an authorization-bypass / wrong-
 * target edit. The shipped fix is stricter than "URL wins": it rejects any
 * body._id that doesn't match the URL :id with HTTP 422, by design, so the
 * misdirection is impossible to express.
 *
 * What this spec asserts:
 *   1. PATCH /leases/:realId with body._id=decoyId returns 422.
 *   2. The real lease was NOT mutated (its name is unchanged).
 *   3. The decoy lease was NOT mutated (its name is unchanged).
 * Together those prove the security property: a body._id mismatch cannot
 * redirect the write to a different document, period.
 */

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error(
      'Missing TEST_EMAIL/TEST_PASSWORD. Expected .secrets/cypress-test-account.'
    );
  }
});

test('PATCH /leases/:realId with mismatched body._id is rejected 422 and mutates neither lease', async () => {
  const apiCtx = await request.newContext();

  // ----- arrange: seed real lease (idempotent: 'E2E-Lease') -----
  const { token, realmId, leaseId: realLeaseId } = await ensureSeedLease(apiCtx);

  const auth = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    organizationid: realmId
  };

  // ----- arrange: create decoy lease via direct API POST -----
  const decoyName = 'E2E-Lease-Decoy';
  // If a previous run left a decoy behind, reuse it; otherwise create.
  const listResp = await apiCtx.get(`${GATEWAY}/api/v2/leases`, { headers: auth });
  expect(listResp.status(), 'list leases for decoy lookup').toBe(200);
  const existingLeases = (await listResp.json()) as Array<{ _id: string; name: string }>;
  let decoy = existingLeases.find((l) => l.name === decoyName);
  if (!decoy) {
    const createDecoy = await apiCtx.post(`${GATEWAY}/api/v2/leases`, {
      headers: auth,
      data: {
        name: decoyName,
        description: 'E2E decoy lease — used to verify URL :id wins over body._id',
        timeRange: 'years',
        numberOfTerms: 1
      }
    });
    expect(
      [200, 201],
      `create decoy lease (status=${createDecoy.status()}, body=${await createDecoy.text().catch(() => '')})`
    ).toContain(createDecoy.status());
    decoy = (await createDecoy.json()) as { _id: string; name: string };
  }
  const decoyLeaseId = decoy._id;
  expect(decoyLeaseId, 'decoy lease _id distinct from real lease').not.toBe(realLeaseId);

  // ----- act: PATCH real lease URL with body._id pointing at the decoy -----
  const renamedTo = `E2E-Lease-Renamed-${Date.now()}`;
  const patchResp = await apiCtx.patch(`${GATEWAY}/api/v2/leases/${realLeaseId}`, {
    headers: auth,
    data: {
      _id: decoyLeaseId,
      name: renamedTo,
      // Echo back the seed shape so server-side validators are satisfied.
      timeRange: 'years',
      numberOfTerms: 1
    }
  });

  // ----- assert: server rejects the mismatch outright -----
  expect(
    patchResp.status(),
    `PATCH /leases/${realLeaseId} with body._id=${decoyLeaseId} must return 422. ` +
      `If 200 returns, the wave-24 A7 mismatch-rejection guard regressed.`
  ).toBe(422);

  // ----- assert: real lease unchanged (name still 'E2E-Lease' from seed) -----
  const realResp = await apiCtx.get(`${GATEWAY}/api/v2/leases/${realLeaseId}`, {
    headers: auth
  });
  expect(realResp.status(), 'GET real lease after rejected PATCH').toBe(200);
  const realLease = (await realResp.json()) as { _id: string; name: string };
  expect(
    realLease.name,
    'real lease must NOT have been renamed (PATCH was rejected — no side effect)'
  ).toBe('E2E-Lease');
  expect(String(realLease._id), 'GET returns the lease at the URL :id').toBe(realLeaseId);

  // ----- assert: decoy lease unchanged (name still 'E2E-Lease-Decoy') -----
  const decoyResp = await apiCtx.get(`${GATEWAY}/api/v2/leases/${decoyLeaseId}`, {
    headers: auth
  });
  expect(decoyResp.status(), 'GET decoy lease after rejected PATCH').toBe(200);
  const decoyLease = (await decoyResp.json()) as { _id: string; name: string };
  expect(
    decoyLease.name,
    `Decoy lease must NOT have been mutated by body._id redirection. ` +
      `If decoy.name === '${renamedTo}' the pre-fix authz-bypass behaviour is back.`
  ).toBe(decoyName);
  expect(String(decoyLease._id), 'GET returns the decoy lease').toBe(decoyLeaseId);

  // No cleanup needed — the rejected PATCH had no side effect, so both
  // leases are already in their seed state for the next run.
  await apiCtx.dispose();
});
