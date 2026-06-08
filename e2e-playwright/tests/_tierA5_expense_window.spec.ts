import { test, expect } from '@playwright/test';
import { ensureSeedProperty, ensureSeedLease } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

/**
 * Tier A5 — Expense window validation (B2 fix).
 *
 * Server: services/api/src/managers/occupantmanager.ts _validatePropertyWindows()
 * Per-property expenses (tenant.properties[].expenses[]) now validated:
 *   - amount must be ≥0 (already partial; tightened)
 *   - beginDate ≤ endDate when both set
 *   - expense window must sit within property's entry/exit window
 *
 * Without these guards an expense with an inverted window persisted and
 * silently never appeared on the rent ledger. The user-reported B2 bug.
 */

test.describe.serial('Tier A5: expense window validation', () => {
  test('rejects expense with beginDate > endDate', async ({ request }) => {
    const seed = await ensureSeedProperty(request);
    const lease = await ensureSeedLease(request);
    const auth = {
      Authorization: `Bearer ${seed.token}`,
      'Content-Type': 'application/json',
      organizationid: seed.realmId
    };
    const unique = `E2E-A5-Inv-${Math.floor(Math.random() * 100000)}`;
    const r = await request.post(`${GATEWAY}/api/v2/tenants`, {
      headers: auth,
      data: {
        name: unique,
        firstName: 'A5',
        lastName: unique,
        taxId: '111222333',
        manager: unique,
        beginDate: '01/01/2026',
        endDate: '31/12/2026',
        leaseId: lease.leaseId,
        isCompany: false,
        properties: [
          {
            propertyId: seed.propertyId,
            entryDate: '01/01/2026',
            exitDate: '31/12/2026',
            rent: 100,
            expenses: [
              {
                title: 'koina',
                amount: 50,
                beginDate: '15/06/2026',
                endDate: '01/03/2026' // <— inverted
              }
            ]
          }
        ]
      }
    });
    expect(r.status(), 'inverted expense window').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('beginDate');
  });

  test('rejects expense window outside property window', async ({ request }) => {
    const seed = await ensureSeedProperty(request);
    const lease = await ensureSeedLease(request);
    const auth = {
      Authorization: `Bearer ${seed.token}`,
      'Content-Type': 'application/json',
      organizationid: seed.realmId
    };
    const unique = `E2E-A5-Out-${Math.floor(Math.random() * 100000)}`;
    const r = await request.post(`${GATEWAY}/api/v2/tenants`, {
      headers: auth,
      data: {
        name: unique,
        firstName: 'A5',
        lastName: unique,
        taxId: '111222333',
        manager: unique,
        beginDate: '01/03/2026',
        endDate: '30/09/2026',
        leaseId: lease.leaseId,
        isCompany: false,
        properties: [
          {
            propertyId: seed.propertyId,
            entryDate: '01/03/2026',
            exitDate: '30/09/2026',
            rent: 100,
            expenses: [
              {
                title: 'before-entry',
                amount: 50,
                beginDate: '01/01/2026', // <— before property entryDate
                endDate: '15/03/2026'
              }
            ]
          }
        ]
      }
    });
    expect(r.status(), 'expense before property entry').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('entryDate');
  });

  test('rejects negative expense amount', async ({ request }) => {
    const seed = await ensureSeedProperty(request);
    const lease = await ensureSeedLease(request);
    const auth = {
      Authorization: `Bearer ${seed.token}`,
      'Content-Type': 'application/json',
      organizationid: seed.realmId
    };
    const unique = `E2E-A5-Neg-${Math.floor(Math.random() * 100000)}`;
    const r = await request.post(`${GATEWAY}/api/v2/tenants`, {
      headers: auth,
      data: {
        name: unique,
        firstName: 'A5',
        lastName: unique,
        taxId: '111222333',
        manager: unique,
        beginDate: '01/01/2026',
        endDate: '31/12/2026',
        leaseId: lease.leaseId,
        isCompany: false,
        properties: [
          {
            propertyId: seed.propertyId,
            entryDate: '01/01/2026',
            exitDate: '31/12/2026',
            rent: 100,
            expenses: [
              { title: 'neg', amount: -50, beginDate: '01/01/2026', endDate: '31/12/2026' }
            ]
          }
        ]
      }
    });
    expect(r.status(), 'negative expense amount').toBe(422);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('amount');
  });
});
