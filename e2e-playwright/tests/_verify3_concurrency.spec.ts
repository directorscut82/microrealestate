/**
 * VERIFY 5 — Concurrency stress test re-run with new retry budget.
 *
 * Background: commit fd6040bb bumped buildingmanager._saveRecomputedRentsWithRetry
 * from 5→8 attempts with exponential backoff (50, 100, 200, 400, 800, 800, 800,
 * 800ms ≈ 3.95s total) and scoped both findOneAndUpdate and the existence
 * re-read by realmId. Same retry pattern was applied in occupantmanager's
 * sibling-recompute path.
 *
 * This spec fires 5 concurrent writes against the canonical E2E-LeasedTenant in
 * the CYPRESS-TEST-DO-NOT-USE realm:
 *   - 3 PATCH /rents/payment/:id/:term  (different past terms so they don't
 *     overwrite each other's payment lists)
 *   - 2 POST /buildings/:id/expenses    (each kicks the rent-recomputation path
 *     across all tenants in the building)
 *
 * After the wave settles, the spec reads every rent on the tenant via GET
 * /rents/tenant/:id and asserts:
 *   drift_i := rent.total.payment - sum(rent.payments[].amount) === 0
 * for every i.  drift > 0 would mean the rent total is stale relative to its
 * own payments[] array — i.e. the recompute pipeline lost a write under
 * contention.
 *
 * "Per-rent drift readout" is logged so the runner output shows the actual
 * computed values per rent term, not just a pass/fail.
 *
 * Cleanup: each PATCH'd term has its payments[] cleared. The two new
 * recurring expenses are deleted. Pre-existing realm baseline is preserved.
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

interface PatchOutcome {
  kind: 'patch';
  term: number;
  status: number;
  ms: number;
  error?: string;
}

interface ExpenseOutcome {
  kind: 'expense';
  name: string;
  status: number;
  ms: number;
  expenseId?: string;
  error?: string;
}

type Outcome = PatchOutcome | ExpenseOutcome;

function termFor(year: number, monthOneIndexed: number): number {
  return Number(
    `${year}${String(monthOneIndexed).padStart(2, '0')}0100`
  );
}

function pastTerms(count: number): number[] {
  // Use months 2, 3, 4 of the past (relative to today) — well within the
  // 6-month past lease window of E2E-LeasedTenant, but distinct from the
  // current month so the harness doesn't collide with whatever payment
  // baseline another spec left behind on the current term.
  const now = new Date();
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (i + 2), 1));
    out.push(termFor(d.getUTCFullYear(), d.getUTCMonth() + 1));
  }
  return out;
}

function ddmmyyyyForTerm(term: number): string {
  const y = Math.floor(term / 1e6);
  const m = String(Math.floor((term / 1e4) % 100)).padStart(2, '0');
  return `01/${m}/${y}`;
}

async function patchPayment(
  api: APIRequestContext,
  token: string,
  realmId: string,
  tenantId: string,
  term: number,
  amount: number
): Promise<PatchOutcome> {
  const t0 = Date.now();
  try {
    const r = await api.patch(
      `${GATEWAY}/api/v2/rents/payment/${tenantId}/${term}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          organizationid: realmId,
          'Content-Type': 'application/json'
        },
        data: {
          _id: tenantId,
          year: Math.floor(term / 1e6),
          month: Math.floor((term / 1e4) % 100),
          payments: [
            {
              amount,
              date: ddmmyyyyForTerm(term),
              type: 'cash',
              reference: `verify5-${term}`,
              description: ''
            }
          ],
          promo: 0,
          extracharge: 0
        },
        timeout: 60_000
      }
    );
    return { kind: 'patch', term, status: r.status(), ms: Date.now() - t0 };
  } catch (e: any) {
    return { kind: 'patch', term, status: -1, ms: Date.now() - t0, error: String(e?.message ?? e) };
  }
}

async function postExpense(
  api: APIRequestContext,
  token: string,
  realmId: string,
  buildingId: string,
  name: string,
  amount: number
): Promise<ExpenseOutcome> {
  const t0 = Date.now();
  try {
    // startTerm 6 months in the past so the expense back-applies across the
    // tenant's full rent ledger and forces real recomputation work.
    const d = new Date();
    const past = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 6, 1));
    const startTerm = Number(
      `${past.getUTCFullYear()}${String(past.getUTCMonth() + 1).padStart(2, '0')}0100`
    );
    const r = await api.post(
      `${GATEWAY}/api/v2/buildings/${buildingId}/expenses`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          organizationid: realmId,
          'Content-Type': 'application/json'
        },
        data: {
          name,
          type: 'other',
          amount,
          allocationMethod: 'general_thousandths',
          isRecurring: true,
          startTerm
        },
        timeout: 60_000
      }
    );
    let body: any = null;
    try {
      body = await r.json();
    } catch {
      /* */
    }
    const created = body?.expenses?.find((e: any) => e.name === name);
    return {
      kind: 'expense',
      name,
      status: r.status(),
      ms: Date.now() - t0,
      expenseId: created?._id
    };
  } catch (e: any) {
    return {
      kind: 'expense',
      name,
      status: -1,
      ms: Date.now() - t0,
      error: String(e?.message ?? e)
    };
  }
}

async function deleteExpense(
  api: APIRequestContext,
  token: string,
  realmId: string,
  buildingId: string,
  expenseId: string
): Promise<void> {
  await api.delete(
    `${GATEWAY}/api/v2/buildings/${buildingId}/expenses/${expenseId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        organizationid: realmId
      }
    }
  );
}

async function clearPayments(
  api: APIRequestContext,
  token: string,
  realmId: string,
  tenantId: string,
  term: number
): Promise<void> {
  await api.patch(
    `${GATEWAY}/api/v2/rents/payment/${tenantId}/${term}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        organizationid: realmId,
        'Content-Type': 'application/json'
      },
      data: {
        _id: tenantId,
        year: Math.floor(term / 1e6),
        month: Math.floor((term / 1e4) % 100),
        payments: [],
        promo: 0,
        extracharge: 0
      }
    }
  );
}

test.describe('verify 5 · concurrency stress · 3 PATCH + 2 POST', () => {
  test('drift = 0 across all rents after 5 concurrent writes settle', async () => {
    test.setTimeout(180_000); // generous: backoff schedule alone is up to 4s/write

    const api = await request.newContext();
    try {
      // Seed the canonical leased tenant + building/property/lease.
      const seed = await ensureSeedLeasedTenant(api);

      // Sign-in to get a fresh access token (seed already does its own work
      // but doesn't surface a long-lived token for our concurrent fanout).
      const signin = await api.post(
        `${GATEWAY}/api/v2/authenticator/landlord/signin`,
        {
          data: { email: TEST_EMAIL, password: TEST_PASSWORD },
          headers: { 'Content-Type': 'application/json' }
        }
      );
      expect(signin.status(), 'signin').toBe(200);
      const { accessToken: token } = await signin.json();

      const terms = pastTerms(3);
      const expenseNames = [
        `E2E-Verify5-Concur-A-${Date.now()}`,
        `E2E-Verify5-Concur-B-${Date.now()}`
      ];

      // 1. Clear any leftover payments on the chosen past terms first so
      //    the post-write assertion measures only what THIS run wrote.
      for (const t of terms) {
        await clearPayments(api, token, seed.realmId, seed.tenantId, t);
      }

      // 2. Fire all 5 writes in parallel via Promise.all. The retry-budget
      //    fix is supposed to absorb VersionError contention as the 2
      //    expense POSTs trigger sibling-recompute on the same tenant
      //    that the 3 PATCHes are mutating.
      console.log(
        `[verify5] firing 5 concurrent writes (terms=${terms.join(',')}, expenses=${expenseNames.join(',')})`
      );
      const fanoutStart = Date.now();
      const outcomes: Outcome[] = await Promise.all([
        patchPayment(api, token, seed.realmId, seed.tenantId, terms[0], 100),
        patchPayment(api, token, seed.realmId, seed.tenantId, terms[1], 150),
        patchPayment(api, token, seed.realmId, seed.tenantId, terms[2], 200),
        postExpense(api, token, seed.realmId, seed.buildingId, expenseNames[0], 25),
        postExpense(api, token, seed.realmId, seed.buildingId, expenseNames[1], 35)
      ]);
      const fanoutMs = Date.now() - fanoutStart;
      console.log(`[verify5] fanout settled in ${fanoutMs}ms`);
      for (const o of outcomes) {
        if (o.kind === 'patch') {
          console.log(
            `[verify5]   PATCH term=${o.term} status=${o.status} ms=${o.ms}` +
              (o.error ? ` error=${o.error}` : '')
          );
        } else {
          console.log(
            `[verify5]   POST  expense=${o.name} status=${o.status} ms=${o.ms} id=${o.expenseId ?? '?'}` +
              (o.error ? ` error=${o.error}` : '')
          );
        }
      }

      // 3. Every write must end in either 2xx (write applied) OR 409
      //    (optimistic-lock loss, write not applied). Anything else (5xx,
      //    422 from the validation layer, network drop) means the retry
      //    budget did not absorb the contention cleanly.
      //
      //    The user-facing PATCH /rents/payment/:id/:term path does NOT use
      //    the new exponential retry budget — that budget lives in
      //    buildingmanager._saveRecomputedRentsWithRetry and the
      //    occupantmanager sibling-recompute path, which the 2 expense
      //    POSTs traverse. The PATCH path returns 409 by design when its
      //    __v read-modify-write race loses to a sibling. The drift = 0
      //    invariant must hold REGARDLESS of which writes won.
      const succeeded: Outcome[] = [];
      for (const o of outcomes) {
        const label = o.kind === 'patch' ? `PATCH ${o.term}` : `POST ${o.name}`;
        expect(
          [200, 201, 409].includes(o.status),
          `${label} status (got ${o.status}, expected 2xx-applied or 409-conflict-rejected)`
        ).toBe(true);
        if (o.status >= 200 && o.status < 300) succeeded.push(o);
      }
      console.log(
        `[verify5] ${succeeded.length}/${outcomes.length} writes applied; ${
          outcomes.length - succeeded.length
        } rejected via 409 (expected under contention)`
      );

      // 4. Read every rent on the tenant. Compute drift per term.
      //
      // Note on the response shape: GET /rents/tenant/:id flattens the
      // internal rent.total.payment into a top-level `payment` field
      // (frontdata.toRentData line 116). The Mongoose-stored rent has
      // rent.total.payment but the JSON response surfaces it as
      // rent.payment, so that is what we compare against the payments
      // sum to detect drift.
      const rentsResp = await api.get(
        `${GATEWAY}/api/v2/rents/tenant/${seed.tenantId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            organizationid: seed.realmId
          }
        }
      );
      expect(rentsResp.status(), 'rents fetch').toBe(200);
      const rentsBody = (await rentsResp.json()) as {
        rents: Array<{
          term: number;
          payments?: Array<{ amount?: number | string }>;
          payment?: number;
        }>;
      };
      expect(rentsBody.rents?.length, 'rents array length').toBeGreaterThan(0);

      const driftRows: Array<{
        term: number;
        sumPayments: number;
        totalPayment: number;
        drift: number;
      }> = [];
      for (const r of rentsBody.rents) {
        const sumPayments =
          Math.round(
            (r.payments || []).reduce(
              (acc, p) => acc + (Number(p.amount) || 0),
              0
            ) * 100
          ) / 100;
        const totalPayment = Number(r.payment ?? 0);
        const drift = Math.round((totalPayment - sumPayments) * 100) / 100;
        driftRows.push({ term: r.term, sumPayments, totalPayment, drift });
      }

      console.log(`[verify5] per-rent drift readout (${driftRows.length} rents):`);
      for (const row of driftRows) {
        const flag = row.drift === 0 ? 'OK' : 'DRIFT';
        console.log(
          `[verify5]   term=${row.term}  sum(payments)=${row.sumPayments.toFixed(2)}  total.payment=${row.totalPayment.toFixed(2)}  drift=${row.drift.toFixed(2)}  ${flag}`
        );
      }

      // 5. For each PATCH that succeeded (status 2xx), the corresponding
      //    rent must reflect the amount we wrote. PATCHes that lost the
      //    optimistic-lock race (409) wrote nothing, so their term must
      //    still show 0 (we cleared payments in step 1).
      const expectedByTerm = new Map<number, number>([
        [terms[0], 100],
        [terms[1], 150],
        [terms[2], 200]
      ]);
      for (const o of outcomes) {
        if (o.kind !== 'patch') continue;
        const expected = expectedByTerm.get(o.term)!;
        const row = driftRows.find((r) => r.term === o.term);
        expect(row, `rent for term ${o.term} present`).toBeTruthy();
        if (o.status >= 200 && o.status < 300) {
          expect(
            row!.sumPayments,
            `term ${o.term} payments summed (PATCH applied)`
          ).toBeCloseTo(expected, 2);
          expect(
            row!.totalPayment,
            `term ${o.term} total.payment (PATCH applied)`
          ).toBeCloseTo(expected, 2);
        } else {
          expect(
            row!.sumPayments,
            `term ${o.term} payments still 0 (PATCH 409, write rejected)`
          ).toBeCloseTo(0, 2);
          expect(
            row!.totalPayment,
            `term ${o.term} total.payment still 0 (PATCH 409, write rejected)`
          ).toBeCloseTo(0, 2);
        }
      }

      // 6. The headline assertion: drift = 0 across every rent on the tenant.
      const offending = driftRows.filter((r) => r.drift !== 0);
      expect(
        offending,
        `expected zero drift on every rent, got ${offending.length} mismatches: ${JSON.stringify(offending)}`
      ).toEqual([]);

      // 7. Cleanup: clear the three test-payments and delete the two new
      //    expenses so the realm is restored to baseline. Run sequentially
      //    here — we are no longer trying to stress the retry budget.
      console.log(`[verify5] cleaning up`);
      for (const t of terms) {
        await clearPayments(api, token, seed.realmId, seed.tenantId, t);
      }
      for (const o of outcomes) {
        if (o.kind === 'expense' && o.expenseId) {
          await deleteExpense(api, token, seed.realmId, seed.buildingId, o.expenseId);
        }
      }
    } finally {
      await api.dispose();
    }
  });
});
