import { Collections, logger, Service } from '@microrealestate/common';
import type { ConnectionRole } from '@microrealestate/types';
import {
  type NoticeDeps,
  type NoticeInput,
  pushNotice
} from './noticeHelpers.js';
import moment from 'moment';
import { toRentData } from '../managers/frontdata.js';

// Daily notice scans — the conditions the landlord asked to be PUSHED (bell +
// Telegram) instead of discovered by opening the right page on the right day.
// Runs inside leaseExpiryScanner's once-per-UTC-day cron body; each check is
// independently try/caught by runNoticeScans so one failure cannot silence the
// rest. Idempotence is the dedupeKey (unique per realm), NOT per-doc debounce
// fields — see noticeHelpers.createNotice.
//
// REALM SCOPING: like the lease/cert scanners these run ACROSS all realms in
// one pass and derive the realm from each document's own `realmId` — that is
// the established cron shape here (the cron has no request context and so no
// single realm). Every notice is therefore scoped by the realmId of the doc
// that triggered it; a notice can never leak into another realm's bell. Two
// consequences to respect when editing:
//   1. Never hoist a push OUT of a per-document loop — the per-realm grouping
//      (checkUnpaidRentsMonthly) is what preserves isolation for aggregates.
//   2. These scans read the whole (date-bounded) candidate set rather than a
//      realm-prefixed index range. Fine at this deployment's scale (single
//      landlord, two realms); if realm count grows, iterate realms and add
//      `realmId` to the filters so the {realmId: 1} index is used.

// Bill dueDate windows: days-until (negative = days overdue). 7/1 ahead of the
// deadline, 0 on the day, -3 as the single overdue escalation.
export const BILL_DUE_WINDOWS: number[] = [7, 1, 0, -3];

// Days PAST the effective lease end (terminationDate || endDate) at which an
// unreturned deposit warns. Longer than a payment cycle on purpose — returning
// the εγγύηση legitimately takes a couple of weeks of final metering.
export const DEPOSIT_WINDOWS: number[] = [14, 30];

// Days PAST endDate at which an expired-but-undecided lease (no termination,
// no extension) warns. The pre-expiry scanner stops looking the day the lease
// expires (buildExpiringFilter is forward-only); these are its complement.
export const HOLDOVER_WINDOWS: number[] = [7, 30];

// Warn when a pending bill in the bell is this old — 5 days before the
// 30-day TTL index deletes it (inboxitem.ts D11).
export const INBOX_TTL_WARN_AGE_DAYS = 25;

// Same Greek provider labels the bell + import dialog render.
const PROVIDER_LABEL: Record<string, string> = {
  deh: 'ΔΕΗ',
  eydap: 'ΕΥΔΑΠ',
  epa: 'ΕΠΑ'
};

// GENITIVE Greek months — «Απλήρωτα ενοίκια Ιουλίου 2026». The noun phrase
// governs the genitive; the nominative would read «Απλήρωτα ενοίκια Ιούλιος
// 2026», which is broken Greek. This is a known trap in this codebase with a
// documented helper (webapps/landlord/src/utils/greekMonths.js) and two prior
// fixes (MonthFigures.js EL_GENITIVE_MONTHS, pdfgenerator templatefunctions) —
// moment's `el` locale returns the nominative from format('MMMM') and the
// genitive only when a day-of-month token is present, and the bug is invisible
// to anyone reviewing the English screen. The api service has no access to the
// landlord util, hence this local copy.
const GREEK_MONTHS_GENITIVE = [
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

export interface NoticeScanDeps extends NoticeDeps {
  emailerUrl?: string;
  mintToken?: (role: ConnectionRole, realmId: string) => Promise<string>;
  // Injectable finders so the test suite drives every scan without mongo.
  findBills?: (filter: Record<string, any>) => Promise<any[]>;
  findBuildings?: (filter: Record<string, any>) => Promise<any[]>;
  findTenants?: (filter: Record<string, any>) => Promise<any[]>;
  findInboxItems?: (filter: Record<string, any>) => Promise<any[]>;
  pushNotice?: (
    input: NoticeInput,
    emailerUrl: string,
    mintToken: (role: ConnectionRole, realmId: string) => Promise<string>,
    deps: NoticeDeps
  ) => Promise<{ created: boolean; telegramDelivered: boolean }>;
}

interface ScanCounts {
  scanned: number;
  created: number;
  errors: number;
}

function _resolveDeps(deps: NoticeScanDeps) {
  return {
    emailerUrl:
      deps.emailerUrl ||
      (Service.getInstance().envConfig.getValues().EMAILER_URL as string),
    mintToken:
      deps.mintToken ||
      ((role: ConnectionRole, realmId: string) =>
        Service.getInstance().createServiceToken(role, realmId)),
    push: deps.pushNotice || pushNotice,
    now: deps.now ? deps.now() : new Date()
  };
}

function _daysUntil(now: Date, target: Date): number {
  return moment
    .utc(target)
    .startOf('day')
    .diff(moment.utc(now).startOf('day'), 'days');
}

function _round(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function _eur(amount: number): string {
  // Backstop: a non-finite amount used to render the literal string
  // "NaN,undefined €" into a notice (NaN.toFixed(2) is "NaN", which has no
  // "." to split on). Callers are expected to skip non-finite rows; this
  // makes an escapee obviously wrong rather than plausibly wrong.
  if (!Number.isFinite(amount)) return '—';
  // 1.234,56 € — the app-wide Greek money format, without pulling Intl
  // locale data into the cron path.
  const fixed = (Math.round(amount * 100) / 100).toFixed(2);
  const [int, dec] = fixed.split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec} €`;
}

/**
 * (a) Bills approaching or past their dueDate and not fully paid.
 * outstanding = totalAmount − Σ(receipts) — the same computation the
 * dashboard's pendingBills block uses (dashboardmanager._fetchPendingBills),
 * so the bell and the dashboard can never disagree about what is owed.
 *
 * dedupeKey is `bill-due:{billId}:{window}`. The window derives from dueDate,
 * which the corrective re-import path DOES mutate (billmanager `$set: {dueDate}`
 * on replace). That is deliberate here rather than a violation of the
 * source-derived-key rule: the window is not an identity field but the ALERT
 * TIER. If a landlord corrects an OCR-misread deadline from +7d to +1d, "due in
 * 1 day" is genuinely new information the landlord must see, not a duplicate of
 * the earlier "due in 7 days". Re-firing is the correct behaviour; what the key
 * must prevent — and does — is the SAME tier firing twice for the same bill.
 */
export async function checkBillsDue(
  deps: NoticeScanDeps = {}
): Promise<ScanCounts> {
  const { emailerUrl, mintToken, push, now } = _resolveDeps(deps);
  const counts: ScanCounts = { scanned: 0, created: 0, errors: 0 };

  const horizon = Math.max(...BILL_DUE_WINDOWS);
  const oldest = Math.min(...BILL_DUE_WINDOWS);
  const findBills =
    deps.findBills ||
    (async (f: Record<string, any>) => Collections.Bill.find(f).lean());
  // Coarse pre-filter (superset): dueDate within [now+oldest, now+horizon].
  // The authoritative match is the exact-window check per bill below.
  const bills = await findBills({
    status: { $ne: 'paid' },
    dueDate: {
      $gte: moment.utc(now).add(oldest, 'days').startOf('day').toDate(),
      $lte: moment.utc(now).add(horizon, 'days').endOf('day').toDate()
    }
  });
  counts.scanned = bills.length;
  if (!bills.length) return counts;

  const findBuildings =
    deps.findBuildings ||
    (async (f: Record<string, any>) =>
      Collections.Building.find(f, { name: 1, expenses: 1 }).lean());
  const buildingIds = [...new Set(bills.map((b: any) => String(b.buildingId)))];
  const buildings = await findBuildings({ _id: { $in: buildingIds } });
  const buildingName = new Map(
    buildings.map((b: any) => [String(b._id), b.name])
  );

  for (const bill of bills) {
    try {
      if (!bill.dueDate) continue;
      const days = _daysUntil(now, new Date(bill.dueDate));
      if (!BILL_DUE_WINDOWS.includes(days)) continue;
      const paidSoFar = Array.isArray(bill.receipts)
        ? bill.receipts.reduce(
            (s: number, r: any) => s + (Number(r.amount) || 0),
            0
          )
        : 0;
      const outstanding =
        Math.round(Math.max(0, (bill.totalAmount || 0) - paidSoFar) * 100) /
        100;
      if (outstanding <= 0) continue;
      const label = PROVIDER_LABEL[bill.provider] || bill.billingId || '';
      // Only parenthesise a name we actually have — a deleted building (or one
      // absent from the lookup) otherwise rendered a bare «… 200,00 € ()».
      const bName = buildingName.get(String(bill.buildingId)) || '';
      const where = bName ? ` (${bName})` : '';
      const message =
        days >= 0
          ? `💶 Λογαριασμός ${label} λήγει ${days === 0 ? 'σήμερα' : `σε ${days} ημέρ${days === 1 ? 'α' : 'ες'}`}: ${_eur(outstanding)}${where}`
          : `🔴 Λογαριασμός ${label} έληξε πριν ${-days} ημέρες — εκκρεμεί ${_eur(outstanding)}${where}`;
      const r = await push(
        {
          realmId: String(bill.realmId),
          code: 'bill-due',
          message,
          link: `/buildings/${bill.buildingId}`,
          dedupeKey: `bill-due:${bill._id}:${days}`
        },
        emailerUrl,
        mintToken,
        deps
      );
      if (r.created) counts.created++;
    } catch (err: any) {
      counts.errors++;
      logger.error(`checkBillsDue: bill ${bill?._id}: ${err?.message || err}`);
    }
  }
  return counts;
}

/**
 * (b) One summary notice per realm on the LAST UTC day of the month listing
 * the current term's unpaid/partially-paid rents (user decision: monthly
 * digest, not per-tenant pings). Classification is `rent.status` from
 * frontdata.toRentData — the single source of truth the row UI and the
 * overview KPI share (frontend-patterns.md: a parallel classifier WILL
 * drift; raw paid<due misses retroactive carry-forward settlement, which is
 * why toRentData gets the FULL ledger here).
 */
export async function checkUnpaidRentsMonthly(
  deps: NoticeScanDeps = {}
): Promise<ScanCounts> {
  const { emailerUrl, mintToken, push, now } = _resolveDeps(deps);
  const counts: ScanCounts = { scanned: 0, created: 0, errors: 0 };

  const utcNow = moment.utc(now);
  // Fire only on the month's last UTC day — the digest describes the month
  // as it closes.
  if (!utcNow.isSame(moment.utc(now).endOf('month'), 'day')) {
    return counts;
  }

  const term = Number(utcNow.format('YYYYMM') + '0100');
  const findTenants =
    deps.findTenants ||
    (async (f: Record<string, any>) =>
      // Full rents[] — toRentData's carry-forward promotion needs the whole
      // ledger, not an $elemMatch slice.
      Collections.Tenant.find(f, {
        name: 1,
        realmId: 1,
        rents: 1
      }).lean());
  const tenants = await findTenants({
    archived: { $ne: true },
    'rents.term': term
  });
  counts.scanned = tenants.length;

  // Group unpaid rows per realm.
  const perRealm = new Map<string, { name: string; due: number }[]>();
  for (const tenant of tenants) {
    const rent = (tenant.rents || []).find((r: any) => r.term === term);
    if (!rent) continue;
    const rentData = toRentData(rent, undefined, undefined, tenant.rents);
    if (rentData.status === 'paid') continue;
    // Remaining for the digest line: this month's ask minus what arrived —
    // the same newBalance the row renders (negative = still owed).
    //
    // COERCE AND REJECT non-finite first. toRentData computes newBalance as
    // `total.payment - total.grandTotal` with no coercion (frontdata.ts:126),
    // so a legacy row carrying `total` but no `payment` yields NaN — and
    // `Math.max(0, -NaN)` is NaN, which passes a `<= 0` guard and rendered
    // "NaN,undefined €" into the digest. `??` does not catch NaN.
    const balance = Number(rentData.newBalance);
    if (!Number.isFinite(balance)) {
      logger.warn(
        `unpaid-rents digest: tenant ${tenant._id} term ${term} has a non-finite balance — excluded from the digest`
      );
      continue;
    }
    const remaining = Math.round(Math.max(0, -balance) * 100) / 100;
    if (remaining <= 0) continue;
    const realmId = String(tenant.realmId);
    if (!perRealm.has(realmId)) perRealm.set(realmId, []);
    perRealm.get(realmId)!.push({ name: tenant.name, due: remaining });
  }

  for (const [realmId, rows] of perRealm) {
    try {
      rows.sort((a, b) => b.due - a.due);
      const shown = rows.slice(0, 10);
      const more = rows.length - shown.length;
      const monthName = GREEK_MONTHS_GENITIVE[utcNow.month()];
      const list = shown.map((r) => `${r.name} (${_eur(r.due)})`).join(', ');
      const message = `⏱ Απλήρωτα ενοίκια ${monthName} ${utcNow.year()}: ${rows.length} — ${list}${more > 0 ? ` … και άλλοι ${more}` : ''}`;
      const r = await push(
        {
          realmId,
          code: 'unpaid-rents',
          message,
          // Zero-padded month — the rents page 404s strict-parses YYYY.MM.
          link: `/rents/${utcNow.format('YYYY.MM')}`,
          dedupeKey: `unpaid-rents:${realmId}:${term}`
        },
        emailerUrl,
        mintToken,
        deps
      );
      if (r.created) counts.created++;
    } catch (err: any) {
      counts.errors++;
      logger.error(
        `checkUnpaidRentsMonthly: realm ${realmId}: ${err?.message || err}`
      );
    }
  }
  return counts;
}

/**
 * (c) Deposits (εγγύηση) still held N days after the lease effectively ended.
 * effectiveEnd = terminationDate || endDate — terminationDate wins because an
 * early termination moves the return obligation, not the original endDate.
 */
export async function checkDepositsUnreturned(
  deps: NoticeScanDeps = {}
): Promise<ScanCounts> {
  const { emailerUrl, mintToken, push, now } = _resolveDeps(deps);
  const counts: ScanCounts = { scanned: 0, created: 0, errors: 0 };

  const maxWindow = Math.max(...DEPOSIT_WINDOWS);
  const findTenants =
    deps.findTenants ||
    (async (f: Record<string, any>) =>
      Collections.Tenant.find(f, {
        name: 1,
        realmId: 1,
        guaranty: 1,
        guarantyPayback: 1,
        endDate: 1,
        terminationDate: 1
      }).lean());
  // Coarse pre-filter: ended within the scan range (superset — exact window
  // match below is authoritative). $or over the two end fields.
  const rangeStart = moment
    .utc(now)
    .subtract(maxWindow + 1, 'days')
    .startOf('day')
    .toDate();
  const tenants = await findTenants({
    archived: { $ne: true },
    guaranty: { $gt: 0 },
    $or: [
      { terminationDate: { $gte: rangeStart, $lte: now } },
      {
        terminationDate: null,
        endDate: { $gte: rangeStart, $lte: now }
      },
      {
        terminationDate: { $exists: false },
        endDate: { $gte: rangeStart, $lte: now }
      }
    ]
  });
  counts.scanned = tenants.length;

  for (const tenant of tenants) {
    try {
      const effectiveEnd = tenant.terminationDate || tenant.endDate;
      if (!effectiveEnd) continue;
      const held =
        Math.round(
          ((Number(tenant.guaranty) || 0) -
            (Number(tenant.guarantyPayback) || 0)) *
            100
        ) / 100;
      if (held <= 0) continue;
      const daysPast = -_daysUntil(now, new Date(effectiveEnd));
      if (!DEPOSIT_WINDOWS.includes(daysPast)) continue;
      const message = `💰 Εγγύηση δεν έχει επιστραφεί: ${tenant.name} — ${_eur(held)}, μίσθωση έληξε ${moment.utc(effectiveEnd).format('DD/MM/YYYY')}`;
      const r = await push(
        {
          realmId: String(tenant.realmId),
          code: 'deposit-unreturned',
          message,
          link: `/tenants/${tenant._id}`,
          dedupeKey: `deposit:${tenant._id}:${moment.utc(effectiveEnd).format('YYYYMMDD')}:${daysPast}`
        },
        emailerUrl,
        mintToken,
        deps
      );
      if (r.created) counts.created++;
    } catch (err: any) {
      counts.errors++;
      logger.error(
        `checkDepositsUnreturned: tenant ${tenant?._id}: ${err?.message || err}`
      );
    }
  }
  return counts;
}

/**
 * (d) Holdover: a lease whose endDate passed with NO decision — neither
 * terminated nor extended. An extension moves endDate forward, clearing the
 * condition naturally; a termination sets terminationDate, excluded below.
 */
export async function checkHoldoverLeases(
  deps: NoticeScanDeps = {}
): Promise<ScanCounts> {
  const { emailerUrl, mintToken, push, now } = _resolveDeps(deps);
  const counts: ScanCounts = { scanned: 0, created: 0, errors: 0 };

  const maxWindow = Math.max(...HOLDOVER_WINDOWS);
  const findTenants =
    deps.findTenants ||
    (async (f: Record<string, any>) =>
      Collections.Tenant.find(f, {
        name: 1,
        realmId: 1,
        endDate: 1
      }).lean());
  const tenants = await findTenants({
    archived: { $ne: true },
    $and: [
      {
        $or: [
          { terminationDate: { $exists: false } },
          { terminationDate: null }
        ]
      },
      {
        endDate: {
          $gte: moment
            .utc(now)
            .subtract(maxWindow + 1, 'days')
            .startOf('day')
            .toDate(),
          $lt: moment.utc(now).startOf('day').toDate()
        }
      }
    ]
  });
  counts.scanned = tenants.length;

  for (const tenant of tenants) {
    try {
      if (!tenant.endDate) continue;
      const daysPast = -_daysUntil(now, new Date(tenant.endDate));
      if (!HOLDOVER_WINDOWS.includes(daysPast)) continue;
      const message = `⚠️ Μίσθωση έληξε πριν ${daysPast} ημέρες χωρίς ενέργεια (λήξη ή παράταση): ${tenant.name}`;
      const r = await push(
        {
          realmId: String(tenant.realmId),
          code: 'holdover-lease',
          message,
          link: `/tenants/${tenant._id}`,
          dedupeKey: `holdover:${tenant._id}:${moment.utc(tenant.endDate).format('YYYYMMDD')}:${daysPast}`
        },
        emailerUrl,
        mintToken,
        deps
      );
      if (r.created) counts.created++;
    } catch (err: any) {
      counts.errors++;
      logger.error(
        `checkHoldoverLeases: tenant ${tenant?._id}: ${err?.message || err}`
      );
    }
  }
  return counts;
}

/**
 * (e) A pending BILL in the bell is ~5 days from the 30-day TTL delete
 * (inboxitem.ts D11) — after that the photo/parse is gone silently. Must
 * never match kind:'notice' (it would warn about warnings, recursively).
 */
export async function checkInboxTtl(
  deps: NoticeScanDeps = {}
): Promise<ScanCounts> {
  const { emailerUrl, mintToken, push, now } = _resolveDeps(deps);
  const counts: ScanCounts = { scanned: 0, created: 0, errors: 0 };

  const findInboxItems =
    deps.findInboxItems ||
    (async (f: Record<string, any>) => Collections.InboxItem.find(f).lean());
  const items = await findInboxItems({
    status: 'pending',
    // Legacy docs predate `kind` — missing means bill.
    $or: [{ kind: 'bill' }, { kind: { $exists: false } }],
    createdDate: {
      $lte: moment.utc(now).subtract(INBOX_TTL_WARN_AGE_DAYS, 'days').toDate()
    }
  });
  counts.scanned = items.length;

  for (const item of items) {
    try {
      const message = `🗑 Λογαριασμός στο κουδούνι θα διαγραφεί αυτόματα σε ~${30 - INBOX_TTL_WARN_AGE_DAYS} ημέρες (εκκρεμεί από ${moment.utc(item.createdDate).format('DD/MM')})`;
      const r = await push(
        {
          realmId: String(item.realmId),
          code: 'inbox-ttl',
          message,
          link: '',
          dedupeKey: `inbox-ttl:${item._id}`
        },
        emailerUrl,
        mintToken,
        deps
      );
      if (r.created) counts.created++;
    } catch (err: any) {
      counts.errors++;
      logger.error(`checkInboxTtl: item ${item?._id}: ${err?.message || err}`);
    }
  }
  return counts;
}

/**
 * (f) RESOLVE pass — dismiss pending notices whose condition no longer holds.
 *
 * Without this every notice is immortal until the 30-day TTL, because the only
 * other `status:'dismissed'` write in the API is the user-driven route. And
 * since each condition fires at SEVERAL windows (a bill at 7/1/0/-3 days), one
 * unpaid bill accumulates one pending item per window: paying it on day 2 left
 * the day-1 and day-0 notices still claiming money was owed, and the bell badge
 * counted them. The badge measured "notices ever generated" instead of "things
 * needing attention".
 *
 * Re-checks the underlying entity per pending notice rather than trusting the
 * scan filters (checkBillsDue excludes paid bills, so a resolved bill is
 * invisible to it by construction — the resolve pass must query independently).
 *
 * Runs per realm. `unit-vacant`, `unpaid-rents` and `inbox-ttl` are NOT resolved
 * here: the first two are point-in-time digests (nothing to re-check), and an
 * inbox-ttl notice's subject is the TTL itself.
 */
export async function resolveResolvedConditions(
  deps: NoticeScanDeps = {}
): Promise<{ resolved: number; errors: number }> {
  // Deliberately NOT _resolveDeps: this pass sends nothing, so it needs neither
  // an emailer URL nor a token minter. Calling _resolveDeps made it reach into
  // Service.getInstance(), which throws outside a bootstrapped service (and
  // took the whole pass down in jest).
  const now = deps.now ? deps.now() : new Date();
  const out = { resolved: 0, errors: 0 };
  const findNotices =
    deps.findInboxItems ||
    (async (f: Record<string, any>) => Collections.InboxItem.find(f).lean());

  let pending: any[] = [];
  try {
    pending = await findNotices({
      kind: 'notice',
      status: 'pending',
      'notice.code': {
        $in: [
          'bill-due',
          'deposit-unreturned',
          'holdover-lease',
          'lease-expiry'
        ]
      }
    });
  } catch (err: any) {
    logger.error(
      `resolveResolvedConditions: query failed: ${err?.message || err}`
    );
    return { resolved: 0, errors: 1 };
  }
  if (!pending.length) return out;

  // dedupeKey shapes: 'bill-due:{billId}:{window}',
  // 'deposit:{tenantId}:{YYYYMMDD}:{window}',
  // 'holdover:{tenantId}:{YYYYMMDD}:{window}',
  // 'lease-expiry:{tenantId}:{YYYYMMDD}:{window}'.
  const idOf = (key: string) => String(key || '').split(':')[1] || '';
  const billIds = new Set<string>();
  const tenantIds = new Set<string>();
  for (const n of pending) {
    const code = n.notice?.code;
    const id = idOf(n.dedupeKey);
    if (!id) continue;
    if (code === 'bill-due') billIds.add(id);
    else tenantIds.add(id);
  }

  const stale: any[] = [];
  try {
    // A bill resolves when it is fully paid (or gone).
    if (billIds.size) {
      const findBills =
        deps.findBills ||
        (async (f: Record<string, any>) => Collections.Bill.find(f).lean());
      const bills = await findBills({ _id: { $in: [...billIds] } });
      const byId = new Map(bills.map((b: any) => [String(b._id), b]));
      for (const n of pending) {
        if (n.notice?.code !== 'bill-due') continue;
        const b = byId.get(idOf(n.dedupeKey));
        const paidSoFar = Array.isArray(b?.receipts)
          ? b.receipts.reduce(
              (s: number, r: any) => s + (Number(r.amount) || 0),
              0
            )
          : 0;
        const outstanding = _round(
          Math.max(0, (Number(b?.totalAmount) || 0) - paidSoFar)
        );
        // Bill deleted, marked paid, or fully receipted → nothing owed.
        if (!b || b.status === 'paid' || outstanding <= 0) stale.push(n);
      }
    }
    // A tenant-scoped notice resolves per its own code.
    if (tenantIds.size) {
      const findTenants =
        deps.findTenants ||
        (async (f: Record<string, any>) =>
          Collections.Tenant.find(f, {
            guaranty: 1,
            guarantyPayback: 1,
            endDate: 1,
            terminationDate: 1,
            archived: 1
          }).lean());
      const tenants = await findTenants({ _id: { $in: [...tenantIds] } });
      const byId = new Map(tenants.map((t: any) => [String(t._id), t]));
      for (const n of pending) {
        const code = n.notice?.code;
        if (code === 'bill-due') continue;
        const t = byId.get(idOf(n.dedupeKey));
        if (!t) {
          stale.push(n);
          continue;
        }
        if (code === 'deposit-unreturned') {
          const held = _round(
            (Number(t.guaranty) || 0) - (Number(t.guarantyPayback) || 0)
          );
          if (held <= 0 || t.archived === true) stale.push(n);
        } else if (code === 'holdover-lease') {
          // Decided: terminated, extended past today, or archived.
          const decided =
            !!t.terminationDate ||
            t.archived === true ||
            (t.endDate &&
              moment.utc(t.endDate).isSameOrAfter(moment.utc(now), 'day'));
          if (decided) stale.push(n);
        } else if (code === 'lease-expiry') {
          // Resolved once the lease is terminated/archived or moved forward
          // beyond the widest pre-expiry window.
          const moved =
            t.endDate &&
            moment.utc(t.endDate).diff(moment.utc(now).startOf('day'), 'days') >
              30;
          if (!!t.terminationDate || t.archived === true || moved)
            stale.push(n);
        }
      }
    }
  } catch (err: any) {
    out.errors++;
    logger.error(
      `resolveResolvedConditions: entity re-check failed: ${err?.message || err}`
    );
  }

  if (!stale.length) return out;
  // Group by realm so the update is realm-scoped like every other write here.
  const byRealm = new Map<string, any[]>();
  for (const n of stale) {
    const r = String(n.realmId);
    if (!byRealm.has(r)) byRealm.set(r, []);
    byRealm.get(r)!.push(n._id);
  }
  const resolve =
    deps.resolveNotices ||
    (async (ids: any[]) =>
      Collections.InboxItem.updateMany(
        { _id: { $in: ids } },
        {
          // $unset the dedupeKey as well as flipping status.
          //
          // A dismissed notice KEEPS its key (that is deliberate for a
          // USER-dismissed one: "I've seen it, stop telling me"). But an
          // AUTO-resolved one is different — the condition genuinely ended, and
          // if it comes BACK the landlord must hear about it again. A bill's
          // receipt can be reversed by a corrective re-import; a guaranty can be
          // re-flagged. With the key retained, createNotice would hit E11000,
          // report {created:false}, and the money would be silently invisible —
          // the absent-representation trap from MONEY_SURFACE_MATRIX.md.
          //
          // Safe against the unique index: partialFilterExpression only indexes
          // docs whose dedupeKey is a string, so unset rows leave the index
          // entirely and any number of them can coexist (verified against the
          // live mongo 4.4). `resolvedKey` preserves the audit trail.
          $set: {
            status: 'dismissed',
            updatedDate: now,
            autoResolved: true
          },
          $rename: { dedupeKey: 'resolvedKey' }
        }
      ));
  for (const [realmId, ids] of byRealm) {
    try {
      await resolve(ids);
      out.resolved += ids.length;
      logger.info(
        `notice-resolve: dismissed ${ids.length} stale notice(s) in realm ${realmId}`
      );
    } catch (err: any) {
      out.errors++;
      logger.error(`notice-resolve: realm ${realmId}: ${err?.message || err}`);
    }
  }
  return out;
}

export interface NoticeScanResults {
  billsDue: ScanCounts;
  unpaidRents: ScanCounts;
  deposits: ScanCounts;
  holdover: ScanCounts;
  inboxTtl: ScanCounts;
  resolved: { resolved: number; errors: number };
}

/**
 * Run every notice scan; each in its own try/catch so one failing scan can't
 * silence the rest. Called from leaseExpiryScanner.runOncePerUtcDay — the
 * single daily cron slot; no second timer exists.
 */
export async function runNoticeScans(
  deps: NoticeScanDeps = {}
): Promise<NoticeScanResults> {
  // Pre-seeded with errors:1 so a scan that THROWS is reported as failed
  // rather than as a clean zero — a silent 0/0/0 is indistinguishable from
  // "nothing to notify", which is exactly the absent-representation trap.
  // Each successful scan overwrites its slot with real counts.
  const failedUntilProvenOtherwise = (): ScanCounts => ({
    scanned: 0,
    created: 0,
    errors: 1
  });
  const results: NoticeScanResults = {
    billsDue: failedUntilProvenOtherwise(),
    unpaidRents: failedUntilProvenOtherwise(),
    deposits: failedUntilProvenOtherwise(),
    holdover: failedUntilProvenOtherwise(),
    inboxTtl: failedUntilProvenOtherwise(),
    resolved: { resolved: 0, errors: 1 }
  };
  try {
    results.billsDue = await checkBillsDue(deps);
  } catch (err: any) {
    logger.error(`notice-scan billsDue failed: ${err?.message || err}`);
  }
  try {
    results.unpaidRents = await checkUnpaidRentsMonthly(deps);
  } catch (err: any) {
    logger.error(`notice-scan unpaidRents failed: ${err?.message || err}`);
  }
  try {
    results.deposits = await checkDepositsUnreturned(deps);
  } catch (err: any) {
    logger.error(`notice-scan deposits failed: ${err?.message || err}`);
  }
  try {
    results.holdover = await checkHoldoverLeases(deps);
  } catch (err: any) {
    logger.error(`notice-scan holdover failed: ${err?.message || err}`);
  }
  try {
    results.inboxTtl = await checkInboxTtl(deps);
  } catch (err: any) {
    logger.error(`notice-scan inboxTtl failed: ${err?.message || err}`);
  }
  // Resolve LAST: the scans above may have just created this run's notices, and
  // the resolve pass must judge against current entity state, not stale state.
  try {
    results.resolved = await resolveResolvedConditions(deps);
  } catch (err: any) {
    logger.error(`notice-resolve failed: ${err?.message || err}`);
  }
  const counts = Object.entries(results)
    .filter(([k]) => k !== 'resolved')
    .map(
      ([k, v]: [string, any]) => `${k}=${v.scanned}/${v.created}/${v.errors}`
    )
    .join(' ');
  logger.info(
    `notice-scans: ${counts} (scanned/created/errors) resolved=${results.resolved.resolved}`
  );
  return results;
}
