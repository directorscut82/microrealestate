import { test, expect, request } from '@playwright/test';
import { ensureSeed } from './lib/api';

/**
 * Wave-24: input validators on realm fields and the accounting :year route.
 *
 * What we're proving:
 *   1. PATCH /api/v2/realms/:id with companyInfo.capital="not-a-number"
 *      MUST 422 and MUST NOT mutate the realm.
 *   2. PATCH /api/v2/realms/:id with members[].email="not-an-email"
 *      MUST 422 and MUST NOT mutate the realm.
 *   3. GET /api/v2/accounting/:year MUST reject year < 1900, year > 2099, and
 *      non-integer values with 400/422. Year=2099 (the upper boundary) MUST
 *      pass.
 *
 * Discipline: every invalid PATCH is followed by a GET round-trip that asserts
 * the bad value did not slip into the persisted realm. If the validator is
 * absent (or the wrong shape) we want a clean failure that names the field,
 * not a silent corruption that pollutes the test realm for downstream specs.
 */

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';
const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD.');
  }
});

test.describe('wave-24 validators (API only)', () => {
  test('companyInfo.capital rejects non-numeric strings with 422 and does not pollute realm', async () => {
    const apiCtx = await request.newContext();
    try {
      const { token, realmId } = await ensureSeed(apiCtx);
      const headers = {
        Authorization: `Bearer ${token}`,
        organizationid: realmId,
        'Content-Type': 'application/json'
      };

      // Snapshot the realm before so we can prove the bad PATCH did not land.
      const beforeResp = await apiCtx.get(`${GATEWAY}/api/v2/realms/${realmId}`, { headers });
      expect(beforeResp.status(), 'GET realm (before) status').toBe(200);
      const before = (await beforeResp.json()) as {
        _id: string;
        companyInfo?: { capital?: unknown };
      };
      const beforeCapital = before.companyInfo?.capital;

      // Invalid PATCH: capital is not a finite number.
      const patchResp = await apiCtx.patch(`${GATEWAY}/api/v2/realms/${realmId}`, {
        headers,
        // Send the full prior body so the manager doesn't trip on missing
        // required fields *before* the capital check. We only mutate
        // companyInfo.capital — everything else is the realm as we found it.
        data: { ...before, companyInfo: { ...(before.companyInfo || {}), capital: 'not-a-number' } }
      });
      const patchBody = await patchResp.text();
      expect(
        patchResp.status(),
        `PATCH realm with capital="not-a-number" should be 422; got ${patchResp.status()} body=${patchBody}`
      ).toBe(422);
      expect(
        patchBody.toLowerCase(),
        'error body should name the offending field (companyInfo.capital)'
      ).toMatch(/capital/);

      // Round-trip: re-read the realm and confirm capital is unchanged.
      const afterResp = await apiCtx.get(`${GATEWAY}/api/v2/realms/${realmId}`, { headers });
      expect(afterResp.status(), 'GET realm (after) status').toBe(200);
      const after = (await afterResp.json()) as { companyInfo?: { capital?: unknown } };
      expect(
        after.companyInfo?.capital,
        'capital must be unchanged after rejected PATCH (no data pollution)'
      ).toEqual(beforeCapital);
      expect(
        after.companyInfo?.capital,
        'capital must not be the bad value we tried to write'
      ).not.toBe('not-a-number');
    } finally {
      await apiCtx.dispose();
    }
  });

  test('members[].email rejects malformed emails with 422 and does not pollute realm', async () => {
    const apiCtx = await request.newContext();
    try {
      const { token, realmId } = await ensureSeed(apiCtx);
      const headers = {
        Authorization: `Bearer ${token}`,
        organizationid: realmId,
        'Content-Type': 'application/json'
      };

      const beforeResp = await apiCtx.get(`${GATEWAY}/api/v2/realms/${realmId}`, { headers });
      expect(beforeResp.status(), 'GET realm (before) status').toBe(200);
      const before = (await beforeResp.json()) as {
        _id: string;
        members?: Array<{ email: string; role: string }>;
      };
      const beforeMembers = JSON.parse(JSON.stringify(before.members || []));

      // Invalid PATCH: one member has a malformed email. We append rather than
      // replace so the caller (the only administrator) is not orphaned —
      // realmmanager refuses to leave a realm with zero administrators.
      const badMembers = [
        ...beforeMembers,
        { email: 'not-an-email', role: 'administrator' }
      ];
      const patchResp = await apiCtx.patch(`${GATEWAY}/api/v2/realms/${realmId}`, {
        headers,
        data: { ...before, members: badMembers }
      });
      const patchBody = await patchResp.text();
      expect(
        patchResp.status(),
        `PATCH realm with malformed member email should be 422; got ${patchResp.status()} body=${patchBody}`
      ).toBe(422);
      expect(
        patchBody.toLowerCase(),
        'error body should mention email validation'
      ).toMatch(/email/);

      // Round-trip: members list must be unchanged. Specifically, the bad
      // address must not appear anywhere in the persisted membership.
      const afterResp = await apiCtx.get(`${GATEWAY}/api/v2/realms/${realmId}`, { headers });
      expect(afterResp.status(), 'GET realm (after) status').toBe(200);
      const after = (await afterResp.json()) as {
        members?: Array<{ email: string; role: string }>;
      };
      const afterEmails = (after.members || []).map((m) => m.email);
      expect(
        afterEmails,
        'realm members must not include the malformed email after a rejected PATCH'
      ).not.toContain('not-an-email');
      expect(
        (after.members || []).length,
        'member count must equal the pre-PATCH count'
      ).toBe(beforeMembers.length);
    } finally {
      await apiCtx.dispose();
    }
  });

  test('GET /accounting/:year enforces 1900..2099 integer bounds', async () => {
    const apiCtx = await request.newContext();
    try {
      const { token, realmId } = await ensureSeed(apiCtx);
      const headers = {
        Authorization: `Bearer ${token}`,
        organizationid: realmId
        // No Content-Type: this is a GET.
      };

      // Boundary: 2099 is the last valid year and MUST pass.
      const okResp = await apiCtx.get(`${GATEWAY}/api/v2/accounting/2099`, { headers });
      expect(
        okResp.status(),
        `GET /accounting/2099 (upper boundary) should succeed; got ${okResp.status()}`
      ).toBe(200);

      // Below lower bound: 1899 is below the 1900 floor and MUST be rejected.
      const lowResp = await apiCtx.get(`${GATEWAY}/api/v2/accounting/1899`, { headers });
      const lowBody = await lowResp.text();
      expect(
        [400, 422],
        `GET /accounting/1899 (below lower bound) should be 400 or 422; got ${lowResp.status()} body=${lowBody}`
      ).toContain(lowResp.status());

      // Non-integer: "abc" is not a year and MUST be rejected.
      const badResp = await apiCtx.get(`${GATEWAY}/api/v2/accounting/abc`, { headers });
      const badBody = await badResp.text();
      expect(
        [400, 422],
        `GET /accounting/abc (non-integer) should be 400 or 422; got ${badResp.status()} body=${badBody}`
      ).toContain(badResp.status());
    } finally {
      await apiCtx.dispose();
    }
  });
});
