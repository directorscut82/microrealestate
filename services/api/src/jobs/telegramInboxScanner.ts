/**
 * Telegram inbox poller — Slice 4 of the bill-OCR plan (§6.1).
 *
 * Every 60s (D10: NOT the lease scanner's hourly/once-per-day cadence — that
 * would defeat an inbox), for each realm with Telegram configured:
 *   1. getUpdates?offset=<lastUpdateId+1> with the realm's bot token.
 *   2. For each photo/document message from the realm's adminChatId:
 *      download the file (getFile → file API), run it through the SAME
 *      parseBillPdf pipeline as the import dialog, and write an InboxItem.
 *   3. Persist the new offset (TelegramOffset, one doc per realm) so an api
 *      restart resumes instead of re-ingesting.
 *
 * Single-replica assumption: api has no `replicas:` in the prod compose, so
 * one poller instance owns getUpdates. (Two replicas would race the offset —
 * Telegram long-polling is consume-once.)
 *
 * Structure mirrors jobs/leaseExpiryScanner.ts: dependency-injection hooks so
 * unit tests drive the routing/offset logic without network or mongo,
 * setInterval + .unref() + re-entrancy guard, start/stop exports wired in
 * index.ts.
 */
import { Collections, Crypto, logger } from '@microrealestate/common';
import axios from 'axios';
import { parseBillPdf } from '../managers/billparser/index.js';

const POLL_MS = 60_000;
// A Telegram photo of a bill is a few MB; documents are bounded by the same
// 6MB cap the upload route enforces (routes.ts uploadBill limits.fileSize).
const MAX_TG_FILE_BYTES = 6 * 1024 * 1024;

export interface TelegramRealmConfig {
  realmId: string;
  botToken: string;
  adminChatId: string;
}

export interface InboxScanDeps {
  now: () => Date;
  /** Realms with telegram.selected + botToken + adminChatId set (decrypted). */
  findTelegramRealms: () => Promise<TelegramRealmConfig[]>;
  /** Last consumed update_id for the realm (0 if none). */
  getOffset: (realmId: string) => Promise<number>;
  /** Persist the new last-consumed update_id. */
  setOffset: (realmId: string, lastUpdateId: number) => Promise<void>;
  /** Telegram Bot API getUpdates. */
  getUpdates: (botToken: string, offset: number) => Promise<TgUpdate[]>;
  /** Download a Telegram file by file_id; null when refused (too big, gone). */
  downloadFile: (
    botToken: string,
    fileId: string
  ) => Promise<{ buffer: Buffer; fileName: string } | null>;
  /** The bill parse pipeline (parseBillPdf) — injected for tests. */
  parseBill: (buffer: Buffer) => Promise<any>;
  /** Find the building/expense whose billingId matches (suggestedMatch). */
  findMatch: (
    realmId: string,
    billingIdNormalized: string
  ) => Promise<{
    buildingId: string;
    buildingName: string;
    expenseId: string;
    expenseName: string;
  } | null>;
  /** True if this telegramMessageId was already ingested for the realm. */
  hasInboxItem: (
    realmId: string,
    telegramMessageId: number
  ) => Promise<boolean>;
  createInboxItem: (doc: Record<string, unknown>) => Promise<void>;
  /** Acknowledge a message we won't ingest (wrong chat, no file, too big). */
  sendReply?: (
    botToken: string,
    chatId: string | number,
    text: string
  ) => Promise<void>;
}

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    // Telegram sends multiple sizes; we take the largest (last).
    photo?: { file_id: string; file_size?: number }[];
    document?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
    caption?: string;
  };
}

export interface InboxScanResult {
  realms: number;
  updates: number;
  ingested: number;
  skipped: number;
  errors: number;
}

// --- Default (production) deps ---------------------------------------------

async function _findTelegramRealms(): Promise<TelegramRealmConfig[]> {
  const realms = await Collections.Realm.find({
    'thirdParties.telegram.selected': true
  }).lean();
  const out: TelegramRealmConfig[] = [];
  for (const realm of realms as any[]) {
    const tg = realm?.thirdParties?.telegram;
    if (!tg?.botToken || !tg?.adminChatId) continue;
    try {
      out.push({
        realmId: String(realm._id),
        botToken: Crypto.decrypt(tg.botToken),
        adminChatId: String(tg.adminChatId).trim()
      });
    } catch (err: any) {
      logger.error(
        `telegram-inbox: realm ${realm._id} botToken decrypt failed: ${err?.message || err}`
      );
    }
  }
  return out;
}

async function _getOffset(realmId: string): Promise<number> {
  const doc: any = await Collections.TelegramOffset.findOne({
    realmId
  }).lean();
  return doc?.lastUpdateId || 0;
}

async function _setOffset(
  realmId: string,
  lastUpdateId: number
): Promise<void> {
  await Collections.TelegramOffset.updateOne(
    { realmId },
    { $set: { lastUpdateId, updatedDate: new Date() } },
    { upsert: true }
  );
}

async function _getUpdates(
  botToken: string,
  offset: number
): Promise<TgUpdate[]> {
  const resp = await axios.get(
    `https://api.telegram.org/bot${botToken}/getUpdates`,
    {
      params: {
        offset,
        allowed_updates: JSON.stringify(['message']),
        timeout: 0 // short poll — the 60s interval is our cadence
      },
      timeout: 15_000
    }
  );
  return resp.data?.result || [];
}

async function _downloadFile(
  botToken: string,
  fileId: string
): Promise<{ buffer: Buffer; fileName: string } | null> {
  const meta = await axios.get(
    `https://api.telegram.org/bot${botToken}/getFile`,
    { params: { file_id: fileId }, timeout: 15_000 }
  );
  const filePath = meta.data?.result?.file_path;
  const fileSize = meta.data?.result?.file_size || 0;
  if (!filePath) return null;
  if (fileSize > MAX_TG_FILE_BYTES) {
    logger.warn(
      `telegram-inbox: file ${fileId} too big (${fileSize} bytes) — skipped`
    );
    return null;
  }
  const resp = await axios.get(
    `https://api.telegram.org/file/bot${botToken}/${filePath}`,
    {
      responseType: 'arraybuffer',
      timeout: 60_000,
      maxContentLength: MAX_TG_FILE_BYTES
    }
  );
  return {
    buffer: Buffer.from(resp.data),
    fileName: filePath.split('/').pop() || 'telegram-file'
  };
}

async function _findMatch(realmId: string, billingIdNormalized: string) {
  // Same matching rule as parseBills (billmanager.findExpenseByBillingId):
  // billingId equality after normalization, skipping soft-deleted expenses.
  const { normalizeBillingId } = await import(
    '../managers/billparser/index.js'
  );
  const buildings = await Collections.Building.find({ realmId }).lean();
  const now = new Date();
  const currentTerm = Number(
    `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}0100`
  );
  for (const building of buildings as any[]) {
    for (const expense of building.expenses || []) {
      if (!expense.billingId) continue;
      if (expense.endTerm && Number(expense.endTerm) < currentTerm) continue;
      if (normalizeBillingId(expense.billingId) === billingIdNormalized) {
        return {
          buildingId: String(building._id),
          buildingName: building.name,
          expenseId: String(expense._id),
          expenseName: expense.name
        };
      }
    }
  }
  return null;
}

async function _hasInboxItem(
  realmId: string,
  telegramMessageId: number
): Promise<boolean> {
  const existing = await Collections.InboxItem.findOne({
    realmId,
    telegramMessageId
  }).lean();
  return !!existing;
}

async function _createInboxItem(doc: Record<string, unknown>): Promise<void> {
  await Collections.InboxItem.create(doc);
}

async function _sendReply(
  botToken: string,
  chatId: string | number,
  text: string
): Promise<void> {
  try {
    await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: chatId, text, disable_web_page_preview: true },
      { timeout: 15_000 }
    );
  } catch (err: any) {
    logger.warn(`telegram-inbox: reply failed: ${err?.message || err}`);
  }
}

function _defaultDeps(): InboxScanDeps {
  return {
    now: () => new Date(),
    findTelegramRealms: _findTelegramRealms,
    getOffset: _getOffset,
    setOffset: _setOffset,
    getUpdates: _getUpdates,
    downloadFile: _downloadFile,
    parseBill: parseBillPdf,
    findMatch: _findMatch,
    hasInboxItem: _hasInboxItem,
    createInboxItem: _createInboxItem,
    sendReply: _sendReply
  };
}

// --- Core scan (exported for unit tests) ------------------------------------

function computeDefaultTerm(periodEnd: Date): number {
  const year = periodEnd.getUTCFullYear();
  const month = periodEnd.getUTCMonth() + 1;
  return year * 1000000 + month * 10000 + 100;
}

export async function scanTelegramInbox(
  overrides: Partial<InboxScanDeps> = {}
): Promise<InboxScanResult> {
  const deps: InboxScanDeps = { ..._defaultDeps(), ...overrides };
  const result: InboxScanResult = {
    realms: 0,
    updates: 0,
    ingested: 0,
    skipped: 0,
    errors: 0
  };

  let realms: TelegramRealmConfig[];
  try {
    realms = await deps.findTelegramRealms();
  } catch (err: any) {
    logger.error(`telegram-inbox: realm lookup failed: ${err?.message || err}`);
    result.errors++;
    return result;
  }

  for (const realm of realms) {
    result.realms++;
    try {
      const last = await deps.getOffset(realm.realmId);
      const updates = await deps.getUpdates(realm.botToken, last + 1);
      if (!updates.length) continue;
      result.updates += updates.length;

      let maxUpdateId = last;
      for (const u of updates) {
        // ALWAYS advance past every update we saw — even ones we skip or that
        // error — otherwise a poison message wedges the queue forever.
        if (u.update_id > maxUpdateId) maxUpdateId = u.update_id;
        try {
          const handled = await _handleUpdate(realm, u, deps);
          if (handled === 'ingested') result.ingested++;
          else result.skipped++;
        } catch (err: any) {
          result.errors++;
          logger.error(
            `telegram-inbox: update ${u.update_id} (realm ${realm.realmId}) failed: ${err?.message || err}`
          );
        }
      }
      if (maxUpdateId > last) {
        await deps.setOffset(realm.realmId, maxUpdateId);
      }
    } catch (err: any) {
      // A realm-level failure (network, bad token) must not stop other realms,
      // and must NOT advance the offset — those updates retry next tick.
      result.errors++;
      logger.error(
        `telegram-inbox: realm ${realm.realmId} poll failed: ${err?.message || err}`
      );
    }
  }
  return result;
}

async function _handleUpdate(
  realm: TelegramRealmConfig,
  u: TgUpdate,
  deps: InboxScanDeps
): Promise<'ingested' | 'skipped'> {
  const msg = u.message;
  if (!msg) return 'skipped';

  // Only the realm's configured admin chat may feed the inbox — anything else
  // (random people messaging a public bot) is ignored, not replied to.
  if (String(msg.chat.id) !== realm.adminChatId) return 'skipped';

  // Pick the file: document as-is; photo → the largest rendition (last entry).
  let fileId: string | undefined;
  let fileName: string | undefined;
  if (msg.document?.file_id) {
    fileId = msg.document.file_id;
    fileName = msg.document.file_name;
  } else if (msg.photo?.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
    fileName = `photo-${msg.message_id}.jpg`;
  }
  if (!fileId) return 'skipped'; // text-only message — not a bill

  // Dedup (unique index is the backstop; this avoids the duplicate-key noise).
  if (await deps.hasInboxItem(realm.realmId, msg.message_id)) return 'skipped';

  const file = await deps.downloadFile(realm.botToken, fileId);
  if (!file) {
    await deps.sendReply?.(
      realm.botToken,
      msg.chat.id,
      'Το αρχείο δεν μπόρεσε να ληφθεί (πολύ μεγάλο ή μη διαθέσιμο). Στείλτε φωτογραφία έως 6MB.'
    );
    return 'skipped';
  }

  // Same pipeline as the import dialog. A parse failure still creates an
  // InboxItem (with parseError) — the landlord must SEE that a bill arrived
  // and could not be read, rather than the message vanishing.
  let parsed: any = {};
  let parseError: string | undefined;
  let suggestedMatch: Awaited<ReturnType<InboxScanDeps['findMatch']>> = null;
  try {
    const parseResult = await deps.parseBill(file.buffer);
    if (parseResult?.success && parseResult.bill) {
      const bill = parseResult.bill;
      parsed = {
        provider: bill.provider,
        billingId: bill.billingId,
        billingIdNormalized: bill.billingIdNormalized,
        totalAmount: bill.totalAmount,
        periodStart: bill.periodStart,
        periodEnd: bill.periodEnd,
        issueDate: bill.issueDate,
        dueDate: bill.dueDate,
        rfCode: bill.rfCode,
        paymentCode: bill.paymentCode,
        proposedTerm: bill.periodEnd
          ? computeDefaultTerm(new Date(bill.periodEnd))
          : undefined
      };
      if (bill.billingIdNormalized) {
        suggestedMatch = await deps.findMatch(
          realm.realmId,
          bill.billingIdNormalized
        );
      }
    } else {
      parseError = parseResult?.error || 'Αποτυχία ανάλυσης λογαριασμού';
    }
  } catch (err: any) {
    parseError = err?.message || 'Αποτυχία ανάλυσης λογαριασμού';
  }

  const now = deps.now();
  await deps.createInboxItem({
    realmId: realm.realmId,
    source: 'telegram',
    status: 'pending',
    parsed,
    parseError,
    suggestedMatch,
    warnings: [],
    sourceFileName: fileName || 'telegram-file',
    telegramMessageId: msg.message_id,
    telegramFileId: fileId,
    createdDate: now,
    updatedDate: now
  });

  await deps.sendReply?.(
    realm.botToken,
    msg.chat.id,
    parseError
      ? `Ελήφθη, αλλά δεν διαβάστηκε (${parseError}). Θα το βρείτε στις ειδοποιήσεις για χειροκίνητη καταχώρηση.`
      : `Ελήφθη ο λογαριασμός${parsed.totalAmount ? ` (${parsed.totalAmount}€)` : ''} — εκκρεμεί επιβεβαίωση στις ειδοποιήσεις της εφαρμογής.`
  );
  return 'ingested';
}

// --- Cron wiring (leaseExpiryScanner pattern, 60s cadence) -------------------

let pollTimer: NodeJS.Timeout | null = null;
let pollRunning = false;

export async function runInboxPollOnce(
  overrides: Partial<InboxScanDeps> = {}
): Promise<InboxScanResult | null> {
  // Re-entrancy guard only — deliberately NO once-per-day short-circuit (D10):
  // this is an inbox, every 60s tick must poll.
  if (pollRunning) return null;
  pollRunning = true;
  try {
    const r = await scanTelegramInbox(overrides);
    if (r.updates > 0 || r.errors > 0) {
      logger.info(
        `telegram-inbox: realms=${r.realms} updates=${r.updates} ingested=${r.ingested} skipped=${r.skipped} errors=${r.errors}`
      );
    }
    return r;
  } catch (err: any) {
    logger.error(`telegram-inbox: top-level failure: ${err?.message || err}`);
    return null;
  } finally {
    pollRunning = false;
  }
}

export function startTelegramInboxCron(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    runInboxPollOnce().catch((err) => {
      logger.error(
        `telegram-inbox: unexpected rejection: ${err?.message || err}`
      );
    });
  }, POLL_MS);
  pollTimer.unref();
  logger.info('telegram-inbox: 60s poller installed');
}

export function stopTelegramInboxCron(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollRunning = false;
}
