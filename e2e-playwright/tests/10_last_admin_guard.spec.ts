import { test, expect, request } from '@playwright/test';
import { ensureSeed } from './lib/api';

/**
 * Wave-24 last-admin guard (services/api/src/managers/realmmanager.ts,
 * commit cf7a6e0). PATCH /api/v2/realms/:id must refuse a payload whose
 * post-merge member list has zero administrators. Pre-fix, the guard was
 * collapsed into a generic "missing fields" check that fired only when
 * `members` itself was absent — sending `[{role:'renter'}]` slipped through
 * and orphaned the realm. The fix:
 *
 *   if (!hasAdmin) throw new ServiceError(
 *     'at least one administrator member is required', 422
 *   );
 *
 * Discipline: assert exact 422 status, assert the error string matches the
 * fix's wording, then GET the realm back and verify the test account is
 * STILL an administrator. The third check is what protects against a false
 * green where the request "succeeded" by deleting the only admin — which
 * would leave the realm unmanageable.
 */

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';
const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD.');
  }
});

test('PATCH /realms/:id refuses to remove the last administrator (422)', async () => {
  const apiCtx = await request.newContext();
  try {
    const { token, realmId } = await ensureSeed(apiCtx);

    const auth = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      organizationid: realmId
    };

    // 1. Read the realm so we have the full body shape (incl. _id, name,
    //    locale, currency) the PATCH handler expects. Sending a partial
    //    body would trip the unrelated _hasRequiredFields(name|locale|...)
    //    branches first and we'd never exercise the admin-guard path.
    const getResp = await apiCtx.get(`${GATEWAY}/api/v2/realms/${realmId}`, {
      headers: auth
    });
    expect(getResp.status(), 'GET realm before mutation').toBe(200);
    const realm = (await getResp.json()) as {
      _id: string;
      name: string;
      locale: string;
      currency: string;
      members: Array<{ email: string; role: string; name?: string; registered?: boolean }>;
    };

    // Sanity: the test realm must currently have the test account as its
    // only administrator. If a prior failed run already orphaned it (or
    // some other admin exists), the assertion below would be meaningless.
    const adminsBefore = realm.members.filter((m) => m.role === 'administrator');
    expect(
      adminsBefore.length,
      `precondition: exactly one admin (got ${adminsBefore.length}: ${adminsBefore
        .map((m) => m.email)
        .join(', ')})`
    ).toBe(1);
    expect(
      adminsBefore[0].email.toLowerCase(),
      'precondition: sole admin is the test account'
    ).toBe(TEST_EMAIL.toLowerCase());

    // 2. Build a payload that demotes the lone admin to 'renter'. This is
    //    the exact shape the UI sends (full realm body + mutated members).
    //    Pre-fix, this would 200 and leave realmId without any admin.
    const demotedMembers = realm.members.map((m) =>
      m.email.toLowerCase() === TEST_EMAIL.toLowerCase()
        ? { ...m, role: 'renter' }
        : m
    );

    const patchResp = await apiCtx.patch(`${GATEWAY}/api/v2/realms/${realmId}`, {
      headers: auth,
      data: { ...realm, members: demotedMembers }
    });

    // 3. Assert: 422 (NOT 200, NOT 500). 200 = guard never fired and
    //    realm is now orphaned. 500 = guard threw something other than
    //    ServiceError and we have a worse bug than the one being tested.
    const patchBody = await patchResp.text();
    expect(
      patchResp.status(),
      `PATCH must be rejected with 422. Got ${patchResp.status()}. Body: ${patchBody}`
    ).toBe(422);

    // 4. Assert: the error string is the wave-24 wording. We accept the
    //    response as either { error } or { errors: [...] } or a plain
    //    string — different middlewares wrap ServiceError differently.
    const errorText = patchBody.toLowerCase();
    expect(
      errorText.includes('administrator') ||
        errorText.includes('admin') ||
        errorText.includes('last'),
      `error message must reference the admin/last-admin constraint. Got: ${patchBody}`
    ).toBe(true);

    // 5. Side-effect verification — the rejected PATCH must NOT have
    //    partially applied. GET the realm back and confirm the test
    //    account is still an administrator. THIS IS THE CRITICAL CHECK:
    //    if it fails the realm is orphaned and a human has to repair
    //    it directly in mongo.
    const verifyResp = await apiCtx.get(`${GATEWAY}/api/v2/realms/${realmId}`, {
      headers: auth
    });
    expect(verifyResp.status(), 'GET realm after rejected PATCH').toBe(200);
    const verifyRealm = (await verifyResp.json()) as {
      members: Array<{ email: string; role: string }>;
    };

    const testAccountAfter = verifyRealm.members.find(
      (m) => m.email.toLowerCase() === TEST_EMAIL.toLowerCase()
    );
    expect(
      testAccountAfter,
      `CRITICAL: test account ${TEST_EMAIL} missing from realm members after rejected PATCH — realm is orphaned`
    ).toBeDefined();
    expect(
      testAccountAfter!.role,
      `CRITICAL: test account role after rejected PATCH must still be 'administrator' (got '${testAccountAfter!.role}')`
    ).toBe('administrator');

    const adminsAfter = verifyRealm.members.filter((m) => m.role === 'administrator');
    expect(
      adminsAfter.length,
      `realm must still have at least one admin after rejected PATCH (got ${adminsAfter.length})`
    ).toBeGreaterThanOrEqual(1);
  } finally {
    await apiCtx.dispose();
  }
});
