import { test, expect, request } from '@playwright/test';
import { ensureSeedLeasedTenant, ensureSeedWithUnit } from './lib/api';

/**
 * Wave-24 bug 4 (real-user bug): adding a building repair with chargeTerm in
 * a past month, where at least one tenant has already paid rent for that
 * month, must be refused with HTTP 422 and a clear "Past-paid rents are
 * frozen" message. Pre-fix the API silently no-op'd: the monthlyCharge got
 * written but the tenant ledger was never repriced (frozen by wave-13), so
 * the landlord's repair charge was invisible to the tenant.
 *
 * Trigger conditions in services/api/src/managers/buildingmanager.ts:2099:
 *   - chargeTerm is in the past
 *   - chargeableTo != 'owners'
 *   - actualCost > 0 OR estimatedCost > 0
 *   - at least one tenant in the realm has rents.term=<chargeTerm> with
 *     rents.payments.amount > 0
 *
 * Setup chain:
 *   1. ensureSeedLeasedTenant gives us a tenant with computed rents
 *      spanning [today-6mo .. today+6mo].
 *   2. PATCH /rents/payment/:tenantId/:term with a payment > 0 for a past
 *      term to satisfy the "rents.payments.amount > 0" predicate.
 *   3. POST /buildings/:id/repairs with chargeTerm = same past term,
 *      chargeableTo='tenants', actualCost=100. Expect 422.
 */

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD.');
  }
});

test('POST /buildings/:id/repairs with chargeTerm in past + paid rent → 422', async () => {
  const apiCtx = await request.newContext();
  const leased = await ensureSeedLeasedTenant(apiCtx);

  // Need a building with units, but link is not required for this guard.
  await ensureSeedWithUnit(apiCtx);

  const auth = {
    Authorization: `Bearer ${leased.token}`,
    'Content-Type': 'application/json',
    organizationid: leased.realmId
  };

  // Past term: three months ago, first day, hour 00. Format YYYYMMDDHH.
  const today = new Date();
  const past = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 3, 1));
  const pastTerm =
    past.getUTCFullYear().toString() +
    String(past.getUTCMonth() + 1).padStart(2, '0') +
    '0100';

  // Step 1: record a payment > 0 on the past term so the wave-24 guard's
  // predicate is satisfied. The endpoint REPLACES payments[], so we send
  // exactly the one payment we want recorded. Date format DD/MM/YYYY per
  // _stringToDate strict parser.
  const ddmm = (d: Date) =>
    `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;

  const payResp = await apiCtx.patch(
    `${GATEWAY}/api/v2/rents/payment/${leased.tenantId}/${pastTerm}`,
    {
      headers: auth,
      data: {
        _id: leased.tenantId,
        promo: 0,
        extracharge: 0,
        notepromo: '',
        noteextracharge: '',
        description: 'E2E paid rent for past-term repair guard test',
        payments: [
          {
            date: ddmm(past),
            type: 'cash',
            reference: 'E2E',
            amount: 500
          }
        ]
      }
    }
  );
  expect(
    payResp.status(),
    `record payment for past term ${pastTerm} (status=${payResp.status()}, body=${await payResp.text().catch(() => '')})`
  ).toBe(200);

  // Step 2: POST repair with chargeTerm in past. Guard MUST fire with 422.
  const repairResp = await apiCtx.post(
    `${GATEWAY}/api/v2/buildings/${leased.buildingId}/repairs`,
    {
      headers: auth,
      data: {
        title: 'E2E-Repair-Past',
        category: 'plumbing',
        chargeTerm: Number(pastTerm),
        chargeableTo: 'tenants',
        actualCost: 100,
        estimatedCost: 0,
        status: 'completed'
      }
    }
  );
  expect(
    repairResp.status(),
    `repair POST with past chargeTerm + paid rent must be 422 (got ${repairResp.status()}). Body: ${await repairResp.text().catch(() => '')}`
  ).toBe(422);

  const body = await repairResp.text();
  expect(
    body.toLowerCase(),
    'response body must mention the past-paid frozen reason'
  ).toMatch(/past|frozen|paid/);

  // Step 3: verify side effect — the building has NO new repair entry.
  // (A regression where the guard fires AND the repair is still written
  // would still leave dead data even though we got the 422.)
  const buildingResp = await apiCtx.get(
    `${GATEWAY}/api/v2/buildings/${leased.buildingId}`,
    { headers: auth }
  );
  expect(buildingResp.status(), 'GET building after rejected repair').toBe(200);
  const fullBuilding = (await buildingResp.json()) as {
    repairs?: Array<{ title: string }>;
  };
  const e2eRepairsAtPast = (fullBuilding.repairs ?? []).filter(
    (r) => r.title === 'E2E-Repair-Past'
  );
  expect(
    e2eRepairsAtPast,
    'no E2E-Repair-Past entry must exist on the building (rejected POST had no side effect)'
  ).toHaveLength(0);

  await apiCtx.dispose();
});
