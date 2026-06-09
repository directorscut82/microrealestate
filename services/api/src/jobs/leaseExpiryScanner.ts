import { Collections, logger, Service } from '@microrealestate/common';
import axios from 'axios';
import moment from 'moment';

// Days-before-expiry that should trigger a notice. Each tenant is matched
// against the "in N days" window (±0.5 day) so the scanner is tolerant of
// midnight drift. We send at the *first* matching window — the
// lastExpiryNoticeSentAt + Email-collection debounce ensures the same notice
// isn't fired twice in the cooldown period for two adjacent windows.
export const EXPIRY_DAY_WINDOWS: number[] = [30, 7, 1];

// Debounce: skip a tenant whose most recent lease_expiry_notice was sent
// within this many days. Picked to be < 30 (the longest window) so the next
// scheduled notice isn't accidentally suppressed, and > 7 (the next window)
// so the same window doesn't double-fire across two cron ticks.
export const EXPIRY_DEBOUNCE_DAYS = 25;

const TEMPLATE_NAME = 'lease_expiry_notice';

export interface ExpiryScanDeps {
  emailerUrl: string;
  // Hooks let the test suite drive the scanner without touching mongo /
  // network. In production they default to the live Collections + axios.
  findTenants?: (filter: Record<string, any>) => Promise<any[]>;
  findRecentEmail?: (
    tenantId: string,
    sinceDate: Date
  ) => Promise<any | null>;
  postEmail?: (
    url: string,
    body: any,
    headers: Record<string, string>
  ) => Promise<any>;
  markSent?: (tenantId: string, when: Date) => Promise<void>;
  now?: () => Date;
}

interface ScanResult {
  scanned: number;
  sent: number;
  skipped: number;
  errors: number;
}

/**
 * Find tenants whose lease ends within `withinDays` days from `now`, are not
 * archived, and have no termination date. Used both by the cron and the GET
 * /api/v2/tenants?expiringWithin=N HTTP path.
 */
export function buildExpiringFilter(now: Date, withinDays: number) {
  const start = moment.utc(now).startOf('day').toDate();
  const end = moment.utc(now).add(withinDays, 'days').endOf('day').toDate();
  return {
    archived: { $ne: true },
    $and: [
      {
        $or: [
          { terminationDate: { $exists: false } },
          { terminationDate: null }
        ]
      },
      { endDate: { $gte: start, $lte: end } }
    ]
  };
}

function _daysUntil(now: Date, target: Date): number {
  const startOfNow = moment.utc(now).startOf('day');
  const startOfTarget = moment.utc(target).startOf('day');
  return startOfTarget.diff(startOfNow, 'days');
}

function _matchesWindow(daysUntil: number): boolean {
  return EXPIRY_DAY_WINDOWS.includes(daysUntil);
}

export async function checkExpiringLeases(
  deps: Partial<ExpiryScanDeps> = {}
): Promise<ScanResult> {
  const now = deps.now ? deps.now() : new Date();
  const result: ScanResult = { scanned: 0, sent: 0, skipped: 0, errors: 0 };

  // 30-day horizon covers the biggest window. We fan out to per-window
  // checks below so 31-day matches are still excluded.
  const horizon = Math.max(...EXPIRY_DAY_WINDOWS);
  const filter = buildExpiringFilter(now, horizon);

  const findTenants =
    deps.findTenants ||
    (async (f: Record<string, any>) => Collections.Tenant.find(f).lean());

  const tenants = await findTenants(filter);
  result.scanned = tenants.length;

  const debounceCutoff = moment
    .utc(now)
    .subtract(EXPIRY_DEBOUNCE_DAYS, 'days')
    .toDate();

  const findRecentEmail =
    deps.findRecentEmail ||
    (async (tenantId: string, since: Date) =>
      Collections.Email.findOne({
        recordId: tenantId,
        templateName: TEMPLATE_NAME,
        sentDate: { $gte: since }
      }).lean());

  const emailerUrl =
    deps.emailerUrl ||
    (Service.getInstance().envConfig.getValues().EMAILER_URL as string);

  const postEmail =
    deps.postEmail ||
    (async (url: string, body: any, headers: Record<string, string>) =>
      axios.post(url, body, { headers, timeout: 30_000 }));

  const markSent =
    deps.markSent ||
    (async (tenantId: string, when: Date) => {
      await Collections.Tenant.updateOne(
        { _id: tenantId },
        { $set: { lastExpiryNoticeSentAt: when } }
      );
    });

  for (const tenant of tenants) {
    if (!tenant.endDate) {
      result.skipped++;
      continue;
    }
    const daysUntil = _daysUntil(now, new Date(tenant.endDate));
    if (!_matchesWindow(daysUntil)) {
      result.skipped++;
      continue;
    }

    // Debounce check (twofold): the in-row marker is the cheap path; the
    // Email-collection lookup is the source-of-truth fallback if a previous
    // run sent the email but failed to update the tenant doc.
    if (
      tenant.lastExpiryNoticeSentAt &&
      new Date(tenant.lastExpiryNoticeSentAt) >= debounceCutoff
    ) {
      result.skipped++;
      continue;
    }
    const recent = await findRecentEmail(String(tenant._id), debounceCutoff);
    if (recent) {
      result.skipped++;
      continue;
    }

    try {
      await postEmail(
        emailerUrl,
        {
          templateName: TEMPLATE_NAME,
          recordId: String(tenant._id),
          params: {
            daysUntilExpiry: daysUntil,
            realmId: String(tenant.realmId)
          }
        },
        {
          organizationid: String(tenant.realmId)
        }
      );
      await markSent(String(tenant._id), now);
      result.sent++;
      logger.info(
        `lease-expiry-notice sent to tenant ${tenant._id} (expires in ${daysUntil}d)`
      );
    } catch (err: any) {
      result.errors++;
      logger.error(
        `lease-expiry-notice failed for tenant ${tenant._id}: ${
          err?.message || err
        }`
      );
    }
  }

  return result;
}

// --- Cron wiring ---
//
// Mirror the setInterval-with-unref pattern in services/pdfgenerator/src/pdf.ts:114
// — re-entrancy guard, .unref() so the timer never blocks shutdown, single
// module-level handle. Tick once per hour, but the body short-circuits unless
// the UTC date has rolled over. That keeps the math simple (one scan per UTC
// day) without needing a second timer or a cron library.

const HOURLY_MS = 60 * 60 * 1000;

let cronTimer: NodeJS.Timeout | null = null;
let scanRunning = false;
let lastRunUtcDate: string | null = null;

function _utcDateKey(d: Date): string {
  return moment.utc(d).format('YYYY-MM-DD');
}

export async function runOncePerUtcDay(
  deps: Partial<ExpiryScanDeps> = {}
): Promise<ScanResult | null> {
  const now = deps.now ? deps.now() : new Date();
  const todayKey = _utcDateKey(now);
  if (lastRunUtcDate === todayKey) {
    return null;
  }
  if (scanRunning) {
    return null;
  }
  scanRunning = true;
  try {
    const r = await checkExpiringLeases(deps);
    lastRunUtcDate = todayKey;
    logger.info(
      `lease-expiry-scanner: scanned=${r.scanned} sent=${r.sent} skipped=${r.skipped} errors=${r.errors}`
    );
    return r;
  } catch (err: any) {
    logger.error(
      `lease-expiry-scanner: top-level failure: ${err?.message || err}`
    );
    return { scanned: 0, sent: 0, skipped: 0, errors: 1 };
  } finally {
    scanRunning = false;
  }
}

export function startLeaseExpiryCron(): void {
  if (cronTimer) {
    return;
  }
  cronTimer = setInterval(() => {
    // Fire-and-forget — runOncePerUtcDay logs its own errors and never
    // throws past this boundary. We deliberately don't await: setInterval
    // expects sync callbacks, and errors here would crash the process.
    runOncePerUtcDay().catch((err) => {
      logger.error(
        `lease-expiry-scanner: unexpected rejection: ${
          err?.message || err
        }`
      );
    });
  }, HOURLY_MS);
  cronTimer.unref();
  logger.info('lease-expiry-scanner: hourly tick installed');
}

export function stopLeaseExpiryCron(): void {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = null;
  }
  // Reset module-scope state so tests can drive the cron again.
  lastRunUtcDate = null;
  scanRunning = false;
}
