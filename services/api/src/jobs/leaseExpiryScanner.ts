import { Collections, logger, Service } from '@microrealestate/common';
import axios from 'axios';
import moment from 'moment';

// Days-before-expiry that should trigger a notice. Each tenant is matched
// against the "in N days" window (±0.5 day) so the scanner is tolerant of
// midnight drift. We send at the *first* matching window — the
// lastExpiryNoticeSentAt + Email-collection debounce ensures the same notice
// isn't fired twice in the cooldown period for two adjacent windows.
export const EXPIRY_DAY_WINDOWS: number[] = [30, 7, 1];

// Per-window debounce: each window (30/7/1) is tracked independently in
// tenant.expiryNoticesSent[]. We suppress only if the SAME window fired
// within the last (window + 1) days — long enough that a daily cron
// can't double-fire the same window, short enough that the next window
// isn't accidentally suppressed.
//
// Bug fix history: a flat 25-day cross-window debounce was previously
// applied. With windows [30, 7, 1] and a 30-day notice fired at day-30,
// the 7-day window arrives 23 days later and was permanently
// suppressed. Per-window tracking eliminates that entire class.
//
// EXPIRY_DEBOUNCE_DAYS retained for backwards-compat with any caller
// reading the constant; the live debounce path no longer uses it.
export const EXPIRY_DEBOUNCE_DAYS = 25;

function _windowDebounceCutoff(
  now: Date,
  windowDays: number
): Date {
  // Same-window suppression window. windowDays + 1 covers the day the
  // tenant crosses into the next window (e.g. day-30 fires once across
  // the 31-day window).
  return moment.utc(now).subtract(windowDays + 1, 'days').toDate();
}

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
  markSent?: (tenantId: string, when: Date, windowDays?: number) => Promise<void>;
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

  // Default markSent atomically records BOTH the legacy
  // lastExpiryNoticeSentAt and a new entry in expiryNoticesSent[] for the
  // window that just fired. Tests can override via deps.markSent.
  const markSent =
    deps.markSent ||
    (async (tenantId: string, when: Date, windowDays?: number) => {
      const update: Record<string, any> = {
        $set: { lastExpiryNoticeSentAt: when }
      };
      if (typeof windowDays === 'number') {
        update.$push = {
          expiryNoticesSent: { window: windowDays, sentAt: when }
        };
      }
      await Collections.Tenant.updateOne({ _id: tenantId }, update);
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

    // Per-window debounce: only suppress this notice if the SAME window
    // already fired within the last (window + 1) days. Cross-window
    // sends never block each other — a tenant that received the 30-day
    // notice still gets the 7-day reminder 23 days later.
    const windowCutoff = _windowDebounceCutoff(now, daysUntil);
    const sentForThisWindow = (tenant.expiryNoticesSent || []).find(
      (e: any) =>
        Number(e?.window) === daysUntil &&
        e?.sentAt &&
        new Date(e.sentAt) >= windowCutoff
    );
    if (sentForThisWindow) {
      result.skipped++;
      continue;
    }
    // Source-of-truth fallback: if the per-window record is empty (e.g.
    // the field was added in a migration after the email was sent), check
    // the Email collection for a row in the same window-cutoff range.
    const recent = await findRecentEmail(String(tenant._id), windowCutoff);
    if (recent) {
      result.skipped++;
      continue;
    }

    try {
      // The /emailer route is gated by needAccessToken — the cron has no
      // incoming request to forward, so mint a short-lived service token
      // (30s, signed with ACCESS_TOKEN_SECRET) for each POST. The token
      // carries the tenant's realmId so checkOrganization passes.
      const serviceToken = await Service.getInstance().createServiceToken(
        'administrator',
        String(tenant.realmId)
      );
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
          authorization: `Bearer ${serviceToken}`,
          organizationid: String(tenant.realmId)
        }
      );
      await markSent(String(tenant._id), now, daysUntil);
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
