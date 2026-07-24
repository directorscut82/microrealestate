/**
 * 62 — REGRESSION GUARD for the repair-clobber fix (commit cf276bff).
 *
 * saveMonthlyStatement's per-term strip was source-blind and deleted a term's
 * tenant REPAIR charges ({term, repairId}) that it never rebuilds — so recording
 * a monthly statement silently wiped that month's repair charge. The fix scopes
 * the strip to non-repair rows (buildingmanager.ts, `&& !c.repairId`).
 *
 * This spec reproduces the exact scenario on the live NAS: create a tenant-charged
 * repair for a term → save a monthly statement for the SAME term → assert the
 * repair charge SURVIVES (and the expense charge is written). Before the fix the
 * repair charge count went 1→0; after, it stays 1.
 *
 * Uses ensureSeedRichBuilding (occupied units) so the repair tenant-share actually
 * materialises into unit.monthlyCharges (a vacant unit produces no tenant charge).
 */
import { test, expect } from '@playwright/test';
import { ensureSeedRichBuilding, type RichBuildingSeed } from './lib/api';

const GATEWAY = process.env.GATEWAY_URL || 'http://192.168.0.96:1350';

let seed: RichBuildingSeed;
let auth: Record<string, string>;

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

test.beforeAll(async ({ request }) => {
  seed = await ensureSeedRichBuilding(request);
  auth = {
    Authorization: `Bearer ${seed.token}`,
    'Content-Type': 'application/json',
    organizationid: seed.realmId
  };
});

// current month YYYYMMDDHH (thawed by definition — repair edits + statement saves allowed)
function currentTerm(): number {
  const d = new Date();
  return Number(
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}0100`
  );
}

// count repair monthlyCharges (repairId set) for a term across all units
function countRepairCharges(building: any, term: number): number {
  let n = 0;
  for (const u of building.units || []) {
    for (const c of u.monthlyCharges || []) {
      if (Number(c.term) === term && c.repairId) n++;
    }
  }
  return n;
}

test('a monthly-statement save must NOT wipe the term\'s repair charges', async ({
  request
}) => {
  const term = currentTerm();

  // 1) create a tenant-charged repair for this term → repair charge(s) appear
  const afterRepair = await (
    await request.post(`${GATEWAY}/api/v2/buildings/${seed.buildingId}/repairs`, {
      headers: auth,
      data: {
        title: 'E2E-RepairClobberGuard',
        category: 'other',
        chargeableTo: 'tenants',
        tenantSharePercentage: 100,
        chargeTerm: term,
        actualCost: 90,
        allocationMethod: 'equal',
        status: 'completed'
      }
    })
  ).json();
  const repairBefore = countRepairCharges(afterRepair, term);
  expect(repairBefore, 'repair charge materialised on an occupied unit').toBeGreaterThan(0);

  const repairId = (afterRepair.repairs || []).find(
    (r: any) => r.title === 'E2E-RepairClobberGuard'
  )?._id;

  // 2) save a monthly statement for the SAME term (a different expense)
  const expense = (afterRepair.expenses || []).find((e: any) => !e.endTerm);
  expect(expense, 'building has an expense to bill').toBeDefined();
  const stmt = await request.post(
    `${GATEWAY}/api/v2/buildings/${seed.buildingId}/monthly-statement`,
    {
      headers: auth,
      data: {
        term,
        expenses: [
          { expenseId: String(expense._id), amount: 55, description: 'E2E-stmt' }
        ]
      }
    }
  );
  expect(stmt.status(), 'monthly-statement save').toBe(200);
  const afterStmt = await stmt.json();

  // 3) THE GUARD: repair charge count must be preserved (was 1→0 before the fix)
  const repairAfter = countRepairCharges(afterStmt, term);
  expect(
    repairAfter,
    `repair charges must survive the statement save (was ${repairBefore})`
  ).toBe(repairBefore);

  // cleanup
  if (repairId) {
    await request
      .delete(`${GATEWAY}/api/v2/buildings/${seed.buildingId}/repairs/${repairId}`, {
        headers: auth
      })
      .catch(() => {});
  }
});
