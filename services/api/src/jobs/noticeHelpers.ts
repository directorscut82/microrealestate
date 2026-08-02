import { Collections, logger } from '@microrealestate/common';
import type { CollectionTypes, ConnectionRole } from '@microrealestate/types';
import axios from 'axios';

// Shared plumbing for server-generated notices: the bell (InboxItem
// kind:'notice') is the channel of record, Telegram is the best-effort push.
// Extracted from leaseExpiryScanner so every scanner shares ONE Telegram
// sender and ONE bell-insert path instead of re-implementing either.

// Outcome of a Telegram admin notification. Callers that treat Telegram as
// their ONLY channel (energy-cert scan) must gate their debounce on
// `delivered`; callers with another channel of record (email, the bell) treat
// it as fire-and-forget.
export interface TelegramNotifyResult {
  delivered: boolean;
  // 503 → Telegram not configured for this realm. A permanent-until-admin-acts
  // condition, distinct from a transient delivery failure.
  notConfigured: boolean;
}

// POST a Telegram admin notification through the emailer (which holds the
// encrypted bot token). Auth uses the same short-lived service token as the
// email path. Never throws (never aborts a scan) — it reports the outcome so
// the caller decides whether the notice counts as sent.
export async function notifyTelegram(
  emailerUrl: string,
  mintToken: (role: ConnectionRole, realmId: string) => Promise<string>,
  realmId: string,
  text: string
): Promise<TelegramNotifyResult> {
  try {
    const serviceToken = await mintToken('administrator', realmId);
    await axios.post(
      `${emailerUrl}/telegram`,
      { text },
      {
        headers: {
          authorization: `Bearer ${serviceToken}`,
          organizationid: realmId
        },
        timeout: 15_000
      }
    );
    return { delivered: true, notConfigured: false };
  } catch (err: any) {
    // 503 = Telegram not configured for this realm — normal, stay quiet.
    if (err?.response?.status === 503) {
      return { delivered: false, notConfigured: true };
    }
    logger.warn(
      `notice telegram notify failed (non-blocking): ${err?.message || err}`
    );
    return { delivered: false, notConfigured: false };
  }
}

export interface NoticeInput {
  realmId: string;
  // The code union lives ONCE, on the collection type — a second copy here
  // would drift the moment a code is added.
  code: CollectionTypes.InboxItemNotice['code'];
  // Server-composed Greek — the SAME string goes to the bell and to Telegram.
  message: string;
  // App-relative path WITHOUT the org segment ('/tenants/{id}', …) or ''.
  link: string;
  dedupeKey: string;
}

export interface NoticeDeps {
  // Injectable insert so tests drive the helper without mongo. Must reject
  // with {code: 11000} on a duplicate dedupeKey, like the real index does.
  insertNotice?: (doc: Record<string, any>) => Promise<any>;
  notifyTelegram?: typeof notifyTelegram;
  now?: () => Date;
  // Seams for resolveStaleNotices (same rationale as insertNotice).
  findPendingNotices?: (filter: Record<string, any>) => Promise<any[]>;
  resolveNotices?: (ids: any[]) => Promise<any>;
}

/**
 * Insert a bell notice. Idempotent: the (realmId, dedupeKey) unique index
 * turns a scanner re-fire into an E11000, reported as {created:false}. A
 * dismissed notice keeps its key, so dismissal is durable across daily
 * re-scans. Never throws — a notice failure must not break the caller
 * (scanner loop or lifecycle write).
 */
export async function createNotice(
  input: NoticeInput,
  deps: NoticeDeps = {}
): Promise<{ created: boolean }> {
  const now = deps.now ? deps.now() : new Date();
  const insert =
    deps.insertNotice ||
    ((doc: Record<string, any>) => Collections.InboxItem.create(doc));
  try {
    await insert({
      realmId: input.realmId,
      source: 'system',
      status: 'pending',
      kind: 'notice',
      notice: {
        code: input.code,
        message: input.message,
        link: input.link
      },
      dedupeKey: input.dedupeKey,
      createdDate: now,
      updatedDate: now
    });
    return { created: true };
  } catch (err: any) {
    if (err?.code === 11000) {
      return { created: false };
    }
    logger.error(
      `createNotice failed (${input.code} ${input.dedupeKey}): ${err?.message || err}`
    );
    return { created: false };
  }
}

/**
 * createNotice + best-effort Telegram push of the same message. The bell is
 * the channel of record: a Telegram failure (or not-configured realm) never
 * rolls the bell item back and never throws. Telegram is only attempted when
 * the notice was actually created — a deduped re-fire must not re-ping.
 */
export async function pushNotice(
  input: NoticeInput,
  emailerUrl: string,
  mintToken: (role: ConnectionRole, realmId: string) => Promise<string>,
  deps: NoticeDeps = {}
): Promise<{ created: boolean; telegramDelivered: boolean }> {
  const { created } = await createNotice(input, deps);
  if (!created) {
    return { created: false, telegramDelivered: false };
  }
  const send = deps.notifyTelegram || notifyTelegram;
  const result = await send(
    emailerUrl,
    mintToken,
    input.realmId,
    input.message
  );
  return { created: true, telegramDelivered: result.delivered };
}

/**
 * Auto-resolve notices whose condition no longer holds.
 *
 * Without this a notice is immortal until the 30-day TTL: the ONLY other write
 * of status:'dismissed' in the API is the user-driven dismiss route. Because
 * each scan fires at several windows (bill-due at 7/1/0/-3 days, lease-expiry
 * at 30/7/1, …), one unpaid bill accumulates a separate pending item per window
 * — so paying it on day 2 left the day-1 and day-0 notices still asserting
 * «εκκρεμεί 200,00 €» and still counted in the bell badge. The badge measured
 * "notices ever generated", not "things needing attention".
 *
 * Called by each scan with the dedupeKey PREFIXES whose conditions it has just
 * re-evaluated, plus the set of prefixes still live. Anything pending under a
 * scanned prefix but absent from the live set is resolved. Never throws.
 */
export async function resolveStaleNotices(
  realmId: string,
  // e.g. 'bill-due:B1:' — matches every window of ONE condition instance.
  scannedPrefixes: string[],
  liveDedupeKeys: Set<string>,
  deps: NoticeDeps = {}
): Promise<{ resolved: number }> {
  if (!scannedPrefixes.length) return { resolved: 0 };
  const now = deps.now ? deps.now() : new Date();
  try {
    const find =
      deps.findPendingNotices ||
      (async (filter: Record<string, any>) =>
        Collections.InboxItem.find(filter, { dedupeKey: 1 }).lean());
    const resolve =
      deps.resolveNotices ||
      (async (ids: any[]) =>
        Collections.InboxItem.updateMany(
          { _id: { $in: ids } },
          { $set: { status: 'dismissed', updatedDate: now } }
        ));
    // Regex-escape each prefix — dedupeKeys embed ObjectIds and ':' only, but
    // an unescaped prefix would still be a latent injection into the query.
    const escaped = scannedPrefixes.map((p) =>
      p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );
    const pending: any[] = await find({
      realmId,
      kind: 'notice',
      status: 'pending',
      dedupeKey: { $regex: `^(${escaped.join('|')})` }
    });
    const stale = pending.filter(
      (d) => !liveDedupeKeys.has(String(d.dedupeKey))
    );
    if (!stale.length) return { resolved: 0 };
    await resolve(stale.map((d) => d._id));
    logger.info(
      `resolveStaleNotices: cleared ${stale.length} notice(s) whose condition no longer holds (realm ${realmId})`
    );
    return { resolved: stale.length };
  } catch (err: any) {
    logger.error(`resolveStaleNotices failed: ${err?.message || err}`);
    return { resolved: 0 };
  }
}
