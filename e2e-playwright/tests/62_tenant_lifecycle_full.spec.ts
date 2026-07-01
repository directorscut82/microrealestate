/**
 * Full tenant money-lifecycle e2e against the LIVE API (the class of bug that
 * the July 2026 import review exposed and that no prior test covered). Drives
 * the real endpoints and asserts the LEDGER at each step, so a silent
 * field-mismatch / balance-snowball / status-boundary bug fails HERE instead of
 * reaching the user.
 *
 * Scenarios (all on the CYPRESS-TEST realm, namespaced E2E62-, self-cleaning):
 *   A. create tenant (rent 180, 4 past months) → mark-past-paid the CORRECT way
 *      (pay totalAmount−payment per refetched term) → every past month settles
 *      to newBalance 0 and the current month carries only its own rent (#4).
 *   B. server double-occupancy guard: a SECOND tenant on the SAME property+window
 *      is rejected 422 (the guard #2's per-row isolation must tolerate).
 *   C. terminate TODAY → the tenant reads terminated (#5).
 *   D. delete a tenant WITH recorded payments → blocked 422 (#6's server side).
 */
import { test, request, expect } from '@playwright/test';
import { getAccessToken } from './lib/api';
import moment from 'moment';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const ORG = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';
const AFM = '123456783'; // valid Greek ΑΦΜ checksum
const STAMP = String(Date.now()).slice(-6);

test.describe.configure({ mode: 'serial', timeout: 4 * 60_000 });

let tok = '';
let realmId = '';
let leaseId = '';
let propId = '';
let tenantId = '';
const h = () => ({
  Authorization: `Bearer ${tok}`,
  'Content-Type': 'application/json',
  organizationid: realmId
});

async function api() {
  return request.newContext();
}
async function ledger(ctx: any, id: string) {
  const r = await ctx.get(`${GATEWAY}/api/v2/rents/tenant/${id}`, {
    headers: h()
  });
  const d = await r.json();
  return (d.rents || []) as any[];
}

test.beforeAll(async () => {
  const ctx = await api();
  tok = await getAccessToken(ctx);
  const realms = await (
    await ctx.get(`${GATEWAY}/api/v2/realms`, { headers: { Authorization: `Bearer ${tok}` } })
  ).json();
  const realm = realms.find((r: any) => r.name === ORG) || realms[0];
  realmId = realm._id;
  await ctx.dispose();
});

// SCOPE NOTE for A: this drives the API the way the FIXED dialog does (pay
// totalAmount−payment per refetched term) and asserts the ledger settles with
// no snowball — it guards the SERVER contract the fix relies on. It does NOT
// render ImportTenantDialog, so the dialog's field-read (totalAmount vs the
// old .total.grandTotal) is guarded by code review + the live repro, not here.
// A future browser-level test should drive the dialog itself.
test('A. mark-past-paid settles every past term to zero (no snowball) [#4]', async () => {
  const ctx = await api();
  leaseId = (
    await (
      await ctx.post(`${GATEWAY}/api/v2/leases`, {
        headers: h(),
        data: { name: `E2E62-L-${STAMP}`, numberOfTerms: 24, timeRange: 'months', active: true }
      })
    ).json()
  )._id;
  propId = (
    await (
      await ctx.post(`${GATEWAY}/api/v2/properties`, {
        headers: h(),
        data: {
          name: `E2E62-P-${STAMP}`,
          type: 'apartment',
          surface: 50,
          price: 180,
          rent: 180,
          address: { street1: 'E2E62 1', zipCode: '10000', city: 'Athens' }
        }
      })
    ).json()
  )._id;
  // Start 4 months before "today" so Mar..prev are past terms.
  const begin = moment.utc().subtract(4, 'month').startOf('month');
  const end = begin.clone().add(24, 'month');
  tenantId = (
    await (
      await ctx.post(`${GATEWAY}/api/v2/tenants`, {
        headers: h(),
        data: {
          name: `E2E62-T-${STAMP}`,
          firstName: 'E2E',
          lastName: 'Tenant',
          isCompany: false,
          taxId: AFM,
          leaseId,
          beginDate: begin.format('DD/MM/YYYY'),
          endDate: end.format('DD/MM/YYYY'),
          properties: [
            {
              propertyId: propId,
              rent: 180,
              expenses: [],
              entryDate: begin.format('DD/MM/YYYY'),
              exitDate: end.format('DD/MM/YYYY')
            }
          ],
          contacts: [{ contact: 'E2E', email: '', phone1: '' }]
        }
      })
    ).json()
  )._id;
  expect(tenantId, 'tenant created').toBeTruthy();

  // Mark past months paid the FIXED way: refetch per term, pay totalAmount−payment.
  const pastTerms: string[] = [];
  for (let i = 4; i >= 1; i--) {
    pastTerms.push(moment.utc().subtract(i, 'month').format('YYYYMM') + '0100');
  }
  for (const term of pastTerms) {
    const rents = await ledger(ctx, tenantId);
    const r = rents.find((x) => String(x.term) === term);
    const owed = Math.max(0, (Number(r.totalAmount) || 0) - (Number(r.payment) || 0));
    await ctx.patch(`${GATEWAY}/api/v2/rents/payment/${tenantId}/${term}`, {
      headers: h(),
      data: {
        _id: tenantId,
        payments: [{ amount: owed, type: 'transfer', date: term.slice(6, 8) + '/' + term.slice(4, 6) + '/' + term.slice(0, 4) }]
      }
    });
  }

  const rents = await ledger(ctx, tenantId);
  // Every PAST month must be fully settled (newBalance 0) — no snowball.
  for (const term of pastTerms) {
    const r = rents.find((x) => String(x.term) === term);
    expect(Math.abs(Number(r.newBalance)), `past term ${term} settled`).toBeLessThanOrEqual(0.01);
  }
  // Current month owes ONLY its own rent (−180), NOT an inflated carried balance.
  const curTerm = moment.utc().format('YYYYMM') + '0100';
  const cur = rents.find((x) => String(x.term) === curTerm);
  if (cur) {
    expect(Number(cur.newBalance), 'current month carries only its own rent').toBe(-180);
  }
  await ctx.dispose();
});

test('B. second tenant on the same occupied property+window is rejected 422 [#2 guard]', async () => {
  const ctx = await api();
  const begin = moment.utc().subtract(4, 'month').startOf('month');
  const end = begin.clone().add(24, 'month');
  const r = await ctx.post(`${GATEWAY}/api/v2/tenants`, {
    headers: h(),
    data: {
      name: `E2E62-DUP-${STAMP}`,
      firstName: 'Dup',
      lastName: 'Tenant',
      isCompany: false,
      taxId: '100000003',
      leaseId,
      beginDate: begin.format('DD/MM/YYYY'),
      endDate: end.format('DD/MM/YYYY'),
      properties: [
        {
          propertyId: propId,
          rent: 180,
          expenses: [],
          entryDate: begin.format('DD/MM/YYYY'),
          exitDate: end.format('DD/MM/YYYY')
        }
      ],
      contacts: [{ contact: 'Dup', email: '', phone1: '' }]
    }
  });
  // The server MUST reject the overlap (this is the 422 the import loop must
  // catch per-row, NOT abort the whole batch on).
  expect(r.status(), 'double-occupancy rejected').toBe(422);
  await ctx.dispose();
});

test('C. terminate today → tenant reads terminated [#5]', async () => {
  const ctx = await api();
  const today = moment.utc().format('DD/MM/YYYY');
  const full = await (await ctx.get(`${GATEWAY}/api/v2/tenants/${tenantId}`, { headers: h() })).json();
  const patch = await ctx.patch(`${GATEWAY}/api/v2/tenants/${tenantId}`, {
    headers: h(),
    data: { ...full, terminationDate: today }
  });
  expect(patch.status(), 'terminate patch').toBe(200);
  const t = await patch.json();
  expect(t.terminated, 'terminated today → terminated=true').toBe(true);
  await ctx.dispose();
});

test('D. delete a tenant with recorded payments is blocked 422 [#6 server]', async () => {
  const ctx = await api();
  const r = await ctx.delete(`${GATEWAY}/api/v2/tenants/${tenantId}`, { headers: h() });
  expect(r.status(), 'delete blocked (has payments)').toBe(422);
  await ctx.dispose();
});

test.afterAll(async () => {
  // Force-archive-delete to clean up (force=true removes even paid tenants).
  const ctx = await api();
  await ctx
    .delete(`${GATEWAY}/api/v2/tenants/${tenantId}?force=true`, { headers: h() })
    .catch(() => {});
  await ctx.delete(`${GATEWAY}/api/v2/properties/${propId}`, { headers: h() }).catch(() => {});
  await ctx.delete(`${GATEWAY}/api/v2/leases/${leaseId}`, { headers: h() }).catch(() => {});
  await ctx.dispose();
});
