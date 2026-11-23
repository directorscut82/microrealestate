import { APIRequestContext, expect, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import path from 'path';
import { LeaseSeed, makeValidGreekAFM } from './api';

/**
 * Shared plumbing for the specs that follow money through the rent ledger as the
 * landlord sees it: seed a tenant whose lease began a few months ago (so past months
 * exist and are unpaid), act through the Greek UI, read the rents row back as numbers.
 *
 * Everything a spec creates through here is named by the spec and removed by exact name,
 * before the run (a previous run may have died) and after it.
 */

const GATEWAY = process.env.NAS_GATEWAY_URL as string;

const auth = (seed: LeaseSeed) => ({
  Authorization: `Bearer ${seed.token}`,
  'Content-Type': 'application/json',
  organizationid: seed.realmId
});

const enc = encodeURIComponent;
const pad2 = (n: number) => String(n).padStart(2, '0');
const ddmmyyyy = (d: Date) =>
  `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;

// ── months ──────────────────────────────────────────────────────────────────────

export interface MonthRef {
  year: number;
  month: number;
  /** `2026.11` — the rents page URL segment. */
  ym: string;
  /** `2026110100` — the rent term. */
  term: number;
  /** A day of this month as DD/MM/YYYY, for API dates and for a bill's printed dates. */
  day: (dayOfMonth: number) => string;
  /** The last day of this month as DD/MM/YYYY. */
  lastDay: string;
}

/**
 * The month `offset` months from now (0 = this month, -1 = last month).
 *
 * LOCAL calendar on purpose: the UI builds its rents URL from the local date, so the seed
 * and the navigation must agree on it (E2E_TESTING.md, «Timezone mismatches»).
 */
export function monthRef(offset: number, now = new Date()): MonthRef {
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const year = first.getFullYear();
  const month = first.getMonth() + 1;
  return {
    year,
    month,
    ym: `${year}.${pad2(month)}`,
    term: Number(`${year}${pad2(month)}0100`),
    day: (dayOfMonth: number) =>
      ddmmyyyy(new Date(year, month - 1, dayOfMonth)),
    lastDay: ddmmyyyy(new Date(year, month, 0))
  };
}

/**
 * The server decides what «the current month» is in UTC; these specs navigate by the local
 * calendar. For a few hours at each month boundary (Athens is UTC+2/+3) the two disagree,
 * and «a past month» then means different things to the spec and to the app.
 */
export function serverAndBrowserAgreeOnTheMonth(now = new Date()): boolean {
  return (
    now.getMonth() === now.getUTCMonth() &&
    now.getFullYear() === now.getUTCFullYear()
  );
}

// ── seeding and removal (API) ───────────────────────────────────────────────────

export interface LedgerTenant {
  tenantId: string;
  tenantName: string;
  propertyId: string;
  propertyName: string;
}

/**
 * A tenant renting one apartment at `rent` per month, on a lease that began on the first
 * of the month `monthsBack` months ago. Nothing is paid, so each past month carries into
 * the next.
 */
export async function createLedgerTenant(
  request: APIRequestContext,
  seed: LeaseSeed,
  o: {
    tenantName: string;
    propertyName: string;
    /** Eight digits; the check digit is computed. Keep to the reserved 9990000x band. */
    afmFirst8: string;
    rent: number;
    monthsBack: number;
  }
): Promise<LedgerTenant> {
  const property = await request.post(`${GATEWAY}/api/v2/properties`, {
    headers: auth(seed),
    data: {
      name: o.propertyName,
      type: 'apartment',
      price: o.rent,
      surface: 50,
      address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1', city: 'ΔΟΚΙΜΑΙ', zipCode: '00000' }
    }
  });
  expect(
    [200, 201],
    `create property ${o.propertyName}: ${await property.text().catch(() => '')}`
  ).toContain(property.status());
  const propertyId = (await property.json())._id as string;

  const tenant = await request.post(`${GATEWAY}/api/v2/tenants`, {
    headers: auth(seed),
    data: {
      name: o.tenantName,
      firstName: 'E2E',
      lastName: o.tenantName,
      taxId: makeValidGreekAFM(o.afmFirst8),
      isCompany: false,
      manager: o.tenantName,
      contacts: [
        {
          contact: o.tenantName,
          email: '',
          phone1: '6900000000',
          phone: '',
          phone2: ''
        }
      ],
      leaseId: seed.leaseId,
      // Twelve months from the first day: the shared «E2E-Lease» is a one-year lease.
      beginDate: monthRef(-o.monthsBack).day(1),
      endDate: monthRef(-o.monthsBack + 11).lastDay,
      properties: [{ propertyId, rent: o.rent, expenses: [] }]
    }
  });
  expect(
    [200, 201],
    `create tenant ${o.tenantName}: ${await tenant.text().catch(() => '')}`
  ).toContain(tenant.status());
  const tenantId = (await tenant.json())._id as string;

  return {
    tenantId,
    tenantName: o.tenantName,
    propertyId,
    propertyName: o.propertyName
  };
}

export interface BillBuilding {
  buildingId: string;
  expenseId: string;
}

/**
 * A building whose units are the given apartments in equal shares, with one variable
 * common-electricity expense keyed to `billingId` — so a bill printing that supply number
 * is matched to it without anyone picking a building.
 */
export async function createBillBuilding(
  request: APIRequestContext,
  seed: LeaseSeed,
  o: {
    name: string;
    /** Exactly six digits, unique in the realm. */
    atakPrefix: string;
    propertyIds: string[];
    expenseName: string;
    billingId: string;
    startTerm: number;
  }
): Promise<BillBuilding> {
  const building = await request.post(`${GATEWAY}/api/v2/buildings`, {
    headers: auth(seed),
    data: {
      name: o.name,
      atakPrefix: o.atakPrefix,
      address: { street1: 'ΟΔΟΣ ΒΗΤΑ 2', city: 'ΔΟΚΙΜΑΙ', zipCode: '00000' }
    }
  });
  expect(
    [200, 201],
    `create building ${o.name}: ${await building.text().catch(() => '')}`
  ).toContain(building.status());
  const buildingId = (await building.json())._id as string;

  const share = Math.round(1000 / o.propertyIds.length);
  for (let i = 0; i < o.propertyIds.length; i++) {
    const unit = await request.post(
      `${GATEWAY}/api/v2/buildings/${buildingId}/units`,
      {
        headers: auth(seed),
        data: {
          atakNumber: `${o.atakPrefix}00${i + 1}`,
          isManaged: true,
          occupancyType: 'rented',
          propertyId: o.propertyIds[i],
          generalThousandths: share,
          heatingThousandths: share,
          elevatorThousandths: share,
          surface: 50,
          floor: i + 1
        }
      }
    );
    expect(
      [200, 201],
      `create unit ${i + 1} of ${o.name}: ${await unit.text().catch(() => '')}`
    ).toContain(unit.status());
  }

  const expense = await request.post(
    `${GATEWAY}/api/v2/buildings/${buildingId}/expenses`,
    {
      headers: auth(seed),
      data: {
        name: o.expenseName,
        type: 'electricity_common',
        amount: 0,
        isVariable: true,
        allocationMethod: 'general_thousandths',
        isRecurring: true,
        startTerm: o.startTerm,
        billingId: o.billingId
      }
    }
  );
  expect(
    [200, 201],
    `create expense ${o.expenseName}: ${await expense.text().catch(() => '')}`
  ).toContain(expense.status());
  const created = (
    (await expense.json()).expenses as Array<{ _id: string; name: string }>
  ).find((e) => e.name === o.expenseName);
  expect(created, `expense ${o.expenseName} present after create`).toBeTruthy();

  return { buildingId, expenseId: created!._id };
}

async function listOf(
  request: APIRequestContext,
  seed: LeaseSeed,
  resource: 'tenants' | 'buildings' | 'properties'
): Promise<Array<{ _id: string; name: string }>> {
  // The tenants list leaves archived tenants out unless asked. An archived fixture
  // would be invisible to the clean-up while still holding its apartment, and every
  // later run would then fail to delete that apartment.
  const query = resource === 'tenants' ? '?includeArchived=true' : '';
  const r = await request.get(`${GATEWAY}/api/v2/${resource}${query}`, {
    headers: auth(seed)
  });
  expect(r.status(), `list ${resource}`).toBe(200);
  const body = await r.json();
  return Array.isArray(body) ? body : body.items || [];
}

/**
 * Remove fixtures by EXACT name, in the only order the API allows: recorded payments,
 * then tenants, then buildings (which takes their bills with them), then apartments.
 * A name that is not there is skipped, so this is safe to call before a run as well as
 * after one. Anything the API refuses to delete fails loudly: a leftover tenant with
 * arrears would sit in every later spec's rents page.
 */
export async function removeLedgerFixtures(
  request: APIRequestContext,
  seed: LeaseSeed,
  names: { tenants?: string[]; buildings?: string[]; properties?: string[] }
): Promise<void> {
  const tenants = (await listOf(request, seed, 'tenants')).filter((t) =>
    (names.tenants || []).includes(t.name)
  );
  for (const tenant of tenants) {
    const ledger = await request.get(
      `${GATEWAY}/api/v2/rents/tenant/${tenant._id}`,
      { headers: auth(seed) }
    );
    expect(ledger.status(), `ledger of ${tenant.name}`).toBe(200);
    const rents = ((await ledger.json()).rents || []) as Array<{
      term: number;
      payment: number;
      promo?: number;
      discount?: number;
    }>;
    // A write-off is a recorded discount with no payment, and the API refuses to delete
    // a tenant whose months carry either.
    for (const rent of rents.filter(
      (r) =>
        Number(r.payment) > 0 || Number(r.promo) > 0 || Number(r.discount) > 0
    )) {
      const term = String(rent.term);
      const cleared = await request.patch(
        `${GATEWAY}/api/v2/rents/payment/${tenant._id}/${term}`,
        {
          headers: auth(seed),
          data: {
            _id: tenant._id,
            month: Number(term.slice(4, 6)),
            year: Number(term.slice(0, 4)),
            payments: [],
            description: '',
            extracharge: 0,
            noteextracharge: '',
            promo: 0,
            notepromo: ''
          }
        }
      );
      expect(
        cleared.status(),
        `clear payment of ${tenant.name} on ${term}`
      ).toBe(200);
    }
  }
  if (tenants.length) {
    const r = await request.delete(
      `${GATEWAY}/api/v2/tenants/${tenants.map((t) => t._id).join(',')}`,
      { headers: auth(seed) }
    );
    expect(
      r.status(),
      `delete tenants ${tenants.map((t) => t.name).join(', ')}: ${await r.text().catch(() => '')}`
    ).toBe(200);
  }

  const buildings = (await listOf(request, seed, 'buildings')).filter((b) =>
    (names.buildings || []).includes(b.name)
  );
  if (buildings.length) {
    const r = await request.delete(
      `${GATEWAY}/api/v2/buildings/${buildings.map((b) => b._id).join(',')}`,
      { headers: auth(seed) }
    );
    expect(
      r.status(),
      `delete buildings ${buildings.map((b) => b.name).join(', ')}: ${await r.text().catch(() => '')}`
    ).toBe(200);
  }

  const properties = (await listOf(request, seed, 'properties')).filter((p) =>
    (names.properties || []).includes(p.name)
  );
  if (properties.length) {
    const r = await request.delete(
      `${GATEWAY}/api/v2/properties/${properties.map((p) => p._id).join(',')}`,
      { headers: auth(seed) }
    );
    expect(
      r.status(),
      `delete properties ${properties.map((p) => p.name).join(', ')}: ${await r.text().catch(() => '')}`
    ).toBe(200);
  }
}

export interface LedgerMonth {
  term: number;
  /** The month's total, including what it carried in. */
  totalToPay: number;
  /** What it carried in from the months before it (negative = credit). */
  balance: number;
  payment: number;
  discount: number;
  /** After this month: positive = the tenant is in credit, negative = still owes. */
  newBalance: number;
}

/** A tenant's months as the server holds them, oldest first, and whether the lease is ended. */
export async function ledgerOf(
  request: APIRequestContext,
  seed: LeaseSeed,
  tenantId: string
): Promise<{ months: LedgerMonth[]; terminated: boolean }> {
  const r = await request.get(`${GATEWAY}/api/v2/rents/tenant/${tenantId}`, {
    headers: auth(seed)
  });
  expect(r.status(), `ledger of ${tenantId}`).toBe(200);
  const body = await r.json();
  const months = ((body.rents || []) as Array<Record<string, unknown>>)
    .map((m) => ({
      term: Number(m.term),
      totalToPay: Number(m.totalToPay) || 0,
      balance: Number(m.balance) || 0,
      payment: Number(m.payment) || 0,
      discount: Number(m.discount) || 0,
      newBalance: Number(m.newBalance) || 0
    }))
    .sort((a, b) => a.term - b.term);
  return { months, terminated: !!body.occupant?.terminationDate };
}

/**
 * Record one cash payment on a month through the API — for specs whose SUBJECT is what
 * happens after the payment. The payment window itself is driven by `recordPayment`.
 */
export async function payByApi(
  request: APIRequestContext,
  seed: LeaseSeed,
  tenantId: string,
  month: MonthRef,
  amount: number
): Promise<void> {
  const r = await request.patch(
    `${GATEWAY}/api/v2/rents/payment/${tenantId}/${month.term}`,
    {
      headers: auth(seed),
      data: {
        _id: tenantId,
        month: month.month,
        year: month.year,
        payments: [
          {
            amount,
            // Today, never before the month it is recorded on (the API refuses that).
            date: ddmmyyyy(new Date()),
            type: 'cash',
            reference: 'E2E'
          }
        ],
        description: ''
      }
    }
  );
  expect(
    r.status(),
    `payment of ${amount} on ${month.ym}: ${await r.text().catch(() => '')}`
  ).toBe(200);
}

/** What the building's own «Χρεώσεις» table is built from: who is charged what, for a month. */
export async function tenantSharesFor(
  request: APIRequestContext,
  seed: LeaseSeed,
  buildingId: string,
  term: number
): Promise<Record<string, number>> {
  const r = await request.get(
    `${GATEWAY}/api/v2/buildings/${buildingId}/expense-breakdown?term=${term}`,
    { headers: auth(seed) }
  );
  expect(r.status(), 'expense breakdown').toBe(200);
  const rows = ((await r.json()).rows || []) as Array<{
    recipient: string;
    recipientName: string;
    amount: number;
  }>;
  const shares: Record<string, number> = {};
  for (const row of rows.filter((x) => x.recipient === 'renter')) {
    shares[row.recipientName] =
      Math.round(((shares[row.recipientName] || 0) + row.amount) * 100) / 100;
  }
  return shares;
}

/**
 * Save a building's statement for one month through the API, with one figure for its
 * expense — what the «Έξοδα» panel sends when the figure is typed and saved. Returns
 * what the app answers about each tenant's share (`statementOutcome`).
 */
export async function saveStatement(
  request: APIRequestContext,
  seed: LeaseSeed,
  building: BillBuilding,
  term: number,
  amount: number
): Promise<ShareOutcome[]> {
  const r = await request.post(
    `${GATEWAY}/api/v2/buildings/${building.buildingId}/monthly-statement`,
    {
      headers: auth(seed),
      data: { term, expenses: [{ expenseId: building.expenseId, amount }] }
    }
  );
  expect(
    r.status(),
    `statement of ${term} saved with ${amount}: ${await r.text().catch(() => '')}`
  ).toBe(200);
  return ((await r.json()).statementOutcome || []) as ShareOutcome[];
}

// ── synthetic bills ─────────────────────────────────────────────────────────────

/**
 * Render one synthetic ΔΕΗ bill as a PDF with the dates the spec needs, through the
 * repo's own fixture templates (`tools/make-bill-fixtures.mjs`, custom mode). Dates are
 * DD/MM/YYYY and `total` is as printed («100,00»). Returns the PDF's path.
 */
export function renderDehBill(
  outDir: string,
  name: string,
  bill: {
    supply: string;
    rf: string;
    total: string;
    periodFrom: string;
    periodTo: string;
    issue: string;
    due: string;
  }
): string {
  const root = path.resolve(__dirname, '../..');
  execFileSync(
    process.execPath,
    [
      path.join(root, 'tools/make-bill-fixtures.mjs'),
      outDir,
      '--custom',
      JSON.stringify([
        {
          name,
          kind: 'deh',
          params: { ...bill, kwh: '300', nextRead: bill.due }
        }
      ])
    ],
    { cwd: root, timeout: 120_000, stdio: 'pipe' }
  );
  return path.join(outDir, `${name}.pdf`);
}

// ── the landlord's screen ───────────────────────────────────────────────────────

export async function signIn(page: Page): Promise<void> {
  await page.goto('el/signin');
  await page.locator('input[name=email]').fill(process.env.TEST_EMAIL ?? '');
  await page
    .locator('input[name=password]')
    .fill(process.env.TEST_PASSWORD ?? '');
  await page.locator('[data-cy=submit]').first().click();
  // The pathname, not the URL: `/landlord/` is the app's own base path, so a pattern
  // that can match it resolves while the browser is still on the sign-in page.
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 60_000 })
    .toMatch(/\/(firstaccess|dashboard)/);
}

/** The rents page of one month, narrowed to the rows whose name contains `search`. */
export async function openRents(
  page: Page,
  realmName: string,
  month: MonthRef,
  search: string
): Promise<void> {
  await page.goto(
    `el/${enc(realmName)}/rents/${month.ym}?search=${enc(search)}`
  );
}

/** One tenant's row on the rents page. Exact name: a prefix match opens the wrong tenant. */
export function rentRow(page: Page, tenantName: string) {
  return page
    .locator(`span.text-lg.font-medium:text-is("${tenantName}")`)
    .locator(
      'xpath=ancestor::div[contains(@class, "flex") and .//*[contains(@class, "text-right")]][1]'
    );
}

export interface RentRow {
  /** «Μηνιαίο ποσό» — this month's own bill: rent plus the building charges added to it. */
  monthly: number;
  /** «Προηγούμενο υπόλοιπο» — what earlier months still owed when this row was computed. */
  previousBalance: number;
  /** «Συνολική οφειλή» */
  totalDue: number;
  /** «Καταβολή» */
  payment: number;
  /** «Υπόλοιπο» */
  remaining: number;
  /** «+… πίστωση» under «Υπόλοιπο»: what was paid beyond the total. 0 when not shown. */
  credit: number;
  /** The coloured dot: `paid`, `partial`, `owed` or `none`. */
  status: string;
}

const ROW_LABELS: Record<keyof Omit<RentRow, 'status' | 'credit'>, string> = {
  monthly: 'Μηνιαίο ποσό',
  previousBalance: 'Προηγούμενο υπόλοιπο',
  totalDue: 'Συνολική οφειλή',
  payment: 'Καταβολή',
  remaining: 'Υπόλοιπο'
};

/**
 * «1.234,56 €» → 1234.56; the dash → 0.
 *
 * The UI prints the same dash for zero and for a value that is missing altogether
 * (NumberFormat.js), so a dash alone cannot tell «nothing carried over» from «the figure
 * did not arrive». `expectRowAddsUp` below is what tells them apart.
 */
export function parseEuro(text: string): number {
  const compact = text.replace(/\s/g, '').replace('€', '');
  if (compact === '—' || compact === '') return 0;
  const n = Number(
    compact.replace(/\./g, '').replace(',', '.').replace('−', '-')
  );
  if (!Number.isFinite(n)) throw new Error(`not an amount: «${text}»`);
  return n;
}

/** Read a tenant's row as numbers, by the Greek labels the landlord reads. */
export async function readRentRow(
  page: Page,
  tenantName: string
): Promise<RentRow> {
  const row = rentRow(page, tenantName);
  await expect(row, `rents row of ${tenantName}`).toHaveCount(1, {
    timeout: 60_000
  });
  const lines = (await row.innerText())
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const amountUnder = (label: string) => {
    const i = lines.indexOf(label);
    if (i < 0 || i + 1 >= lines.length) {
      throw new Error(
        `«${label}» not found in the row of ${tenantName}: ${lines.join(' | ')}`
      );
    }
    return parseEuro(lines[i + 1]);
  };
  const dot = await row
    .locator('[data-cy^="status-"]')
    .first()
    .getAttribute('data-cy');
  // «Υπόλοιπο» never goes below zero; a surplus is printed under it as «+… πίστωση».
  const creditLine = lines.find((line) => /^\+.*πίστωση$/.test(line));
  return {
    monthly: amountUnder(ROW_LABELS.monthly),
    previousBalance: amountUnder(ROW_LABELS.previousBalance),
    totalDue: amountUnder(ROW_LABELS.totalDue),
    payment: amountUnder(ROW_LABELS.payment),
    remaining: amountUnder(ROW_LABELS.remaining),
    credit: creditLine
      ? parseEuro(creditLine.replace(/^\+/, '').replace(/πίστωση$/, ''))
      : 0,
    status: String(dot || '').replace('status-', '')
  };
}

/**
 * «Συνολική οφειλή» must be «Μηνιαίο ποσό» plus «Προηγούμενο υπόλοιπο». It holds for any
 * row with no promo and no extra charge (RentDetails.js `getRentAmounts`), which is every
 * row these fixtures produce. A carried balance that failed to arrive is printed as a
 * dash and read as 0 — and then this does not add up, which is the point of asserting it.
 */
export function expectRowAddsUp(row: RentRow, what: string): void {
  expect(
    Math.round((row.monthly + row.previousBalance) * 100) / 100,
    `${what}: «Μηνιαίο ποσό» + «Προηγούμενο υπόλοιπο» = «Συνολική οφειλή»`
  ).toBe(row.totalDue);
}

// After «για» — the accusative, as the app prints it (utils/greekMonths.js).
const EL_ACCUSATIVE = [
  'Ιανουάριο',
  'Φεβρουάριο',
  'Μάρτιο',
  'Απρίλιο',
  'Μάιο',
  'Ιούνιο',
  'Ιούλιο',
  'Αύγουστο',
  'Σεπτέμβριο',
  'Οκτώβριο',
  'Νοέμβριο',
  'Δεκέμβριο'
];

/** What the charge switch of the bill import window says for a bill of that month. */
export function chargeSwitchLabel(month: MonthRef): string {
  return `Χρέωση ενοικιαστών για ${EL_ACCUSATIVE[month.month - 1]} ${month.year}`;
}

/**
 * «για Οκτώβριο 2026» — how a share that is billed on a later month than the one it is
 * for is marked, on the rent («… · για Οκτώβριο 2026») and on the building's page.
 */
export function forMonthLabel(month: MonthRef): string {
  return `για ${EL_ACCUSATIVE[month.month - 1]} ${month.year}`;
}

// After a noun («το ενοίκιο Νοεμβρίου») — the genitive (utils/greekMonths.js).
const EL_GENITIVE = [
  'Ιανουαρίου',
  'Φεβρουαρίου',
  'Μαρτίου',
  'Απριλίου',
  'Μαΐου',
  'Ιουνίου',
  'Ιουλίου',
  'Αυγούστου',
  'Σεπτεμβρίου',
  'Οκτωβρίου',
  'Νοεμβρίου',
  'Δεκεμβρίου'
];

/** «✓ χρεώθηκε στο ενοίκιο Νοεμβρίου 2026» — the building page, for a share that moved. */
export function chargedOnRentOf(month: MonthRef): string {
  return `✓ χρεώθηκε στο ενοίκιο ${EL_GENITIVE[month.month - 1]} ${month.year}`;
}

/** «✓ στο ενοίκιο Νοεμβρίου 2026» — the import window, for a share that is on a rent. */
export function onRentOf(month: MonthRef): string {
  return `✓ στο ενοίκιο ${EL_GENITIVE[month.month - 1]} ${month.year}`;
}

/** «έχει εξοφλήσει τον Νοέμβριο» — under a share that went past a month paid in full. */
export function hasPaidLabel(month: MonthRef): string {
  return `έχει εξοφλήσει τον ${EL_ACCUSATIVE[month.month - 1]}`;
}

// Standing on its own — the nominative (utils/greekMonths.js).
const EL_NOMINATIVE = [
  'Ιανουάριος',
  'Φεβρουάριος',
  'Μάρτιος',
  'Απρίλιος',
  'Μάιος',
  'Ιούνιος',
  'Ιούλιος',
  'Αύγουστος',
  'Σεπτέμβριος',
  'Οκτώβριος',
  'Νοέμβριος',
  'Δεκέμβριος'
];

/** What the import window says above the list when the bill's month is closed for all. */
export function monthClosedSentence(month: MonthRef): string {
  return `Ο ${EL_NOMINATIVE[month.month - 1]} ${month.year} έχει κλείσει για τους ενοικιαστές. Το μερίδιο του καθενός μπήκε στο επόμενο ανοιχτό ενοίκιό του.`;
}

/**
 * The lines of the box that opens when the pointer rests on a tenant's «Μηνιαίο ποσό»
 * on the rents page that is open: what that month's own bill is made of, one
 * `label amount` per line, as the landlord reads them.
 */
export async function monthlyBreakdownOf(
  page: Page,
  tenantName: string
): Promise<string[]> {
  const trigger = rentRow(page, tenantName)
    .locator('div.cursor-default')
    .first();
  await expect(
    trigger,
    `«Μηνιαίο ποσό» of ${tenantName} has a breakdown to show`
  ).toHaveCount(1, { timeout: 60_000 });
  await trigger.hover();
  const box = page.locator('[role=tooltip]').first();
  await expect(box, 'the breakdown box').toBeVisible({ timeout: 15_000 });
  // One row of the box per line of the bill: its label, then its amount. Read row by
  // row, not by pairing up the lines of the text: the label of a share carried in from
  // another month is in two parts (the name, which may be cut short, and «· για
  // Οκτώβριο 2026», which never is), so it does not arrive as one line.
  const rows = await box
    .locator('div.flex.justify-between')
    .evaluateAll((els) =>
      els.map((el) =>
        ((el as HTMLElement).innerText || '')
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      )
    );
  // move away, so the box does not cover the next thing the spec reads
  await page.mouse.move(2, 2);
  return rows.filter(Boolean);
}

/**
 * Open a building's «Έξοδα» for one month and wait for its «Χρεώσεις» table: the
 * calendar button of that month, then the table's own request.
 */
export async function openBuildingMonth(
  page: Page,
  realmName: string,
  buildingId: string,
  month: MonthRef
): Promise<void> {
  await page.goto(`el/${enc(realmName)}/buildings/${buildingId}`);
  await page.locator('[data-cy=expensesTab]').click();
  const answered = page.waitForResponse(
    (r) =>
      r.url().includes(`/expense-breakdown?term=${month.term}`) &&
      r.request().method() === 'GET',
    { timeout: 60_000 }
  );
  await page.locator(`[data-cy="expenseMonth-${month.term}"]`).click();
  expect((await answered).status(), '«Χρεώσεις» of the month').toBe(200);
}

/**
 * What the «Χρεώσεις» table of the building page that is open says about where each
 * tenant share was really charged: one `[colour, text]` per line, top to bottom.
 */
export async function shareBillingLines(
  page: Page
): Promise<Array<[string, string]>> {
  return page
    .locator('[data-cy=shareBilling]')
    .evaluateAll((els) =>
      els.map((e) => [
        e.className.includes('text-olive')
          ? 'olive'
          : e.className.includes('text-oxide')
            ? 'oxide'
            : 'none',
        (e.textContent || '').replace(/\u00a0/g, ' ').trim()
      ])
    ) as Promise<Array<[string, string]>>;
}

/**
 * Record a payment for a tenant on the rents page that is open, through the payment
 * window: the cash-register button on the row, «Νέα καταβολή», the amount, «Εκτέλεση».
 * Returns once the app's own request has answered 200 and the row shows the payment.
 */
export async function recordPayment(
  page: Page,
  tenantName: string,
  amount: number
): Promise<void> {
  const row = rentRow(page, tenantName);
  const before = await readRentRow(page, tenantName);
  await row.getByRole('button', { name: 'Καταχώρηση πληρωμής' }).click();
  const dialog = page.locator('[role=dialog]');
  await expect(dialog).toBeVisible();
  await page.locator('[data-cy="addNewPayment"]').click();
  await page.locator('input[name="payments.0.amount"]').fill(String(amount));
  const saved = page.waitForResponse(
    (r) =>
      r.url().includes('/api/v2/rents/payment/') &&
      r.request().method() === 'PATCH',
    { timeout: 60_000 }
  );
  await dialog
    .locator('button')
    .filter({ hasText: /Εκτέλεση/ })
    .first()
    .click();
  const response = await saved;
  expect(
    response.status(),
    `payment of ${amount} for ${tenantName}: ${await response.text().catch(() => '')}`
  ).toBe(200);
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  // Read back from the page, after its own refetch: saving and showing are two things.
  await expect
    .poll(async () => (await readRentRow(page, tenantName)).payment, {
      timeout: 60_000,
      message: `«Καταβολή» of ${tenantName} after recording ${amount}`
    })
    .toBe(Math.round((before.payment + amount) * 100) / 100);
}

/**
 * Take a tenant's saved payment back on the rents page that is open, through the payment
 * window: the bin on the saved payment, «Συνέχεια» on the question, «Εκτέλεση». The row
 * must hold exactly one payment. Returns once the row shows no payment.
 */
export async function removeSavedPayment(
  page: Page,
  tenantName: string
): Promise<void> {
  const row = rentRow(page, tenantName);
  await row.getByRole('button', { name: 'Καταχώρηση πληρωμής' }).click();
  const dialog = page.locator('[role=dialog]');
  await expect(dialog).toBeVisible();
  await expect(
    page.locator('[data-cy^="deleteSavedPayment-"]'),
    `saved payments of ${tenantName}`
  ).toHaveCount(1);
  await page.locator('[data-cy="deleteSavedPayment-0"]').click();
  await page
    .locator('button')
    .filter({ hasText: /^\s*Συνέχεια\s*$/ })
    .last()
    .click();
  await expect(page.locator('[data-cy^="deleteSavedPayment-"]')).toHaveCount(0);
  const saved = page.waitForResponse(
    (r) =>
      r.url().includes('/api/v2/rents/payment/') &&
      r.request().method() === 'PATCH',
    { timeout: 60_000 }
  );
  await page
    .locator('[role=dialog]')
    .locator('button')
    .filter({ hasText: /Εκτέλεση/ })
    .first()
    .click();
  const response = await saved;
  expect(
    response.status(),
    `removing the payment of ${tenantName}: ${await response.text().catch(() => '')}`
  ).toBe(200);
  await expect(page.locator('[role=dialog]')).toBeHidden({ timeout: 30_000 });
  await expect
    .poll(async () => (await readRentRow(page, tenantName)).payment, {
      timeout: 60_000,
      message: `«Καταβολή» of ${tenantName} after the payment was taken back`
    })
    .toBe(0);
}

/** Where one tenant's share of a bill ended up, as the app reads it back from the rents. */
export interface ShareOutcome {
  tenantName: string;
  /** The month the share is for. */
  term: number;
  amount: number;
  /** `billed` on its own month, `moved` to a later one, `notCharged`, or `missing`. */
  status: string;
  /** The month whose rent holds it. */
  billedTerm: number | null;
  billedAmount: number | null;
  reason?: string;
}

/**
 * What the import window says once the bill is saved — it stays open on it until
 * «Κλείσιμο»: the sentence above the list when the bill's month is closed for every
 * tenant listed (else null), and one entry per tenant share — who, how much, where it
 * was charged and, when there is one, the line under that.
 */
export interface ImportWindowResult {
  sentence: string | null;
  shares: string[][];
}

export interface ConfirmedBill {
  _id: string;
  term: number;
  chargeRequested?: boolean;
  charged?: boolean;
  chargeError?: string;
  saveFailed?: boolean;
  chargeOutcome?: ShareOutcome[];
}

/**
 * Import one bill for a building the way the landlord does: Κτίρια → the building →
 * «Έξοδα» → «Εισαγωγή Λογαριασμού» → the file → «Συνέχεια» → switch on «Χρέωση
 * ενοικιαστών για …» → «Επιβεβαίωση Εισαγωγής» → read what the window then says about
 * each tenant's share → «Κλείσιμο». Returns what the app was told back, and what the
 * window said.
 */
export async function importBillAndChargeTenants(
  page: Page,
  realmName: string,
  buildingId: string,
  pdfPath: string,
  amountAsShown: string
): Promise<{
  bill: ConfirmedBill;
  switchLabel: string;
  windowSaid: ImportWindowResult;
}> {
  await page.goto(`el/${enc(realmName)}/buildings/${buildingId}`);
  await page.locator('[data-cy=expensesTab]').click();
  await page.locator('[data-cy=importBill]').click();
  const dialog = page.locator('[role=dialog]');
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type=file]').setInputFiles(pdfPath);

  const parsed = page.waitForResponse(
    (r) =>
      r.url().includes('/api/v2/bills/parse') &&
      r.request().method() === 'POST',
    { timeout: 110_000 }
  );
  await page.locator('[data-cy=parseBills]').click();
  expect((await parsed).status(), 'the bill is read').toBe(200);
  // The amount the app read out of the document — not one the spec typed.
  await expect(
    dialog.locator('input[inputmode="decimal"]').first(),
    'amount read from the bill'
  ).toHaveValue(amountAsShown);

  // Found by what it says, not by position: when a bill already exists for the period
  // the card shows a «replace the existing bill» switch above this one.
  const chargeLabel = dialog
    .locator('label')
    .filter({ hasText: 'Χρέωση ενοικιαστών' });
  await expect(chargeLabel, 'the «Χρέωση ενοικιαστών» switch').toHaveCount(1);
  const switchLabel = (await chargeLabel.innerText()).trim();
  const chargeSwitch = chargeLabel.locator('button[role=switch]');
  await chargeSwitch.click();
  await expect(chargeSwitch).toHaveAttribute('aria-checked', 'true');

  const confirmed = page.waitForResponse(
    (r) =>
      r.url().includes('/api/v2/bills/confirm') &&
      r.request().method() === 'POST',
    { timeout: 110_000 }
  );
  await page.locator('[data-cy=confirmBills]').click();
  const response = await confirmed;
  expect(response.status(), 'the bill is confirmed').toBe(200);
  const rows = (await response.json()) as ConfirmedBill[];
  expect(rows.length, 'one bill confirmed').toBe(1);
  await expect(
    page
      .locator('[data-sonner-toast]')
      .filter({ hasText: 'εισήχθη με επιτυχία' }),
    'the success message'
  ).toBeVisible({ timeout: 30_000 });

  // The window does not close on that message: it shows where each tenant's share
  // went, as the app read it back from the rents. Read it as the landlord does.
  const result = page.locator('[data-cy=billImportResult]');
  await expect(result, 'the result the window stays open on').toBeVisible({
    timeout: 30_000
  });
  const asRead = (text: string) =>
    text
      .split('\n')
      .map((line) => line.replace(/[\s\u00a0]+/g, ' ').trim())
      .filter(Boolean);
  const sentence = result.locator('[data-cy=importedBillCharge] p');
  const windowSaid: ImportWindowResult = {
    sentence: (await sentence.count())
      ? asRead(await sentence.first().innerText()).join(' ')
      : null,
    shares: (
      await result.locator('[data-cy=chargeOutcomeRow]').allInnerTexts()
    ).map(asRead)
  };
  await page.locator('[data-cy=closeBillImport]').click();
  await expect(dialog, '«Κλείσιμο» closes the window').toBeHidden();
  return { bill: rows[0], switchLabel, windowSaid };
}

// ── lease dates ─────────────────────────────────────────────────────────────────

/**
 * A tenant renting one apartment at `rent` per month, on a lease that runs from the
 * first day of `begin` to the last day of `end`. With `markPastPaid`, every month before
 * the current one is created already paid (the tenant-import option).
 */
export async function createDatedTenant(
  request: APIRequestContext,
  seed: LeaseSeed,
  o: {
    tenantName: string;
    propertyName: string;
    /** Eight digits; the check digit is computed. Keep to the reserved 9990000x band. */
    afmFirst8: string;
    rent: number;
    begin: MonthRef;
    end: MonthRef;
    markPastPaid: boolean;
  }
): Promise<LedgerTenant> {
  const property = await request.post(`${GATEWAY}/api/v2/properties`, {
    headers: auth(seed),
    data: {
      name: o.propertyName,
      type: 'apartment',
      price: o.rent,
      surface: 50,
      address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1', city: 'ΔΟΚΙΜΑΙ', zipCode: '00000' }
    }
  });
  expect(
    [200, 201],
    `create property ${o.propertyName}: ${await property.text().catch(() => '')}`
  ).toContain(property.status());
  const propertyId = (await property.json())._id as string;

  const tenant = await request.post(`${GATEWAY}/api/v2/tenants`, {
    headers: auth(seed),
    data: {
      name: o.tenantName,
      firstName: 'E2E',
      lastName: o.tenantName,
      taxId: makeValidGreekAFM(o.afmFirst8),
      isCompany: false,
      manager: o.tenantName,
      contacts: [
        {
          contact: o.tenantName,
          email: '',
          phone1: '6900000000',
          phone: '',
          phone2: ''
        }
      ],
      leaseId: seed.leaseId,
      beginDate: o.begin.day(1),
      endDate: o.end.lastDay,
      properties: [{ propertyId, rent: o.rent, expenses: [] }],
      markPastPaid: o.markPastPaid
    }
  });
  expect(
    [200, 201],
    `create tenant ${o.tenantName}: ${await tenant.text().catch(() => '')}`
  ).toContain(tenant.status());
  return {
    tenantId: (await tenant.json())._id as string,
    tenantName: o.tenantName,
    propertyId,
    propertyName: o.propertyName
  };
}

/**
 * Change a tenant the way the tenant form does: read it, edit the body, send the whole
 * tenant back (`PATCH /tenants/:id`). Dates travel as DD/MM/YYYY in both directions.
 */
export async function editTenant(
  request: APIRequestContext,
  seed: LeaseSeed,
  tenantId: string,
  change: (body: {
    beginDate: string;
    endDate: string;
    properties: Array<{ entryDate: string; exitDate: string }>;
  }) => void
): Promise<void> {
  const read = await request.get(`${GATEWAY}/api/v2/tenants/${tenantId}`, {
    headers: auth(seed)
  });
  expect(read.status(), `read tenant ${tenantId}`).toBe(200);
  const tenant = await read.json();
  const body = {
    ...tenant,
    properties: (tenant.properties || []).map(
      (p: {
        propertyId?: string;
        property?: { _id: string };
        rent: number;
        expenses?: unknown[];
        entryDate: string;
        exitDate: string;
      }) => ({
        propertyId: p.propertyId || p.property?._id,
        rent: p.rent,
        expenses: p.expenses || [],
        entryDate: p.entryDate,
        exitDate: p.exitDate
      })
    )
  };
  change(body);
  const saved = await request.patch(`${GATEWAY}/api/v2/tenants/${tenantId}`, {
    headers: auth(seed),
    data: body
  });
  expect(
    saved.status(),
    `save tenant ${tenantId}: ${await saved.text().catch(() => '')}`
  ).toBe(200);
}
