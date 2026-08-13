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
import { BillTerm, Collections, Crypto, logger } from '@microrealestate/common';
import axios from 'axios';
import * as billStorage from '../managers/billstorage.js';
import * as recapture from '../managers/recapturesession.js';
import {
  parseBillPdf,
  looksLikeFullBillText
} from '../managers/billparser/index.js';

const POLL_MS = 60_000;
// A Telegram photo of a bill is a few MB. This bound is now DELIBERATELY
// INDEPENDENT of the upload route's per-file cap (routes.ts raised that to 15MB to
// admit a multi-page CamScanner bundle) — the two are different risks: an upload
// is one operator action the landlord is waiting on, whereas the poller ingests
// unattended, one file per message, into a 384MiB container that also holds the
// ~239MB warm OCR session. 6MB comfortably covers a phone photo of a bill and
// keeps a single stray Telegram document from squeezing the OCR heap.
//
// The comment this replaces claimed parity with the upload route ("the same 6MB
// cap"), which stopped being true the moment that cap moved — the same drift that
// let the duplicated matcher below rot. Asserted parity needs a shared constant,
// not a sentence.
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
  /**
   * Find where the bill belongs (→ InboxItem.suggestedMatch). Three shapes:
   *  · a full hit (expense configured): buildingId + expenseId set.
   *  · a partial hit (κοινόχρηστος meter or apartment meter): the building is
   *    known, expenseId is '' so the UI offers «Νέα δαπάνη»; the shared- and
   *    unit-prefixed fields say which kind, so the prefill picks the right
   *    allocation.
   *  · `{ambiguous}`: several candidates claim this παροχή. No target is proposed,
   *    but the card must say THAT rather than «δεν βρέθηκε δαπάνη».
   */
  findMatch: (
    realmId: string,
    billingIdNormalized: string
  ) => Promise<{
    buildingId?: string;
    buildingName?: string;
    expenseId?: string;
    expenseName?: string;
    sharedProvider?: string;
    sharedLabel?: string;
    unitPropertyId?: string;
    unitLabel?: string;
    ambiguous?: string;
  } | null>;
  /** True if this telegramMessageId was already ingested for the realm. */
  hasInboxItem: (
    realmId: string,
    telegramMessageId: number
  ) => Promise<boolean>;
  createInboxItem: (doc: Record<string, unknown>) => Promise<void>;
  /**
   * Tier-2 re-capture (Slice 6 §15). If a recapture session is WAITING for this
   * realm, the next admin-chat photo MAY be a zoomed re-shot of a failed
   * RF/IBAN — NOT a new bill. tryRecapture OCRs the crop, extracts+validates
   * the target field, and resolves the session. Returns:
   *   - false        → no active session, OR the photo is NOT the re-shot
   *                    (predates the session, or parses to a DIFFERENT bill) →
   *                    NOT consumed → normal ingest (the bill is preserved).
   *   - 'recovered'  → consumed AND a checksum-valid key was recovered.
   *   - 'failed'     → consumed (it WAS the re-shot for THIS bill) but no valid
   *                    key was read; the session stays open to retry / type it.
   * `msgDate` (unix seconds, when Telegram provided it) gates out a backlog
   * bill photo sent BEFORE the session opened. Injected for tests.
   */
  tryRecapture?: (
    realm: TelegramRealmConfig,
    buffer: Buffer,
    msgDate?: number
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
    // Unix seconds the message was sent. Used by the recapture correlation to
    // reject a bill photo that predates the open re-capture session (a genuine
    // re-shot is sent AFTER the user presses «send another photo»).
    date?: number;
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

/**
 * Suggest where an ingested bill belongs, by CALLING the canonical matchers
 * rather than reimplementing them.
 *
 * This function used to hold a hand-copied reimplementation of
 * `findExpenseByBillingId`, carrying a comment that asserted "same matching rule
 * as parseBills". That was true on the day it was written (2026-07-25, Slice 4)
 * and silently became false when the upload path learned to compare the 9-digit
 * body of a ΔΕΗ παροχή: a bill photographed to the bot then failed to match an
 * expense the SAME bill matched when uploaded. Duplicated money-routing logic
 * drifts, and a comment claiming parity is what stops the next reader from
 * checking. Both surfaces now share one implementation.
 *
 * Also gains what the copy never had: κοινόχρηστοι (shared) meters. A shared
 * supply is looked up FIRST — as on the upload path — because a shared bill and
 * an apartment's own bill mean opposite things for allocation, and it returns the
 * building WITHOUT an expenseId so the UI offers the create-expense path instead
 * of asserting a match that does not exist yet.
 */
async function _findMatch(realmId: string, billingIdNormalized: string) {
  const { findExpenseMatch, findSharedMeterMatch, findUnitBySupplyNumber } =
    await import('../managers/billmanager.js');
  const { status, hit: expenseHit } = await findExpenseMatch(
    realmId,
    billingIdNormalized
  );
  if (expenseHit) {
    return {
      buildingId: String(expenseHit.building._id),
      buildingName: expenseHit.building.name,
      expenseId: String(expenseHit.expense._id),
      expenseName: expenseHit.expense.name
    };
  }
  // AMBIGUOUS ≠ unmatched. Several expenses claim this παροχή, so the operator
  // must decide; proposing a shared meter here would pre-attribute the bill to
  // weaker evidence than the candidates just refused. Suggest no target — but SAY
  // SO, because the card's only other message is «δεν βρέθηκε δαπάνη», the exact
  // opposite of the truth. A landlord reading that reasonably creates ANOTHER
  // δαπάνη for the same παροχή, which deepens the ambiguity permanently.
  if (status === 'ambiguous') return { ambiguous: 'expense' };
  // No configured δαπάνη. A shared meter still tells us the BUILDING, which is
  // the slow half of what the landlord would otherwise pick by hand. `expenseId`
  // stays empty: InboxBell renders the no-match card (building/expense selects +
  // «Νέα δαπάνη») whenever expenseId is absent, which is exactly the right
  // affordance here. `provider`/`label` ride along so the create-expense prefill
  // can pick the χιλιοστά split a κοινόχρηστο needs (see sharedExpensePrefill).
  const shared = await findSharedMeterMatch(realmId, billingIdNormalized);
  if (shared.hit) {
    return {
      buildingId: shared.hit.buildingId,
      buildingName: shared.hit.buildingName,
      expenseId: '',
      expenseName: '',
      sharedProvider: shared.hit.provider,
      sharedLabel: shared.hit.label || ''
    };
  }
  // Two meters claim this παροχή — suggest no target rather than fall through to
  // the unit tier below, which would propose `single_unit` and bill the building's
  // whole shared supply to one apartment. Reported, not silent (see above).
  if (shared.status === 'ambiguous') return { ambiguous: 'sharedMeter' };
  // THIRD TIER, same order as the upload path (parseBills): a παροχή recorded on
  // an APARTMENT identifies that unit. This is the commonest case — it is how the
  // reported ΔΕΗ bill resolves — and the bot lacked it entirely, so that bill
  // arrived unmatched by Telegram while matching on upload. Tried LAST because a
  // shared meter and a unit meter mean opposite things for allocation, and shared
  // must win.
  const unit = await findUnitBySupplyNumber(realmId, billingIdNormalized);
  if (unit) {
    return {
      buildingId: unit.buildingId,
      buildingName: unit.buildingName,
      expenseId: '',
      expenseName: '',
      unitPropertyId: unit.propertyId,
      unitLabel: unit.unitLabel
    };
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
  buffer: Buffer,
  msgDate?: number
): Promise<false | 'recovered' | 'failed'> {
  const now = Date.now();
  const session = recapture.activeSessionForRealm(realm.realmId, now);
  if (!session) return false;

  // GATES (recapture-hijack HIGH + Step-7 unbound-session follow-up): only
  // consume this photo as the re-shot when
  //   (1) its Telegram timestamp is AFTER the session opened (not a backlog
  //       bill), and
  //   (2) if the session is BOUND to a bill, the photo does not parse to a
  //       DIFFERENT billingId, and
  //   (3) if the session is UNBOUND (the receipt-recapture dialog sends no
  //       billingId — the common case), the photo does NOT parse as a full bill.
  //       A genuine re-shot is a ZOOM of one RF/IBAN line and yields no full
  //       bill; a photo that parses as a whole bill is a NEW bill the user sent
  //       while the dialog was open, which must be INGESTED, not swallowed.
  // A photo failing any gate → return false → normal ingest PRESERVES it (never
  // consumed, its RF never injected). We ALWAYS parse now (both to feed gate 2
  // and to detect the full-bill case for gate 3); the parse result's OCR text
  // is reused for the RF/IBAN extraction below so there is no double-OCR.
  //
  // "Is this a full bill?" (gate-3 signal) is provider-honest (Step-7 rounds 2+3
  // reconciled two opposite regressions):
  //   - DEH is the ONLY provider the app fully parses, and it is what the receipt
  //     dialog corrects. A DEH bill parses to success:true ONLY with a period —
  //     a DEH payment SLIP / RF-line zoom (which prints "ΔΕΗ" next to the code)
  //     has no period → success:false. So use pr.success for DEH: a full DEH
  //     bill is flagged (ingested), a slip/zoom is NOT (correctly treated as the
  //     re-shot — this preserves the recapture happy path, round-3 fix).
  //   - EYDAP/EPA never parse to success (unsupported) but carry an RF, so
  //     pr.success can't protect them; and the app never matches an EYDAP/EPA
  //     RECEIPT (only DEH bills exist), so ANY EYDAP/EPA photo in a DEH-receipt
  //     window is definitionally not the re-shot → flag it via its marker so it
  //     is ingested, not swallowed (round-2 fix).
  // A garbled-OCR DEH bill (no parseable period) or an UNLISTED provider
  // (Elpedison/Protergia/… not in PROVIDER_MARKERS) is neither success nor a
  // known marker — the named-provider gates above miss it. The text-VOLUME
  // backstop (looksLikeFullBillText) catches it provider-agnostically: a full
  // A4 bill OCRs to hundreds of chars, a genuine single-code re-shot to a
  // handful, so a document-sized photo is flagged as a full bill regardless of
  // provider (Step-7 round-4 residual C closed). This makes the gate robust to
  // provider coverage instead of depending on it.
  let parsedBillingId: string | undefined;
  let parsedAsFullBill = false;
  let parsedText: string | undefined;
  try {
    const pr: any = await parseBillPdf(buffer);
    if (typeof pr?.rawText === 'string') parsedText = pr.rawText;
    if (pr?.success && pr.bill?.billingIdNormalized) {
      parsedBillingId = String(pr.bill.billingIdNormalized);
    }
    if (
      pr?.success ||
      pr?.detectedProvider === 'eydap' ||
      pr?.detectedProvider === 'epa' ||
      looksLikeFullBillText(pr?.rawText)
    ) {
      parsedAsFullBill = true;
    }
  } catch {
    // parse failed → likely a pure RF-line zoom (no full bill) → leave
    // parsedAsFullBill false so the gates let the RF/IBAN extraction proceed.
  }
  if (
    !recapture.isRecaptureCandidate(
      session,
      msgDate,
      parsedBillingId,
      parsedAsFullBill
    )
  ) {
    logger.info(
      `telegram-inbox: photo is NOT the re-shot for realm ${realm.realmId} (older than session, a different bill ${parsedBillingId}, or a full bill on an unbound session) — ingesting normally`
    );
    return false;
  }

  try {
    const { extractRFs, extractIBANs } = await import(
      '../managers/billparser/matching.js'
    );
    // Reuse the OCR text from the parse above when present; only OCR again if
    // the parse yielded no text (e.g. it threw before producing rawText).
    let text = parsedText;
    if (text === undefined) {
      const { ocrImage } = await import('../managers/billparser/ocr.js');
      text = await ocrImage(buffer);
    }
    const found =
      session.target === 'rf' ? extractRFs(text) : extractIBANs(text);
    if (found.length) {
      recapture.resolveSession(realm.realmId, found[0], now);
      logger.info(
        `telegram-inbox: recapture recovered ${session.target} for realm ${realm.realmId}`
      );
      return 'recovered';
    }
    // A photo arrived for THIS bill but still no valid key — consume it (it WAS
    // the re-shot, even if it failed) so it isn't mis-ingested as a bill; the
    // session stays waiting until timeout so the user can retry or type it.
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

/**
 * EXPORTED so the REAL implementations can be tested, not just the injected
 * stubs. The existing suite passes `findMatch: async () => matchResult`, which
 * exercises the plumbing and is blind to the matcher itself — exactly how this
 * file's hand-copied matcher was free to drift out of step with the upload path
 * for weeks without a single test going red.
 */
const _GREEK_MONTHS = [
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

/** «2026080100» → «Αύγουστο 2026» (accusative — it follows «τον»). */
function _termLabel(term: number): string {
  const s = String(term ?? '');
  const year = s.slice(0, 4);
  const month = Number(s.slice(4, 6));
  const name = _GREEK_MONTHS[month - 1];
  return name ? `${name} ${year}` : s;
}

export function _defaultDeps(): InboxScanDeps {
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
            // Exhausted retries. Parse failures are already caught upstream and
            // turned into InboxItems, so a throw here is almost always TRANSIENT
            // infra (mongo/Telegram/B2 down), not a genuinely poison message.
            // Advancing the offset would permanently drop the bill after only
            // ~5min of outage (ingress+error-path audit 2026-07). So before we
            // skip, record a VISIBLE placeholder InboxItem — the landlord sees a
            // message arrived that couldn't be processed (matching the
            // parse-failure design), instead of silence. If the placeholder
            // write ALSO fails, mongo is down → transient → do NOT advance;
            // retry next tick. This ties "give up" to "we durably noted it",
            // which is exactly the transient-vs-permanent discriminator.
            const mid = u.message?.message_id;
            try {
              if (mid != null && !(await deps.hasInboxItem(realm.realmId, mid))) {
                const now = deps.now();
                await deps.createInboxItem({
                  realmId: realm.realmId,
                  source: 'telegram',
                  status: 'pending',
                  parsed: {},
                  parseError:
                    'Το μήνυμα ελήφθη αλλά δεν μπόρεσε να επεξεργαστεί μετά από επανειλημμένες προσπάθειες. Ελέγξτε τη συνομιλία.',
                  warnings: [],
                  telegramMessageId: mid,
                  createdDate: now,
                  updatedDate: now
                });
              }
              logger.error(
                `telegram-inbox: update ${u.update_id} (realm ${realm.realmId}) exhausted retries — recorded placeholder InboxItem and SKIPPING`
              );
              _updateRetries.delete(key);
              committed = u.update_id;
              continue;
            } catch (persistErr: any) {
              // Could not persist the placeholder → infra down → transient.
              // Keep the retry count and stop WITHOUT advancing the offset so
              // the bill is preserved for the next tick.
              logger.error(
                `telegram-inbox: update ${u.update_id} placeholder persist failed — treating as transient, NOT skipping: ${persistErr?.message || persistErr}`
              );
              _updateRetries.set(key, fails);
              break;
            }
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
    const outcome = await deps.tryRecapture(realm, file.buffer, msg.date);
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
  // Warnings that must reach the bell card. Kept separate from parseError: a bill
  // that PARSED fine can still be attached to a month nobody is charged for, and
  // collapsing the two would make a warning look like a failure (or worse, a
  // failure look like a warning).
  const termWarnings: string[] = [];
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
        // The bot lane hardcoded `warnings: []`, so the ONE warning the upload lane
        // gives — "this bill's month is outside its expense's active range" — was
        // absent here entirely. That is not cosmetic: when the term is outside the
        // range the rent engine charges the expense for no month at all, so the
        // amount is recorded and lands on NO surface. It happened in live data (a
        // June bill on an expense starting in August: €120 recorded, €0 charged,
        // nothing said). Same shared rule as the upload lane, so the two doors cannot
        // drift again.
        const expenseId = (suggestedMatch as any)?.expenseId;
        const buildingId = (suggestedMatch as any)?.buildingId;
        if (expenseId && buildingId && parsed.proposedTerm) {
          const b: any = await Collections.Building.findOne(
            { _id: buildingId, realmId: realm.realmId },
            { expenses: 1 }
          ).lean();
          const exp = (b?.expenses || []).find(
            (e: any) => String(e._id) === String(expenseId)
          );
          if (exp) {
            const fit = BillTerm.billTermFitsExpense(exp, parsed.proposedTerm);
            if (!fit.fits) {
              termWarnings.push(
                fit.reason === 'before-start'
                  ? `Η δαπάνη «${exp.name}» ξεκινά τον ${_termLabel(fit.startTerm)}, ενώ ο λογαριασμός αφορά τον ${_termLabel(Number(parsed.proposedTerm))} — δεν θα χρεωθεί σε κανέναν.`
                  : fit.reason === 'after-end'
                    ? `Η δαπάνη «${exp.name}» έληξε τον ${_termLabel(fit.endTerm)}, ενώ ο λογαριασμός αφορά τον ${_termLabel(Number(parsed.proposedTerm))} — δεν θα χρεωθεί σε κανέναν.`
                    : `Η δαπάνη «${exp.name}» δεν έχει μήνα έναρξης — δεν χρεώνεται σε κανέναν μήνα.`
              );
            }
          }
        }
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
    warnings: termWarnings,
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
