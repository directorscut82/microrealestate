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
import * as billStorage from '../managers/billstorage.js';
import * as recapture from '../managers/recapturesession.js';
import { parseBillPdf } from '../managers/billparser/index.js';

const POLL_MS = 60_000;
// A Telegram photo of a bill is a few MB; documents are bounded by the same
// 6MB cap the upload route enforces (routes.ts uploadBill limits.fileSize).
const MAX_TG_FILE_BYTES = 6 * 1024 * 1024;

// How many consecutive ticks an update may fail before we declare it poison and
// skip past it. A transient failure (mongo blip, Telegram file API hiccup) gets
// this many 60s retries to recover WITHOUT losing the bill; a genuinely poison
// update (e.g. a permanently-bad file_id → getFile 400) is skipped after the
// budget so it can't wedge the queue forever.
const MAX_UPDATE_RETRIES = 5;
// (realmId:update_id) → consecutive failure count. Because the scan stops at the
// first failed update (contiguous-prefix advance), at most one entry per realm
// is ever live; cleared on success or on poison-skip.
const _updateRetries = new Map<string, number>();
function _retryKey(realmId: string, updateId: number): string {
  return `${realmId}:${updateId}`;
}

export interface TelegramRealmConfig {
  realmId: string;
  realmName: string;
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
  /**
   * Tier-2 re-capture (Slice 6 §15). If a recapture session is WAITING for this
   * realm, the next admin-chat photo is a zoomed re-shot of a failed RF/IBAN —
   * NOT a new bill. tryRecapture OCRs the crop, extracts+validates the target
   * field, and resolves the session. Returns:
   *   - false        → no active session; NOT consumed → normal ingest.
   *   - 'recovered'  → consumed AND a checksum-valid key was recovered.
   *   - 'failed'     → consumed (it WAS the re-shot) but no valid key was read;
   *                    the session stays open so the user can retry / type it.
   * The 'recovered' vs 'failed' distinction lets the poller send an ACCURATE
   * reply instead of always claiming success. Injected for tests.
   */
  tryRecapture?: (
    realm: TelegramRealmConfig,
    buffer: Buffer
  ) => Promise<false | 'recovered' | 'failed'>;
  /**
   * Archive the source bytes to B2 at ingest (Slice 5). Returns the object key
   * or null when B2 is not configured / upload failed — archival is
   * best-effort and never blocks ingest. Injected so unit tests skip S3.
   */
  archiveSource?: (
    realm: TelegramRealmConfig,
    billLikeId: string,
    fileName: string,
    buffer: Buffer
  ) => Promise<string | null>;
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
        realmName: String(realm.name || ''),
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

// Tier-2: consume a re-shot photo for an active recapture session. OCR the
// (already-zoomed) image, pull the target RF/IBAN, checksum-validate, resolve
// the session so the polling dialog picks it up. Returns true when consumed.
async function _tryRecapture(
  realm: TelegramRealmConfig,
  buffer: Buffer
): Promise<false | 'recovered' | 'failed'> {
  const now = Date.now();
  const session = recapture.activeSessionForRealm(realm.realmId, now);
  if (!session) return false;
  try {
    const { ocrImage } = await import('../managers/billparser/ocr.js');
    const { extractRFs, extractIBANs } = await import(
      '../managers/billparser/matching.js'
    );
    const text = await ocrImage(buffer);
    const found =
      session.target === 'rf' ? extractRFs(text) : extractIBANs(text);
    if (found.length) {
      recapture.resolveSession(realm.realmId, found[0], now);
      logger.info(
        `telegram-inbox: recapture recovered ${session.target} for realm ${realm.realmId}`
      );
      return 'recovered';
    }
    // A photo arrived but still no valid key — consume it (it WAS the re-shot,
    // even if it failed) so it isn't mis-ingested as a bill; the session stays
    // waiting until timeout so the user can try once more or type it manually.
    return 'failed';
  } catch (err: any) {
    logger.warn(`telegram-inbox: recapture OCR failed: ${err?.message || err}`);
    return 'failed';
  }
}

// Archive the source bytes to B2 at ingest (best-effort). Uses a synthetic
// pre-Bill id (the telegram message id) for the key path — the confirmed Bill
// later carries this key on pdfUrl, so it need not match the Bill _id.
async function _archiveSource(
  realm: TelegramRealmConfig,
  billLikeId: string,
  fileName: string,
  buffer: Buffer
): Promise<string | null> {
  const b2Config = await _b2ConfigForRealm(realm.realmId);
  if (!b2Config) return null;
  try {
    const key = billStorage.billObjectKey(
      realm.realmName,
      realm.realmId,
      billLikeId,
      fileName
    );
    const ct = /\.pdf$/i.test(fileName) ? 'application/pdf' : 'image/jpeg';
    const res = await billStorage.uploadBuffer(b2Config, key, buffer, ct);
    return res.key;
  } catch (err: any) {
    logger.error(
      `telegram-inbox: source archive failed (realm ${realm.realmId}): ${err?.message || err}`
    );
    return null;
  }
}

async function _b2ConfigForRealm(
  realmId: string
): Promise<billStorage.B2Config | null> {
  const realm: any = await Collections.Realm.findOne({ _id: realmId }).lean();
  const b2 = realm?.thirdParties?.b2;
  return billStorage.isEnabled(b2) ? (b2 as billStorage.B2Config) : null;
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
    tryRecapture: _tryRecapture,
    archiveSource: _archiveSource,
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
      // Telegram returns updates ascending, but sort defensively — the
      // contiguous-prefix commit below relies on order.
      updates.sort((a, b) => a.update_id - b.update_id);

      // Contiguous-prefix commit: advance the offset only across the run of
      // updates handled successfully from the start. On a failure we STOP and
      // leave that update (and everything after it) for the next tick, so a
      // transient error (mongo blip, file API hiccup) NEVER loses a bill — it
      // retries. A genuinely poison update would otherwise wedge the queue, so
      // after MAX_UPDATE_RETRIES consecutive failures we skip past it.
      let committed = last;
      for (const u of updates) {
        try {
          const handled = await _handleUpdate(realm, u, deps);
          if (handled === 'ingested') result.ingested++;
          else result.skipped++;
          committed = u.update_id;
          _updateRetries.delete(_retryKey(realm.realmId, u.update_id));
        } catch (err: any) {
          result.errors++;
          const key = _retryKey(realm.realmId, u.update_id);
          const fails = (_updateRetries.get(key) || 0) + 1;
          logger.error(
            `telegram-inbox: update ${u.update_id} (realm ${realm.realmId}) failed (attempt ${fails}/${MAX_UPDATE_RETRIES}): ${err?.message || err}`
          );
          if (fails >= MAX_UPDATE_RETRIES) {
            // Poison — skip past it so the queue isn't wedged forever, then
            // keep processing the rest of the batch.
            logger.error(
              `telegram-inbox: update ${u.update_id} (realm ${realm.realmId}) exhausted retries — SKIPPING (bill lost; check the source chat)`
            );
            _updateRetries.delete(key);
            committed = u.update_id;
            continue;
          }
          // Transient — retry this + all later updates next tick.
          _updateRetries.set(key, fails);
          break;
        }
      }
      if (committed > last) {
        await deps.setOffset(realm.realmId, committed);
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

  // Tier-2 re-capture: if the open receipt dialog is WAITING for a re-shot of a
  // failed RF/IBAN for this realm, THIS photo is that re-shot — recover the
  // field and consume the message (do NOT ingest it as a new bill). Reply
  // ACCURATELY: only claim success when a checksum-valid key was actually read;
  // otherwise tell the user the re-shot wasn't legible so they can retry.
  if (deps.tryRecapture) {
    const outcome = await deps.tryRecapture(realm, file.buffer);
    if (outcome === 'recovered') {
      await deps.sendReply?.(
        realm.botToken,
        msg.chat.id,
        'Ελήφθη — ο κωδικός ενημερώθηκε στην ανοιχτή φόρμα.'
      );
      return 'skipped';
    }
    if (outcome === 'failed') {
      await deps.sendReply?.(
        realm.botToken,
        msg.chat.id,
        'Ελήφθη, αλλά ο κωδικός δεν διαβάστηκε καθαρά. Δοκιμάστε πιο κοντινή φωτογραφία ή πληκτρολογήστε τον χειροκίνητα στη φόρμα.'
      );
      return 'skipped';
    }
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
          : undefined,
        // Carry the OCR text so the confirmed Bill stores it (capped, matching
        // the upload lane). WITHOUT this a Telegram-imported bill has empty
        // ocrText → parsePaymentReceipts rebuilds an empty token bag → the
        // soft-TF-IDF name/amount/date matching is DEAD for it (only its strong
        // billingId/RF keys would match). This closes that gap.
        ocrText: (parseResult.rawText || '').slice(0, 4000)
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

  // Archive the source bytes to B2 at ingest (best-effort — a failure returns
  // null and never blocks ingest). We have the buffer here; confirm carries
  // the key onto the Bill's pdfUrl without a re-upload.
  const safeName = fileName || 'telegram-file';
  const sourcePdfUrl = deps.archiveSource
    ? await deps.archiveSource(
        realm,
        `tg-${msg.message_id}`,
        safeName,
        file.buffer
      )
    : null;

  const now = deps.now();
  await deps.createInboxItem({
    realmId: realm.realmId,
    source: 'telegram',
    status: 'pending',
    parsed,
    parseError,
    suggestedMatch,
    warnings: [],
    sourceFileName: safeName,
    telegramMessageId: msg.message_id,
    telegramFileId: fileId,
    sourcePdfUrl: sourcePdfUrl || undefined,
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

// test-only: reset the poison-retry counters between cases.
export function _clearRetries(): void {
  _updateRetries.clear();
}
