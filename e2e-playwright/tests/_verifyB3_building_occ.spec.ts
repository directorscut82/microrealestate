/**
 * VERIFY B3 — Building optimistic concurrency control.
 *
 * Pre-fix bug: BuildingSchema had no `optimisticConcurrency: true`. Two
 * concurrent building.save() ops (e.g. simultaneous addContractor /
 * addExpense / addRepair) silently won-by-arrival — one writer's
 * mutation could overwrite the other's even though both were operating
 * on the same Mongoose-loaded document with the same __v.
 *
 * Fix: BuildingSchema now sets `optimisticConcurrency: true`, so save()
 * bumps __v and throws VersionError when the in-memory __v differs from
 * disk. The new _saveBuildingWithVersionCheck wrapper translates that
 * VersionError into HTTP 409 with the message
 *   "Building was modified concurrently. Please retry."
 *
 * Verification: fire two concurrent POST /buildings/:id/contractors
 * against the same building. Exactly ONE should succeed (2xx), the
 * OTHER should fail with 409 + the explicit error message.
 *
 * The retry-budget added in fd6040bb only wraps the
 * _saveRecomputedRentsWithRetry path used by the rent-recompute
 * pipeline; user-facing direct routes (addContractor, addExpense,
 * addRepair, etc.) do NOT auto-retry. They surface 409 to the caller
 * by design — that's what we assert here.
 *
 * Cleanup: remove any contractor we created so the realm is restored to
 * baseline.
 */
import { APIRequestContext, expect, request, test } from '@playwright/test';
import { ensureSeedLeasedTenant } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD');
  }
});

interface Outcome {
  label: string;
  status: number;
  body: string;
  ms: number;
}

async function postContractor(
  api: APIRequestContext,
  token: string,
  realmId: string,
  buildingId: string,
  label: string,
  name: string
): Promise<Outcome> {
  const t0 = Date.now();
  const r = await api.post(
    `${GATEWAY}/api/v2/buildings/${buildingId}/contractors`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        organizationid: realmId,
        'Content-Type': 'application/json'
      },
      data: {
        name,
        contact: name,
        phone1: '6900000000',
        email: '',
        specialty: 'plumbing'
      },
      timeout: 60_000
    }
  );
  return {
    label,
    status: r.status(),
    body: await r.text().catch(() => ''),
    ms: Date.now() - t0
  };
}

test.describe('verify B3 · Building optimistic concurrency', () => {
  test('two concurrent building writes: one 2xx, one 409 VersionError', async () => {
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

      // Pre-cleanup: drop any prior E2E-OCC-* contractors so the assert
      // counts are deterministic.
      const preBld = await api.get(`${GATEWAY}/api/v2/buildings/${seed.buildingId}`, { headers: auth });
      expect(preBld.status(), 'fetch building pre').toBe(200);
      const preFull = (await preBld.json()) as {
        contractors?: Array<{ _id: string; name: string }>;
      };
      for (const c of (preFull.contractors || []).filter((c) => c.name?.startsWith('E2E-OCC-'))) {
        await api.delete(
          `${GATEWAY}/api/v2/buildings/${seed.buildingId}/contractors/${c._id}`,
          { headers: { Authorization: `Bearer ${token}`, organizationid: seed.realmId } }
        );
      }

      // We need the two concurrent requests to actually overlap on the
      // server: both must do findOne before either does save(). With a
      // single Promise.all firing them, in practice the contention is
      // very tight — but with retry budgets and Mongo persistence
      // latency it's not 100% guaranteed both will land on the same __v.
      // We fire several rounds back-to-back; a single round in which
      // both ops succeed (status 2xx) means the race did not trigger
      // version conflict. We require AT LEAST ONE round in which the
      // version-conflict path fires (one 2xx + one 409). This proves
      // the optimisticConcurrency:true wiring is in place — pre-fix,
      // 409 was IMPOSSIBLE because the schema flag was missing.
      const ts = Date.now();
      const ROUNDS = 5;
      const allOutcomes: Outcome[][] = [];
      let observed409 = 0;
      let observed2xx = 0;
      let observed5xx = 0;
      for (let i = 0; i < ROUNDS; i++) {
        const a = `E2E-OCC-A-${ts}-r${i}`;
        const b = `E2E-OCC-B-${ts}-r${i}`;
        const round = await Promise.all([
          postContractor(api, token, seed.realmId, seed.buildingId, `A-r${i}`, a),
          postContractor(api, token, seed.realmId, seed.buildingId, `B-r${i}`, b)
        ]);
        allOutcomes.push(round);
        for (const o of round) {
          console.log(
            `[verifyB3] round=${i} label=${o.label} status=${o.status} ms=${o.ms}`
          );
          if (o.status === 409) observed409 += 1;
          else if (o.status >= 200 && o.status < 300) observed2xx += 1;
          else if (o.status >= 500) observed5xx += 1;
        }
      }
      console.log(
        `[verifyB3] totals: 2xx=${observed2xx}, 409=${observed409}, 5xx=${observed5xx}`
      );

      // 1. No 5xx: a race must NEVER surface as a server error.
      expect(observed5xx, 'no 5xx anywhere (race must surface as 409, not 500)').toBe(0);

      // 2. The headline assertion: at least one 409 was observed across
      //    the rounds. Pre-fix this number is mathematically 0 because
      //    optimisticConcurrency:true was absent from BuildingSchema.
      expect(
        observed409,
        `expected at least one 409 across ${ROUNDS} concurrent rounds; got ${observed409}. ` +
          `Pre-fix this is impossible (no optimisticConcurrency on BuildingSchema). ` +
          `Outcomes: ${JSON.stringify(allOutcomes)}`
      ).toBeGreaterThanOrEqual(1);

      // 3. Every 409 must carry the explicit message text.
      for (const round of allOutcomes) {
        for (const o of round) {
          if (o.status === 409) {
            expect(
              o.body,
              `409 must carry "modified concurrently" message (got: ${o.body})`
            ).toMatch(/modified concurrently/i);
          }
        }
      }

      // 4. Read back the building. Every 2xx response should have left
      //    its contractor on disk. Every 409 should have NOT.
      const finalBld = await api.get(`${GATEWAY}/api/v2/buildings/${seed.buildingId}`, { headers: auth });
      expect(finalBld.status(), 'fetch building post').toBe(200);
      const finalFull = (await finalBld.json()) as {
        contractors?: Array<{ _id: string; name: string }>;
      };
      const ourContractors = (finalFull.contractors || []).filter((c) =>
        c.name?.startsWith(`E2E-OCC-A-${ts}`) || c.name?.startsWith(`E2E-OCC-B-${ts}`)
      );
      expect(
        ourContractors.length,
        `read-back contractor count must equal 2xx count (got ${ourContractors.length}, expected ${observed2xx})`
      ).toBe(observed2xx);

      // 5. Cleanup: delete every contractor we created.
      for (const c of ourContractors) {
        const d = await api.delete(
          `${GATEWAY}/api/v2/buildings/${seed.buildingId}/contractors/${c._id}`,
          { headers: { Authorization: `Bearer ${token}`, organizationid: seed.realmId } }
        );
        expect(
          [200, 204],
          `cleanup contractor ${c.name} (${d.status()})`
        ).toContain(d.status());
      }

      // Confirm cleanup landed.
      const cleanBld = await api.get(`${GATEWAY}/api/v2/buildings/${seed.buildingId}`, { headers: auth });
      expect(cleanBld.status(), 'fetch building post-cleanup').toBe(200);
      const cleanFull = (await cleanBld.json()) as {
        contractors?: Array<{ _id: string; name: string }>;
      };
      const stillThere = (cleanFull.contractors || []).filter((c) =>
        c.name?.startsWith(`E2E-OCC-`)
      );
      expect(stillThere.length, `cleanup left no E2E-OCC contractors`).toBe(0);
    } finally {
      await api.dispose();
    }
  });
});
