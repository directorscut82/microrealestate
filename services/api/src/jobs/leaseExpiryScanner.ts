import { Collections, logger, Service } from '@microrealestate/common';
import type { ConnectionRole } from '@microrealestate/types';
import axios from 'axios';
import { createNotice, notifyTelegram } from './noticeHelpers.js';
import moment from 'moment';
import { runNoticeScans } from './noticeScanner.js';

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

// Energy-certificate validity (Greek ΠΕΑ): 10 years legally, but the user
// tracks renewal at 5 years after issue. Notify windows are longer than the
// lease ones — booking an energy inspector needs lead time.
export const ENERGY_CERT_VALIDITY_YEARS = 5;
export const ENERGY_CERT_DAY_WINDOWS: number[] = [60, 30, 7];

// Telegram plumbing (TelegramNotifyResult + the sender) lives in
// noticeHelpers.ts so every scanner shares ONE implementation. The lease path
// treats it as fire-and-forget (email is its channel of record); the
// energy-cert path is Telegram-ONLY and gates its debounce on `delivered`
// (N1).

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
  // Mints the short-lived service token used to authenticate the POST to
  // the emailer. Defaults to the live Service call; injectable so the test
  // suite can drive the send path without a Service bootstrap (otherwise
  // createServiceToken throws and every send silently lands in the catch).
  mintToken?: (role: ConnectionRole, realmId: string) => Promise<string>;
  // Bell-notice insert seam (defaults to noticeHelpers.createNotice, which
  // hits mongo). Same rationale as the hooks above.
  createNotice?: typeof createNotice;
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

  const mintToken =
    deps.mintToken ||
    ((role: ConnectionRole, realmId: string) =>
      Service.getInstance().createServiceToken(role, realmId));

  const insertNotice = deps.createNotice || createNotice;

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
      const serviceToken = await mintToken(
        'administrator',
        String(tenant.realmId)
      );
      const emailResp = await postEmail(
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
      // X1-sibling (ingress+error-path audit 2026-07): the emailer answers
      // HTTP 200 with a per-recipient EMBEDDED error ({status:{id:null,error}})
      // when the provider rejects (Promise.allSettled). Awaiting the POST is
      // NOT proof of delivery — inspect the rows and treat an embedded error as
      // a failure, so a bounced lease-expiry notice does NOT get markSent
      // (which would permanently suppress the window). Mirrors emailmanager X1.
      const rows: any[] = Array.isArray(emailResp?.data)
        ? emailResp.data
        : Array.isArray(emailResp)
          ? emailResp
          : [];
      const embeddedError = rows.find(
        (r: any) => r?.status?.error || (r?.status && r.status.id === null)
      );
      if (embeddedError) {
        result.errors++;
        logger.error(
          `lease-expiry-notice bounced for tenant ${tenant._id} (window ${daysUntil}) — NOT marking sent: ${String(embeddedError.status?.error || 'delivery failed')}`
        );
        continue;
      }
      await markSent(String(tenant._id), now, daysUntil);
      result.sent++;
      logger.info(
        `lease-expiry-notice sent to tenant ${tenant._id} (expires in ${daysUntil}d)`
      );
      const leaseNoticeText = `⏳ Μίσθωση λήγει σε ${daysUntil} ημέρ${daysUntil === 1 ? 'α' : 'ες'}: ${tenant.name} (${moment.utc(tenant.endDate).format('DD/MM/YYYY')})`;
      // Telegram admin ping — piggybacks on the SAME per-window debounce as
      // the email (we only reach here when the window fired), so no extra
      // timers or state. Best-effort.
      await notifyTelegram(
        emailerUrl,
        mintToken,
        String(tenant.realmId),
        leaseNoticeText
      );
      // Bell notice — same text, same window; createNotice (NOT pushNotice)
      // because the Telegram ping above already went out. The dedupeKey pins
      // (tenant, endDate, window) so a re-run after a markSent-race can't
      // duplicate the bell item.
      await insertNotice({
        realmId: String(tenant.realmId),
        code: 'lease-expiry',
        message: leaseNoticeText,
        link: `/tenants/${tenant._id}`,
        dedupeKey: `lease-expiry:${tenant._id}:${moment.utc(tenant.endDate).format('YYYYMMDD')}:${daysUntil}`
      });
    } catch (err: any) {
      // J1C-004: distinguish a structural skip ("no registered realm
      // members" — admin hasn't invited anyone) from a real failure.
      // The recipient resolver returns an empty array in that case and
      // the emailer 422s with "missing recipient list". Mark this
      // tenant's window as sent so we stop retrying every cron tick;
      // there's nobody to email and that won't change without admin
      // action.
      const status = err?.response?.status;
      const body = err?.response?.data;
      const reason =
        typeof body === 'string'
          ? body
          : body?.error || body?.message || err?.message || '';
      const isStructuralSkip =
        status === 422 && /missing recipient list/i.test(String(reason));
      if (isStructuralSkip) {
        await markSent(String(tenant._id), now, daysUntil);
        result.skipped++;
        logger.warn(
          `lease-expiry-notice: tenant ${tenant._id} realm has no recipients — marked window ${daysUntil} as sent to avoid retry loop`
        );
        // The email channel is structurally dead for this realm, but the BELL
        // still works — surface the expiry there so the window isn't silent.
        await insertNotice({
          realmId: String(tenant.realmId),
          code: 'lease-expiry',
          message: `⏳ Μίσθωση λήγει σε ${daysUntil} ημέρ${daysUntil === 1 ? 'α' : 'ες'}: ${tenant.name} (${moment.utc(tenant.endDate).format('DD/MM/YYYY')})`,
          link: `/tenants/${tenant._id}`,
          dedupeKey: `lease-expiry:${tenant._id}:${moment.utc(tenant.endDate).format('YYYYMMDD')}:${daysUntil}`
        });
        continue;
      }
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

/**
 * Energy-certificate (ΠΕΑ) expiry scan: a certificate expires
 * ENERGY_CERT_VALIDITY_YEARS after its issueDate. Telegram-only admin
 * notification at the ENERGY_CERT_DAY_WINDOWS marks, with the same
 * per-window debounce persisted on property.energyCertificate
 * .expiryNoticesSent[]. Runs inside the SAME once-per-UTC-day cron body as
 * the lease scan — no additional timers.
 */
export async function checkExpiringEnergyCerts(
  deps: Partial<ExpiryScanDeps> = {}
): Promise<ScanResult> {
  const now = deps.now ? deps.now() : new Date();
  const result: ScanResult = { scanned: 0, sent: 0, skipped: 0, errors: 0 };

  const horizon = Math.max(...ENERGY_CERT_DAY_WINDOWS);
  // A cert expiring within `horizon` days was issued within (5y - horizon .. 5y)
  // days ago. Filter in mongo to that issue range so we never scan the whole
  // collection. This is only a COARSE pre-filter — the authoritative match is
  // the exact `ENERGY_CERT_DAY_WINDOWS.includes(daysUntil)` check per property
  // below, so the filter merely needs to be a SUPERSET.
  //
  // Leap-year correctness (audit-2026-07): the needed upper bound is
  // (now + horizon days − 5y), but `subtract(5y).add(horizon d)` and
  // `add(horizon d).subtract(5y)` don't commute across a Feb-29 boundary — they
  // can differ by a calendar day, which silently dropped an edge cert from the
  // scan for ANY window (not just 60). Add a few days of slack on BOTH ends so
  // no real match can fall outside the pre-filter; the exact per-property check
  // still prevents any false notice from the wider net.
  const FILTER_SLACK_DAYS = 3;
  const issueStart = moment
    .utc(now)
    .subtract(ENERGY_CERT_VALIDITY_YEARS, 'years')
    .subtract(FILTER_SLACK_DAYS, 'days')
    .startOf('day')
    .toDate();
  const issueEnd = moment
    .utc(now)
    .subtract(ENERGY_CERT_VALIDITY_YEARS, 'years')
    .add(horizon + FILTER_SLACK_DAYS, 'days')
    .endOf('day')
    .toDate();

  const emailerUrl =
    deps.emailerUrl ||
    (Service.getInstance().envConfig.getValues().EMAILER_URL as string);
  const mintToken =
    deps.mintToken ||
    ((role: ConnectionRole, realmId: string) =>
      Service.getInstance().createServiceToken(role, realmId));
  const insertNotice = deps.createNotice || createNotice;

  const properties: any[] = await Collections.Property.find({
    'energyCertificate.issueDate': { $gte: issueStart, $lte: issueEnd }
  }).lean();
  result.scanned = properties.length;

  for (const property of properties) {
    const cert = property.energyCertificate;
    if (!cert?.issueDate) {
      result.skipped++;
      continue;
    }
    const expiresAt = moment
      .utc(cert.issueDate)
      .add(ENERGY_CERT_VALIDITY_YEARS, 'years')
      .toDate();
    const daysUntil = _daysUntil(now, expiresAt);
    if (!ENERGY_CERT_DAY_WINDOWS.includes(daysUntil)) {
      result.skipped++;
      continue;
    }
    const windowCutoff = _windowDebounceCutoff(now, daysUntil);
    const alreadySent = (cert.expiryNoticesSent || []).find(
      (e: any) =>
        Number(e?.window) === daysUntil &&
        e?.sentAt &&
        new Date(e.sentAt) >= windowCutoff
    );
    if (alreadySent) {
      result.skipped++;
      continue;
    }

    try {
      const certNoticeText = `📜 Ενεργειακό πιστοποιητικό λήγει σε ${daysUntil} ημέρ${
        daysUntil === 1 ? 'α' : 'ες'
      }: ${property.name} (έκδοση ${moment
        .utc(cert.issueDate)
        .format('DD/MM/YYYY')}, λήξη ${moment
        .utc(expiresAt)
        .format('DD/MM/YYYY')})`;
      // Bell notice FIRST — Telegram was the only channel here (N1), which
      // meant a not-configured realm never saw cert expiries at all. The bell
      // works regardless of Telegram config, so it is now the channel of
      // record; the per-window Telegram debounce below is unchanged.
      await insertNotice({
        realmId: String(property.realmId),
        code: 'energy-cert',
        message: certNoticeText,
        link: `/properties/${property._id}`,
        dedupeKey: `energy-cert:${property._id}:${moment.utc(expiresAt).format('YYYYMMDD')}:${daysUntil}`
      });
      const notify = await notifyTelegram(
        emailerUrl,
        mintToken,
        String(property.realmId),
        certNoticeText
      );

      // N1 (audit-2026-07): Telegram is the ONLY channel for cert notices, so
      // the per-window debounce must record only when the message actually
      // went out — otherwise one transient blip permanently suppresses the
      // 60/30/7 warning and a certificate can lapse silently. This mirrors the
      // lease path, which gates markSent on a successful postEmail.
      if (!notify.delivered) {
        if (notify.notConfigured) {
          // No Telegram configured for this realm — a structural skip. Mark
          // the window so we stop retrying every cron tick; it won't change
          // without admin action (same rule as the lease no-recipient skip).
          await Collections.Property.updateOne(
            { _id: property._id },
            {
              $push: {
                'energyCertificate.expiryNoticesSent': {
                  window: daysUntil,
                  sentAt: now
                }
              }
            }
          );
          result.skipped++;
          logger.warn(
            `energy-cert-expiry: realm ${property.realmId} has no Telegram configured — marked window ${daysUntil} as sent to avoid retry loop`
          );
        } else {
          // Transient delivery failure — do NOT mark this window sent. Windows
          // are exact-day matches ([60,30,7]), so the NEXT daily scan (day-59
          // etc.) won't re-fire this same window; recovery happens only if the
          // scan re-runs on the SAME UTC day (e.g. a deploy/restart resets the
          // once-per-day guard). Leaving it unmarked is still strictly better
          // than the old code, which recorded a phantom "sent" on failure and
          // could never recover. The next distinct window (30/7) fires cleanly.
          result.errors++;
          logger.error(
            `energy-cert-expiry telegram delivery failed for property ${property._id} (window ${daysUntil}) — window left unmarked`
          );
        }
        continue;
      }

      await Collections.Property.updateOne(
        { _id: property._id },
        {
          $push: {
            'energyCertificate.expiryNoticesSent': {
              window: daysUntil,
              sentAt: now
            }
          }
        }
      );
      result.sent++;
      logger.info(
        `energy-cert-expiry notice sent for property ${property._id} (expires in ${daysUntil}d)`
      );
    } catch (err: any) {
      result.errors++;
      logger.error(
        `energy-cert-expiry failed for property ${property._id}: ${err?.message || err}`
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
    // Energy-certificate scan shares the same daily slot. Its errors are its
    // own — a cert-scan failure must not mark the lease scan as failed.
    try {
      const c = await checkExpiringEnergyCerts(deps);
      logger.info(
        `energy-cert-scanner: scanned=${c.scanned} sent=${c.sent} skipped=${c.skipped} errors=${c.errors}`
      );
    } catch (err: any) {
      logger.error(
        `energy-cert-scanner: top-level failure: ${err?.message || err}`
      );
    }
    // Notice scans (bill due, unpaid-rents digest, deposits, holdover,
    // inbox-TTL) share the same daily slot too — runNoticeScans try/catches
    // each scan internally and logs its own summary.
    try {
      await runNoticeScans(deps);
    } catch (err: any) {
      logger.error(`notice-scans: top-level failure: ${err?.message || err}`);
    }
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
