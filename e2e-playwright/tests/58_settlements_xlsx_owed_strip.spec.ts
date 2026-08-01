/**
 * Spec 58 — C1 settlements XLSX: 'Total owed' strips the carried balance.
 *
 * The settlements export (GET /csv/settlements/:year) builds a real .xlsx with
 * per-month paid/owed pairs + Σ sums. rent.total.grandTotal is CUMULATIVE — it
 * carries every prior unpaid month — so summing it per-month double-counts the
 * arrears (a 3-month-unpaid €1000/mo tenant would print €6,000 owed instead of
 * €3,000). The C1 fix strips the carried balance per month.
 *
 * The existing 55.3 only asserts the OWNER xlsx is a valid zip (PK header,
 * parses zero cells) — tautological. This spec parses the TENANT settlements
 * workbook with ExcelJS and asserts the Σ-owed cell is the true arrears.
 *
 * Seeds (mongo) a dedicated arrears tenant with rents shaped the way the
 * settlements aggregate reads them (explicit rents.year + rents.month + total
 * with the cumulative grandTotal + carried balance). Dropped in afterAll.
 *
 * Skips cleanly when portainer-token is absent.
 */
import { expect, request, test } from '@playwright/test';
import { mongoExec } from './lib/mongoExec';
import { getAccessToken } from './lib/api';
import ExcelJS from 'exceljs';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const ORG = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';

const TENANT = 'E2E58-ArrearsTenant';
const now = new Date();
const YEAR = now.getFullYear();

let realmId = '';
let token = '';

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

function q(s: string) {
  return s.replace(/"/g, '\\"');
}

// A tenant €1000/mo, unpaid Jan/Feb/Mar of the current year. grandTotal is the
// CUMULATIVE running ledger (1000, 2000, 3000); balance is the carried-in prior
// deficit (0, 1000, 2000). The settlements aggregate matches on rents.year and
// reads rents.month — so seed those explicitly.
function seedTenant() {
  return mongoExec(`
    var r = db.realms.findOne({name: "${q(ORG)}"});
    if (!r) { print("NO_REALM"); quit(); }
    var rid = String(r._id.valueOf());
    db.occupants.deleteMany({name: /^E2E58-/});
    db.occupants.insertOne({
      realmId: rid, name: "${TENANT}", isCompany: false,
      beginDate: new Date(${YEAR},0,1), endDate: new Date(${YEAR},11,31), terminationDate: null,
      properties: [{ propertyId: "aa0000000000000000005801", entryDate: new Date(${YEAR},0,1), exitDate: new Date(${YEAR},11,31), property: { name: "E2E58-P", type: "apartment" } }],
      rents: [
        { term:${YEAR}010100, year:${YEAR}, month:1, total:{ grandTotal:1000, payment:0, balance:0 },    payments:[] },
        { term:${YEAR}020100, year:${YEAR}, month:2, total:{ grandTotal:2000, payment:0, balance:1000 }, payments:[] },
        { term:${YEAR}030100, year:${YEAR}, month:3, total:{ grandTotal:3000, payment:0, balance:2000 }, payments:[] }
      ]
    });
    print(rid);
  `);
}

test.beforeAll(async () => {
  test.skip(mongoExec('print("ok")') === null, 'no mongo');
  const ctx = await request.newContext();
  token = await getAccessToken(ctx);
  await ctx.dispose();
  const raw = seedTenant();
  const last = String(raw).split('\n').map((l) => l.trim()).filter(Boolean).pop()!;
  expect(last).not.toBe('NO_REALM');
  realmId = last.match(/[a-f0-9]{24}/i)![0];
});

test.afterAll(async () => {
  mongoExec(`db.occupants.deleteMany({name: /^E2E58-/}); print("clean");`);
});

test('58.1 — settlements XLSX Σ-owed is the true arrears €3,000, not the cumulative €6,000', async () => {
  const ctx = await request.newContext();
  const resp = await ctx.get(`${GATEWAY}/api/v2/csv/settlements/${YEAR}`, {
    headers: { Authorization: `Bearer ${token}`, organizationid: realmId }
  });
  expect(resp.status(), await resp.text().catch(() => '')).toBe(200);
  const body = await resp.body();
  expect(body.slice(0, 2).toString('latin1'), 'is an xlsx zip').toBe('PK');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(body);
  const ws = wb.worksheets[0];

  // Locate the header row + the 'owed sum' column (the export labels it via the
  // 'Total owed' i18n key — el-GR 'Σύνολο οφειλών', en 'Total owed').
  let headerRow = -1;
  let totalOwedCol = -1;
  ws.eachRow((row, rn) => {
    row.eachCell((cell, cn) => {
      const v = String(cell.value ?? '').toLowerCase();
      if (v.includes('total owed') || v.includes('σύνολο οφειλ')) {
        headerRow = rn;
        totalOwedCol = cn;
      }
    });
  });
  expect(totalOwedCol, 'Total-owed column found in header').toBeGreaterThan(0);

  // Find our tenant's data row (the cell containing the tenant name) and read
  // its Total-owed value.
  let owedVal: number | null = null;
  ws.eachRow((row, rn) => {
    if (rn <= headerRow) return;
    let isTenantRow = false;
    row.eachCell((cell) => {
      if (String(cell.value ?? '').includes(TENANT)) isTenantRow = true;
    });
    if (isTenantRow) {
      const c = row.getCell(totalOwedCol).value;
      owedVal = typeof c === 'object' && c !== null && 'result' in (c as any)
        ? Number((c as any).result)
        : Number(c);
    }
  });
  expect(owedVal, `tenant ${TENANT} row found with a Total-owed cell`).not.toBeNull();
  // 3 × €1000 monthly bill = €3,000 — NOT the cumulative 1000+2000+3000 = €6,000.
  expect(Math.abs(Number(owedVal) - 3000)).toBeLessThanOrEqual(0.5);
});
