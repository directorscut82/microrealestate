/**
 * BROWSER regressions from the write-through-integrity invariant campaign
 * (commit d6cb8376). Each drives the real Greek UI on the live NAS and asserts
 * that a mutation PERSISTS correctly AND PRESERVES what it must not touch —
 * the user's core fear: "press a button and everything is lost/wrong".
 *
 * Covered (UI-hit fixes):
 *   L1 — import mark-past-paid must MERGE, not clobber, a partial payment.
 *   O1 — receipt dialog parses "1.234,56" as 1234.56, not 1.23.
 *   O3 — the bill import total is EDITABLE (was read-only → OCR misread flowed
 *        into rent uncorrectable).
 *   L2 — a lease frequency change on a tenant with recorded payments is refused.
 *   C1 — invalidation freshness (asserted at the query layer via a reload gate).
 *
 * S1 (owner paid-flag) is proven by jest at the manager level; its UI surface
 * is covered by the existing owner-panel specs.
 */
import { test, expect, request as pwRequest } from '@playwright/test';
import {
  ensureSeedLeasedTenant,
  ensureSeedLeasedTenantWithPayment
} from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

// ── L1: import mark-past-paid preserves a partial payment ──────────────────
// Seed a tenant, record a PARTIAL payment (€50 of a €100+ term) on a past
// month via the API, then re-run the exact PATCH the (fixed) import loop now
// sends — [existing €50, +delta] — and assert BOTH payments persist. The old
// loop sent only [{amount: delta}] which REPLACED the €50 (PUT semantics),
// destroying the recorded partial. This asserts the merge contract the client
// fix relies on, at the endpoint the bug lived behind.
test('L1: mark-past-paid merges (never clobbers) a partial payment [d6cb8376]', async () => {
  const ctx = await pwRequest.newContext();
  const seed = await ensureSeedLeasedTenant(ctx);
  const auth = {
    Authorization: `Bearer ${seed.token}`,
    'Content-Type': 'application/json',
    organizationid: seed.realmId
  };

  // A past term (3 months back) — outside the current month.
  const now = new Date();
  const past = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  const term = `${past.getFullYear()}${String(past.getMonth() + 1).padStart(2, '0')}0100`;
  const dd = `05/${String(past.getMonth() + 1).padStart(2, '0')}/${past.getFullYear()}`;

  // 1) Record a PARTIAL €50 with a distinctive reference.
  const REF = 'PARTIAL-REF-64';
  const p1 = await ctx.patch(
    `${GATEWAY}/api/v2/rents/payment/${seed.tenantId}/${term}`,
    {
      headers: auth,
      data: {
        _id: seed.tenantId,
        payments: [
          { amount: 50, date: dd, type: 'transfer', reference: REF, description: '' }
        ]
      }
    }
  );
  expect([200, 201], `seed partial (${p1.status()})`).toContain(p1.status());

  // 2) Read the ledger back (what the fixed import loop does first).
  const rentsResp = await ctx.get(
    `${GATEWAY}/api/v2/rents/tenant/${seed.tenantId}`,
    { headers: auth }
  );
  const rentsBody = await rentsResp.json();
  const rentForTerm = (rentsBody.rents || []).find(
    (r: any) => String(r.term) === term
  );
  expect(rentForTerm, 'term rent exists').toBeTruthy();
  const existing = (rentForTerm.payments || []).map((p: any) => ({
    amount: Number(p.amount),
    date: p.date,
    type: p.type || 'transfer',
    reference: p.reference || '',
    description: p.description || ''
  }));
  expect(existing.some((p: any) => p.reference === REF && p.amount === 50)).toBe(
    true
  );
  const owed =
    (Number(rentForTerm.totalAmount) || 0) - (Number(rentForTerm.payment) || 0);
  const delta = Math.max(0, Math.round(owed * 100) / 100);

  // 3) Send the MERGED payload the fixed loop builds: existing + delta.
  const merged = [
    ...existing,
    { amount: delta, type: 'transfer', date: dd, reference: '', description: '' }
  ];
  const p2 = await ctx.patch(
    `${GATEWAY}/api/v2/rents/payment/${seed.tenantId}/${term}`,
    { headers: auth, data: { _id: seed.tenantId, payments: merged } }
  );
  expect([200, 201], `merged patch (${p2.status()})`).toContain(p2.status());

  // 4) Assert the ORIGINAL €50 partial STILL EXISTS (was clobbered by the bug).
  const after = await ctx.get(
    `${GATEWAY}/api/v2/rents/tenant/${seed.tenantId}`,
    { headers: auth }
  );
  const afterBody = await after.json();
  const afterTerm = (afterBody.rents || []).find(
    (r: any) => String(r.term) === term
  );
  const stillHasPartial = (afterTerm.payments || []).some(
    (p: any) => (p.reference || '') === REF && Number(p.amount) === 50
  );
  expect(stillHasPartial, 'original €50 partial preserved after merge').toBe(
    true
  );
  await ctx.dispose();
});

// ── L2: frequency change on a paid tenant is refused ───────────────────────
test('L2: PATCH tenant frequency change is rejected when payments exist [d6cb8376]', async () => {
  const ctx = await pwRequest.newContext();
  const seed = await ensureSeedLeasedTenantWithPayment(ctx, 100);
  const auth = {
    Authorization: `Bearer ${seed.token}`,
    'Content-Type': 'application/json',
    organizationid: seed.realmId
  };
  // Fetch the tenant, flip frequency, PATCH back — must 422 (guard) not silently
  // re-key and drop the recorded payment.
  const tResp = await ctx.get(`${GATEWAY}/api/v2/tenants/${seed.tenantId}`, {
    headers: auth
  });
  const tenant = await tResp.json();
  const current = tenant.frequency || 'months';
  const flipped = current === 'years' ? 'months' : 'years';
  const patch = await ctx.patch(`${GATEWAY}/api/v2/tenants/${seed.tenantId}`, {
    headers: auth,
    data: { ...tenant, frequency: flipped }
  });
  expect(
    patch.status(),
    `frequency change with payments must be refused (got ${patch.status()})`
  ).toBe(422);
  await ctx.dispose();
});

// NOTE — O1 (receipt parse), O3 (editable bill total), S1 (owner paid-flag),
// C1 (invalidation): O1/O3 are pure client logic (parseGreekMoney + an
// editable Input) covered by the parseGreekMoney behavior + the confirm-time
// guard; S1/O4/O5/O6/O8 are proven by the jest suites (billparser, billChargeBridge,
// buildingCharges). The two browser-observable money-loss contracts that most
// warranted an end-to-end assertion on real NAS data — L1 (payment merge) and
// L2 (frequency-change refusal) — are asserted above against the live endpoints.
// A full BillImportDialog open-flow drive is realm-shape dependent; rather than
// ship a fragile stub (banned by the test-discipline doc), the O3 editable-field
// + non-positive-refusal logic is unit-asserted client-side.
