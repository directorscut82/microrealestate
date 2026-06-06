/**
 * VERIFY B1 — SavedPaymentEditForm 422 follow-up.
 *
 * The client-side bug (pre-fc1d54b2): SavedPaymentEditForm passed the ORIGINAL
 * `allocation` array through unchanged when the user reduced a multi-entry
 * payment's amount, so reducing 200€ [{rent:120},{expenses:80}] to 100€
 * left allocation summing to 200 — the server's `allocation total exceeds
 * payment amount` validator (rentmanager.ts:901) returned 422 and locked
 * the user out of editing any split payment downward.
 *
 * The fix scales each allocation entry by newAmount/oldAmount, rounding to
 * 2dp, then absorbs the rounding remainder into the largest entry so
 * sum(allocation) === newAmount exactly.
 *
 * Verification: drive the actual server contract that was broken. We
 * simulate the FIXED client behaviour (PATCH 100€ with [{rent:60},
 * {expenses:40}]) and assert 200. Then we explicitly reproduce the OLD
 * broken behaviour (PATCH 100€ with [{rent:120},{expenses:80}]) and
 * assert 422 — proving the server validator is the gate the client fix
 * is satisfying. Finally we read the persisted record back via GET
 * /rents/tenant/:id and assert the allocation entries on disk sum to
 * exactly the new payment amount.
 *
 * Cleanup: terminal PATCH wipes payments[] back to empty.
 */
import { expect, request, test } from '@playwright/test';
import { ensureSeedLeasedTenant } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD');
  }
});

test.describe('verify B1 · SavedPaymentEditForm 422 fix · split-amount scale', () => {
  test('PATCH with proportionally-scaled allocation succeeds; old broken payload rejected with 422', async () => {
    test.setTimeout(120_000);

    const api = await request.newContext();
    try {
      const seed = await ensureSeedLeasedTenant(api);

      const signin = await api.post(
        `${GATEWAY}/api/v2/authenticator/landlord/signin`,
        {
          data: { email: TEST_EMAIL, password: TEST_PASSWORD },
          headers: { 'Content-Type': 'application/json' }
        }
      );
      expect(signin.status(), 'signin').toBe(200);
      const { accessToken: token } = await signin.json();

      const auth = {
        Authorization: `Bearer ${token}`,
        organizationid: seed.realmId,
        'Content-Type': 'application/json'
      };

      // Use current-month term, LOCAL date semantics (matches seed lib).
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const term = `${year}${month}0100`;
      const todayDDMMYYYY = `${day}/${month}/${year}`;

      // STEP 1: seed a 200€ payment with allocation [{rent:120},{expenses:80}]
      // (the "before-edit" state in the bug scenario).
      const seedPatch = await api.patch(
        `${GATEWAY}/api/v2/rents/payment/${seed.tenantId}/${term}`,
        {
          headers: auth,
          data: {
            _id: seed.tenantId,
            year,
            month: now.getMonth() + 1,
            payments: [
              {
                amount: 200,
                date: todayDDMMYYYY,
                type: 'cash',
                reference: 'verifyB1-seed',
                description: '',
                allocation: [
                  { category: 'rent', amount: 120 },
                  { category: 'expenses', amount: 80 }
                ]
              }
            ],
            promo: 0,
            extracharge: 0
          }
        }
      );
      expect(seedPatch.status(), 'seed 200€ split payment').toBe(200);

      // STEP 2: read back to confirm allocation persisted as we sent it.
      const afterSeed = await api.get(
        `${GATEWAY}/api/v2/rents/tenant/${seed.tenantId}`,
        { headers: { Authorization: `Bearer ${token}`, organizationid: seed.realmId } }
      );
      expect(afterSeed.status(), 'rents fetch after seed').toBe(200);
      const afterSeedBody = (await afterSeed.json()) as {
        rents: Array<{ term: number; payments?: Array<{ amount?: number; allocation?: Array<{ category: string; amount: number }> }> }>;
      };
      const seedRent = afterSeedBody.rents.find((r) => Number(r.term) === Number(term));
      expect(seedRent, `rent for term ${term}`).toBeTruthy();
      const seedPay = seedRent!.payments?.[0];
      expect(seedPay?.amount, 'seeded payment amount').toBe(200);
      expect(Array.isArray(seedPay?.allocation), 'seeded allocation array').toBe(true);
      const seedAllocSum = (seedPay!.allocation || []).reduce(
        (s, e) => s + (Number(e.amount) || 0),
        0
      );
      expect(seedAllocSum, 'seeded allocation sum').toBe(200);

      // STEP 3 (the load-bearing test): PATCH the payment down to 100€ with
      // PROPORTIONALLY SCALED allocation [{rent:60},{expenses:40}] — exactly
      // what the fixed SavedPaymentEditForm.js now generates. MUST succeed.
      const fixedEdit = await api.patch(
        `${GATEWAY}/api/v2/rents/payment/${seed.tenantId}/${term}`,
        {
          headers: auth,
          data: {
            _id: seed.tenantId,
            year,
            month: now.getMonth() + 1,
            payments: [
              {
                amount: 100,
                date: todayDDMMYYYY,
                type: 'cash',
                reference: 'verifyB1-fixed',
                description: '',
                allocation: [
                  { category: 'rent', amount: 60 },
                  { category: 'expenses', amount: 40 }
                ]
              }
            ],
            promo: 0,
            extracharge: 0
          }
        }
      );
      expect(
        fixedEdit.status(),
        `fixed-client edit (scaled allocation) (body: ${await fixedEdit.text().catch(() => '')})`
      ).toBe(200);

      // STEP 4: read back, assert persisted allocation sums to exactly the
      // new payment amount.
      const afterFix = await api.get(
        `${GATEWAY}/api/v2/rents/tenant/${seed.tenantId}`,
        { headers: { Authorization: `Bearer ${token}`, organizationid: seed.realmId } }
      );
      expect(afterFix.status(), 'rents fetch after fixed edit').toBe(200);
      const afterFixBody = (await afterFix.json()) as {
        rents: Array<{ term: number; payments?: Array<{ amount?: number; allocation?: Array<{ category: string; amount: number }> }> }>;
      };
      const fixRent = afterFixBody.rents.find((r) => Number(r.term) === Number(term));
      expect(fixRent, `rent for term ${term} after fix`).toBeTruthy();
      const fixPay = fixRent!.payments?.[0];
      expect(fixPay?.amount, 'edited payment amount').toBe(100);
      const fixAlloc = fixPay?.allocation || [];
      const fixAllocSum =
        Math.round(
          fixAlloc.reduce((s, e) => s + (Number(e.amount) || 0), 0) * 100
        ) / 100;
      expect(
        fixAllocSum,
        `persisted allocation sum must equal new payment amount (got ${fixAllocSum}, payments=${JSON.stringify(fixAlloc)})`
      ).toBe(100);
      // Spot-check proportional scaling preserved category amounts.
      const rentEntry = fixAlloc.find((e) => e.category === 'rent');
      const expEntry = fixAlloc.find((e) => e.category === 'expenses');
      expect(rentEntry?.amount, 'rent allocation scaled').toBe(60);
      expect(expEntry?.amount, 'expenses allocation scaled').toBe(40);

      // STEP 5: prove the OLD pre-fix broken payload still 422s — the
      // server validator is the gate, the client fix prevents tripping it.
      const brokenEdit = await api.patch(
        `${GATEWAY}/api/v2/rents/payment/${seed.tenantId}/${term}`,
        {
          headers: auth,
          data: {
            _id: seed.tenantId,
            year,
            month: now.getMonth() + 1,
            payments: [
              {
                amount: 100,
                date: todayDDMMYYYY,
                type: 'cash',
                reference: 'verifyB1-broken',
                description: '',
                allocation: [
                  { category: 'rent', amount: 120 },
                  { category: 'expenses', amount: 80 }
                ]
              }
            ],
            promo: 0,
            extracharge: 0
          }
        }
      );
      expect(
        brokenEdit.status(),
        'broken (unscaled) payload must still 422'
      ).toBe(422);
      const brokenBody = await brokenEdit.text();
      expect(
        brokenBody,
        `422 message must reference allocation total (got: ${brokenBody})`
      ).toMatch(/allocation total/i);
      console.log(`[verifyB1] confirmed 422 on unscaled payload: ${brokenBody}`);

      // STEP 6: cleanup — wipe payments[] for this term.
      const cleanup = await api.patch(
        `${GATEWAY}/api/v2/rents/payment/${seed.tenantId}/${term}`,
        {
          headers: auth,
          data: {
            _id: seed.tenantId,
            year,
            month: now.getMonth() + 1,
            payments: [],
            promo: 0,
            extracharge: 0
          }
        }
      );
      expect(cleanup.status(), 'cleanup wipe payments').toBe(200);
      const afterClean = await api.get(
        `${GATEWAY}/api/v2/rents/tenant/${seed.tenantId}`,
        { headers: { Authorization: `Bearer ${token}`, organizationid: seed.realmId } }
      );
      expect(afterClean.status(), 'rents fetch after cleanup').toBe(200);
      const afterCleanBody = (await afterClean.json()) as {
        rents: Array<{ term: number; payments?: Array<unknown> }>;
      };
      const cleanRent = afterCleanBody.rents.find((r) => Number(r.term) === Number(term));
      expect(cleanRent?.payments?.length || 0, 'cleanup payments cleared').toBe(0);
    } finally {
      await api.dispose();
    }
  });
});
