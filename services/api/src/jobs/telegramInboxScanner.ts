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
import { classifyDocumentText, DocClass } from '../utils/docclassify.js';
import * as recapture from '../managers/recapturesession.js';
import {
  parseBillPdf,
  looksLikeFullBillText
} from '../managers/billparser/index.js';
import { handleVoiceCommand as _routeVoiceCommand } from './voicecommandhandler.js';
import { extractTextFromPdf as _extractPdfText } from '../managers/pdfimportmanager.js';
import { parseGreekLease as _parseGreekLease } from '../managers/greekleaseparser.js';
import { parseE9 as _parseE9 } from '../managers/e9parser.js';
import { classifyAgainstExisting as _classifyLease } from '../managers/pdfimportmanager.js';
import { recognize as _recognizeVoice } from '../managers/voiceasrclient.js';
import type { VoiceSession } from '../managers/voicesession.js';
import { sweepAbandoned as _sweepAbandonedVoice } from '../managers/voicesession.js';
import { randomUUID } from 'crypto';

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
// Pages the TICK extracts to decide which parser owns a PDF. The AADE lease
// header and the Ε9 markers are both in the document header; the full text is
// extracted again in the worker, where a slow document costs one landlord's
// wait instead of every realm's ingest.
const CLASSIFICATION_PAGES = 2;

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
    billingIdNormalized: string,
    /**
     * Every OTHER identifier the bill printed. Optional so the existing test stubs
     * (`async () => matchResult`) keep type-checking, and because a ΔΕΗ bill has
     * only one number — but a ΕΥΔΑΠ bill prints three and the landlord may have
     * recorded any of them.
     */
    alternateBillingIds?: string[]
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
  createInboxItem: (doc: Record<string, unknown>) => Promise<string>;
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
    buffer: Buffer,
    contentType?: string
  ) => Promise<string | null>;
  /** Acknowledge a message we won't ingest (wrong chat, no file, too big). */
  /** Returns the sent message's id so the ack can later be edited into the result. */
  sendReply?: (
    botToken: string,
    chatId: string | number,
    text: string
  ) => Promise<number | null>;
  /** Rewrite an earlier message; falls back to sending a new one. */
  editReply?: (
    botToken: string,
    chatId: string | number,
    messageId: number | null | undefined,
    text: string
  ) => Promise<void>;
  /**
   * Update an InboxItem in place — used to move it out of 'processing'.
   *
   * Resolves to whether the row was still 'processing' and therefore actually took the
   * patch. The caller MUST NOT assume it did: a discarded update means the landlord
   * dismissed the item, or the sweep released it, and telling them «εκκρεμεί
   * επιβεβαίωση» about a row that no longer says so leaves two surfaces disagreeing.
   */
  updateInboxItem?: (
    id: string,
    patch: Record<string, unknown>
  ) => Promise<boolean>;
  /**
   * Money-command dialogue router (shadow mode). Returns true when the message
   * WAS a voice command and is fully handled — the scanner then stops. Optional
   * so the existing test suite (which never sets it) simply skips the branch.
   * The real implementation is wired in _defaultDeps.
   */
  handleVoiceCommand?: (
    realm: TelegramRealmConfig,
    msg: NonNullable<TgUpdate['message']>
  ) => Promise<boolean>;
  /**
   * Document-orchestrator seams. Optional in the TYPE only — `scanTelegramInbox`
   * merges `{..._defaultDeps(), ...overrides}`, so an omitted seam is the REAL
   * implementation, not a no-op. A test that sends a `.pdf` document and does
   * not inject `extractPdfText` therefore loads pdfjs and runs getDocument on
   * its fixture buffer. (An earlier version of this comment claimed the
   * opposite — "optional so the existing bill-lane tests skip them" — and that
   * false claim is what let the real extractor leak into the ack-protocol
   * suite until it timed out under load.)
   *
   * extractPdfText is the SAME extraction the upload lanes run, called at
   * RECEIPT with CLASSIFICATION_PAGES to route the document, and again in the
   * worker without a cap for the full parse. parseLeaseText / parseE9Text /
   * classifyLease run in the WORKER — pure functions injected so the
   * orchestrator tests need neither pdfjs nor mongo.
   */
  extractPdfText?: (buffer: Buffer, maxPages?: number) => Promise<string>;
  parseLeaseText?: (text: string) => any;
  parseE9Text?: (text: string) => any;
  classifyLease?: (
    parsed: any,
    realmId: string
  ) => Promise<{ kind: string; matchedTenantId: string | null }>;
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
    // Voice note (OGG/Opus) and audio file — the money-command modality.
    voice?: { file_id: string; duration?: number; file_size?: number };
    audio?: { file_id: string; duration?: number; file_size?: number };
    // Plain typed text. A money command may arrive typed, and a dialogue reply
    // (a name, an amount, ναι/όχι) is usually typed even when it started as voice.
    text?: string;
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
async function _findMatch(
  realmId: string,
  billingIdNormalized: string,
  // Every OTHER identifier the bill printed. ΕΥΔΑΠ prints three and the landlord
  // may have recorded any of them; matching only the primary tells them their own
  // bill is unrecognised, with no visible cause.
  alternateBillingIds: string[] = []
) {
  const { resolveBillTarget } = await import('../managers/billmanager.js');
  const resolution = await resolveBillTarget(realmId, [
    billingIdNormalized,
    ...alternateBillingIds
  ]);
  const status = resolution.expenseStatus;
  const expenseHit = resolution.expenseHit;
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
  const shared = { status: resolution.sharedStatus, hit: resolution.sharedHit };
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
  // Two apartments claim this παροχή — say so rather than propose one of them.
  // `single_unit` bills 100% of the amount to the chosen flat, so an arbitrary pick is
  // the entire bill in the wrong place.
  if (resolution.unitStatus === 'ambiguous') return { ambiguous: 'unit' };
  const unit = resolution.unitHit;
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

/** Returns the new row's id: the background parse needs it to finish the row. */
async function _createInboxItem(doc: Record<string, unknown>): Promise<string> {
  const created: any = await Collections.InboxItem.create(doc);
  return String(created?._id || '');
}

/**
 * Finish a row ONLY while it is still 'processing'.
 *
 * The parse runs off the tick, so the landlord can dismiss the item from the bell while it
 * is in flight. An unconditional update would then set it back to 'pending' and resurrect
 * something they explicitly dismissed. Guarding on the current status makes the dismiss
 * win, which is the right precedence: it is the human's decision against a background job.
 */
async function _updateInboxItem(
  id: string,
  patch: Record<string, unknown>
): Promise<boolean> {
  const res = await Collections.InboxItem.updateOne(
    { _id: id, status: 'processing' },
    { $set: { ...patch, updatedDate: new Date() } }
  );
  if (!res.matchedCount) {
    logger.info(
      `telegram-inbox: item ${id} was no longer 'processing' (dismissed while parsing?) — parse result discarded`
    );
    return false;
  }
  return true;
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
  buffer: Buffer,
  /** Telegram's own mime type. Falling back to a filename sniff stored a PDF
   *  whose name lacked the extension as image/jpeg. */
  contentType?: string
): Promise<string | null> {
  // The realm lookup is INSIDE the try. Outside it, a mongo blip here threw out
  // of a function whose whole contract is "best-effort, never blocks ingest" —
  // and the throw propagated into the caller's catch, which discards an ALREADY
  // SUCCESSFUL parse and tells the landlord the analysis failed. Archival must
  // not be able to lose a parse. (Pre-existing on the bill lane; the two import
  // kinds inherited it.)
  try {
    const b2Config = await _b2ConfigForRealm(realm.realmId);
    if (!b2Config) return null;
    const key = billStorage.billObjectKey(
      realm.realmName,
      realm.realmId,
      billLikeId,
      fileName
    );
    const ct =
      contentType ||
      (/\.pdf$/i.test(fileName) ? 'application/pdf' : 'image/jpeg');
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

/**
 * Send a reply and return the sent message's id.
 *
 * The id is what lets the immediate ACK later become the RESULT — one message that
 * changes, rather than an ack the landlord has to scroll past to find the outcome. It
 * returns null on failure because a reply is never worth failing an ingest over: the bill
 * is already recorded and the app's own bell is the durable surface.
 */
async function _sendReply(
  botToken: string,
  chatId: string | number,
  text: string
): Promise<number | null> {
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: chatId, text, disable_web_page_preview: true },
      { timeout: 15_000 }
    );
    return res?.data?.result?.message_id ?? null;
  } catch (err: any) {
    logger.warn(`telegram-inbox: reply failed: ${err?.message || err}`);
    return null;
  }
}

/**
 * Rewrite a message already sent — used to turn «επεξεργάζομαι…» into the outcome.
 *
 * Falls back to a NEW message when the edit fails (the ack may be too old to edit, or
 * never sent because Telegram was briefly unreachable). Silence is the one thing that is
 * not acceptable here: the landlord is waiting on this specific message to change.
 */
async function _editReply(
  botToken: string,
  chatId: string | number,
  messageId: number | null | undefined,
  text: string
): Promise<void> {
  if (messageId) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${botToken}/editMessageText`,
        {
          chat_id: chatId,
          message_id: messageId,
          text,
          disable_web_page_preview: true
        },
        { timeout: 15_000 }
      );
      return;
    } catch (err: any) {
      logger.warn(
        `telegram-inbox: edit of message ${messageId} failed, sending a new one: ${err?.message || err}`
      );
    }
  }
  await _sendReply(botToken, chatId, text);
}

/**
 * EXPORTED so the REAL implementations can be tested, not just the injected
 * stubs. The existing suite passes `findMatch: async () => matchResult`, which
 * exercises the plumbing and is blind to the matcher itself — exactly how this
 * file's hand-copied matcher was free to drift out of step with the upload path
 * for weeks without a single test going red.
 */
/**
 * Is this failure about provider COVERAGE rather than legibility?
 *
 * The parser's coverage refusals are «Δεν αναγνωρίστηκε ο πάροχος», «Ο πάροχος X δεν
 * υποστηρίζεται ακόμα» and «Μη υποστηριζόμενος πάροχος» (billparser/index.ts). For
 * those, re-sending the same bill at full resolution yields the identical error — the
 * document was read fine and the app simply has no parser for it. Matching on the
 * MESSAGE is unlovely, but it is what crosses the boundary: the poller receives a
 * string, and inventing a machine-readable code would mean changing every parser
 * return. If those strings are ever reworded, `providerCoverageMessages` in the parity
 * suite goes red.
 */
/**
 * A parser warning CODE → the Greek sentence the bell shows.
 *
 * The parser emits codes, not prose, so the wording lives with the surface that
 * displays it. Only the codes worth interrupting the landlord for are mapped; an
 * unmapped code returns null and is not rendered, because a warning nobody can act on
 * trains them to dismiss the ones they can.
 */
export function _parserWarningMessage(
  code: string,
  bill: {
    totalAmount?: number;
    chargeableAmount?: number;
    priorBalance?: number;
  }
): string | null {
  const owed = Number(bill?.totalAmount) || 0;
  const chargeable = Number(bill?.chargeableAmount) || 0;
  switch (code) {
    case 'prior-balance-included-in-payable': {
      // The figure the DOCUMENT states. `owed - chargeable` is a different quantity and
      // disagrees with it whenever the subtotal was also overridden. See
      // BillFields.priorBalance.
      const arrears =
        bill?.priorBalance ?? Math.round((owed - chargeable) * 100) / 100;
      return `Ο λογαριασμός περιλαμβάνει ${arrears.toFixed(2)}€ από προηγούμενη περίοδο. Οι ενοικιαστές χρεώνονται μόνο τα ${chargeable.toFixed(2)}€ της τρέχουσας.`;
    }
    case 'breakdown-does-not-sum-to-subtotal':
      return 'Η ανάλυση του λογαριασμού δεν αθροίζει στο μερικό σύνολο — ελέγξτε το ποσό στο έντυπο.';
    // THE TWO THAT CHANGE THE FIGURE. The parser substitutes the itemised sum for the
    // printed ΜΕΡΙΚΟ ΣΥΝΟΛΟ when they disagree, or derives it when the bill prints none, so
    // the amount the tenants are charged is not the number on the paper. Neither code
    // reached any surface — and on THIS lane the amount is rendered read-only, so the
    // landlord could not even have corrected it. Found by a source-derived census of the
    // codes the parsers emit; a hand-maintained list had simply never heard of them.
    case 'subtotal-label-overridden-by-breakdown-sum':
      return `Το τυπωμένο μερικό σύνολο διαφωνεί με τις αναλυτικές γραμμές, οπότε οι ενοικιαστές χρεώνονται το άθροισμα των γραμμών, ${chargeable.toFixed(2)}€. Ελέγξτε το στο έντυπο.`;
    case 'subtotal-derived-from-breakdown':
      return `Ο λογαριασμός δεν αναγράφει μερικό σύνολο για την περίοδο, οπότε οι ενοικιαστές χρεώνονται ${chargeable.toFixed(2)}€, από το άθροισμα των αναλυτικών γραμμών.`;
    case 'breakdown-exceeds-subtotal':
      return 'Μέρος των αναλυτικών γραμμών υπερβαίνει ήδη το αναγραφόμενο μερικό σύνολο — πιθανή λάθος ανάγνωση του ποσού.';
    // The one that costs money if ignored, and on THIS lane the amount is read-only, so
    // the instruction has to be «do it in the app», not «check the figure».
    case 'subtotal-not-read-payable-charged':
      return 'Δεν διαβάστηκε το μερικό σύνολο της περιόδου, οπότε οι ενοικιαστές θα χρεωθούν το συνολικό οφειλόμενο — μαζί με τυχόν προηγούμενες οφειλές. Διορθώστε το ποσό στη δαπάνη πριν το επιβεβαιώσετε.';
    case 'payment-string-does-not-corroborate':
      return 'Ο κωδικός πληρωμής δεν συμφωνεί με τα υπόλοιπα στοιχεία — μην τον σαρώσετε, πληρώστε από το έντυπο.';
    case 'tiers-do-not-sum-to-consumption':
    case 'tier-amounts-do-not-sum-to-charges':
      return 'Η ανάλυση κατανάλωσης δεν συμφωνεί με το σύνολο — πιθανή λάθος ανάγνωση.';
    case 'registry-number-disagrees':
    case 'period-disagrees':
      return 'Δύο σημεία του λογαριασμού δίνουν διαφορετική τιμή για το ίδιο στοιχείο — ελέγξτε το έντυπο.';
    default:
      return null;
  }
}

function _providerNotCovered(message: string | undefined): boolean {
  if (!message) return false;
  return /δεν υποστηρίζεται|Μη υποστηριζόμενος|Δεν αναγνωρίστηκε ο πάροχος/i.test(
    message
  );
}

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
    sendReply: _sendReply,
    editReply: _editReply,
    updateInboxItem: _updateInboxItem,
    extractPdfText: _extractPdfText,
    parseLeaseText: _parseGreekLease,
    parseE9Text: _parseE9,
    classifyLease: _classifyLease,
    handleVoiceCommand: (realm, msg) =>
      _routeVoiceCommand(realm, msg, {
        now: () => new Date(),
        newId: () => randomUUID(),
        downloadFileById: async (botToken, fileId) => {
          const f = await _downloadFile(botToken, fileId);
          return f ? f.buffer : null;
        },
        recognize: _recognizeVoice,
        peopleForRealm: _peopleForRealm,
        sendReply: _sendReply,
        saveSample: _saveVoiceSample,
        sampleExists: async (realmId, messageId) =>
          !!(await Collections.InboxItem.exists({
            realmId,
            kind: 'voiceCommand',
            telegramMessageId: messageId
          }))
      })
  };
}

/**
 * Persist every timed-out voice dialogue as an 'abandoned' sample. Called on
 * the 60s tick. sweepAbandoned removes the sessions from memory as it returns
 * them, so a persist failure loses only that one sample, never loops.
 */
async function _sweepAbandonedVoiceSessions(): Promise<void> {
  // Per-item catch: sweepAbandoned has ALREADY removed every returned session
  // from memory, so if the first persist threw and propagated, every later
  // realm's sample would be lost with it (they can never be swept again). One
  // failure logs and the loop continues — matching this function's own comment.
  for (const session of _sweepAbandonedVoice(Date.now())) {
    try {
      await _saveVoiceSample(session);
    } catch (err: any) {
      logger.error(
        `telegram-inbox: failed to persist abandoned voice sample for realm ${session.realmId}: ${err?.message || err}`
      );
    }
  }
}

/** Tenants of a realm as {id, name}, for fuzzy person matching in the dialogue. */
async function _peopleForRealm(
  realmId: string
): Promise<{ id: string; name: string }[]> {
  const tenants: any[] = await Collections.Tenant.find({ realmId })
    .select('_id name')
    .lean();
  return tenants
    .filter((t) => t?.name)
    .map((t) => ({ id: String(t._id), name: String(t.name) }));
}

/**
 * Persist a completed dialogue as a validation SAMPLE — kind 'voiceCommand',
 * status mirrors the outcome. This is the ONLY thing a finished dialogue does;
 * there is deliberately no call into any money manager (shadow mode). The row
 * is the dataset that will decide whether voice is ever allowed to act.
 */
async function _saveVoiceSample(
  session: VoiceSession,
  terminalMessageId?: number
): Promise<void> {
  const s = session.slots;
  const statusOf: Record<string, string> = {
    validated: 'validated',
    rejected: 'dismissed',
    abandoned: 'abandoned'
  };
  await Collections.InboxItem.create({
    realmId: session.realmId,
    source: 'telegram',
    kind: 'voiceCommand',
    status: statusOf[session.outcome || 'abandoned'] || 'abandoned',
    // Keys the re-delivery dedup (finding 2). Absent for a swept-abandoned
    // dialogue (no single terminal message) — that row is written once by the
    // sweep and never re-delivered, so it needs no key.
    ...(terminalMessageId != null
      ? { telegramMessageId: terminalMessageId }
      : {}),
    voiceCommand: {
      intent: s.intent,
      personId: s.person?.id,
      personName: s.person?.name,
      personConfidence: s.person?.confidence,
      amount: s.amount?.value,
      amountSource: s.amount?.source,
      month: s.month,
      transcript: session.transcript,
      telegramFileIds: session.fileIds,
      decodes: session.decodes,
      corrections: session.corrections,
      outcome: session.outcome
    },
    // Use createdDate — a DECLARED path that carries the TTL index. The bill
    // lane's "received" timestamp field is undeclared on this schema, so
    // mongoose strict would silently drop it (the chargeableAmount incident, in
    // this file's own schema comments) and the sample would have no creation
    // timestamp at all.
    createdDate: new Date(),
    updatedDate: new Date()
  });
}

// --- Core scan (exported for unit tests) ------------------------------------

// The charge month comes from the ONE shared rule (common/utils/billterm) — the
// month the bill was ISSUED, not the end of the period it measures. This file used
// to carry its own byte-identical copy, so the bot lane and the upload lane each
// decided the charge month independently.

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
              if (
                mid != null &&
                !(await deps.hasInboxItem(realm.realmId, mid))
              ) {
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

  // MONEY-COMMAND DIALOGUE (shadow mode), before anything else. It claims a
  // message when: a dialogue is already open for this realm (any modality is
  // its reply), OR this is a voice/audio message, OR it is text matching a
  // money intent. Returning true means fully handled — do not also treat it as
  // a bill. Bills (document/photo) never match a money intent, so they fall
  // through untouched.
  if (deps.handleVoiceCommand) {
    const claimed = await deps.handleVoiceCommand(realm, msg);
    if (claimed) return 'skipped';
  }

  // Pick the file: document as-is; photo → the largest rendition (last entry).
  let fileId: string | undefined;
  let fileName: string | undefined;
  let mimeType: string | undefined;
  if (msg.document?.file_id) {
    fileId = msg.document.file_id;
    fileName = msg.document.file_name;
    mimeType = msg.document.mime_type;
  } else if (msg.photo?.length) {
    // Telegram sends several sizes of the same photo and OCR quality depends
    // entirely on getting the LARGEST. Taking the last element relies on the array
    // being ascending — which it conventionally is, but the API does not promise it,
    // and picking a thumbnail would produce an unreadable bill with no error: the
    // parse would simply fail and the landlord would be told to take a better photo.
    // Choose by declared size, falling back to the last element when Telegram omits
    // file_size.
    const sizes = msg.photo;
    const largest = sizes.reduce(
      (best, cur) =>
        (cur.file_size ?? -1) > (best.file_size ?? -1) ? cur : best,
      sizes[sizes.length - 1]
    );
    fileId = largest.file_id;
    fileName = `photo-${msg.message_id}.jpg`;
    mimeType = 'image/jpeg';
  }
  if (!fileId) {
    // TEXT-ONLY. Dropped in total silence until now, so a landlord who typed
    // «καταβολή 500 στον Παπαδόπουλο» got nothing back and had no way to learn the bot
    // does not read text yet. Answering costs one API call and tells the truth about the
    // boundary. This is also the seam for a future message KIND: when text becomes
    // actionable, it branches here rather than needing this gate unpicked.
    await deps.sendReply?.(
      realm.botToken,
      msg.chat.id,
      'Έλαβα το μήνυμα, αλλά προς το παρόν διαβάζω μόνο λογαριασμούς που στέλνετε ως αρχείο ή φωτογραφία. Για καταβολές και άλλες κινήσεις χρησιμοποιήστε την εφαρμογή.'
    );
    return 'skipped';
  }

  // Dedup (unique index is the backstop; this avoids the duplicate-key noise).
  if (await deps.hasInboxItem(realm.realmId, msg.message_id)) return 'skipped';

  const file = await deps.downloadFile(realm.botToken, fileId);
  if (!file) {
    await deps.sendReply?.(
      realm.botToken,
      msg.chat.id,
      // MUST NOT say «send a photo». The other two replies tell the landlord to send
      // the bill as a FILE, because Telegram compresses photos to ~1280px and a
      // compressed bill often cannot be read. This reply fires when a FILE was
      // refused — so telling them to fall back to a photo closed a LOOP: parse fails
      // → "send a file" → file over 6MB → "send a photo" → compressed → parse fails.
      // State the limit and how to get under it, and be honest that the photo
      // fallback costs resolution instead of presenting it as the remedy.
      'Το αρχείο δεν μπόρεσε να ληφθεί (πάνω από 6MB ή μη διαθέσιμο). Στείλτε το ως ΑΡΧΕΙΟ έως 6MB — αν είναι μεγαλύτερο, σαρώστε το σε χαμηλότερη ποιότητα ή στείλτε μία σελίδα τη φορά. Φωτογραφία επίσης δουλεύει, αλλά το Telegram τη συμπιέζει και συχνά δεν διαβάζεται.'
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
        // Same reason: a closer PHOTO still gets compressed to ~1280px. The file
        // route is the one that actually raises the resolution.
        'Ελήφθη, αλλά ο κωδικός δεν διαβάστηκε καθαρά. Στείλτε το ως ΑΡΧΕΙΟ (συνημμένο) αντί για φωτογραφία, ή πληκτρολογήστε τον κωδικό χειροκίνητα στη φόρμα.'
      );
      return 'skipped';
    }
  }

  // ── ACK NOW, PARSE LATER ───────────────────────────────────────────────────────
  // Everything above is fast (an in-memory session check, a file download). Everything
  // below — OCR at up to ~50s per page — used to run HERE, awaited inside the poll tick,
  // which had three consequences: the landlord waited up to 60s for the tick plus the
  // whole parse before hearing anything at all; the bell had nothing to show because the
  // row was created only afterwards; and the single-flight guard meant one multi-page PDF
  // blocked every other realm's messages behind it.
  //
  // So: acknowledge immediately, write the row as 'processing' so the bell can render it,
  // and let the parse finish on its own. The ack's message id is stored on the row and the
  // parse EDITS that same message into the outcome — one message that changes, rather than
  // an ack the landlord must scroll past to find the result.
  // Computed here now (it was declared inside the parse block, which has moved into the
  // worker and therefore no longer sees `fileName`).
  const safeName = fileName || 'telegram-file';

  // ── DOCUMENT ORCHESTRATOR: classify a PDF before the row exists ─────────────────
  // A PDF sent to the bot is a bill, a μισθωτήριο, or an Ε9 — three lanes that already
  // exist. The routing decision happens HERE, at receipt, because the row's `kind` is
  // what the bell's processing card names («Διαβάζω τον λογαριασμό…» vs «…το
  // μισθωτήριο…»), and kind is immutable once written. Classification needs the text,
  // and pdfjs text-layer extraction is tick-cheap (~50ms/page for AADE PDFs; a SCANNED
  // bill PDF has no text layer, extracts to ~nothing in milliseconds, and falls through
  // to the bill lane — which is exactly where a scan belongs, its OCR runs in the
  // worker). Photos and non-PDF files never classify: bills are the only thing
  // photographed. Extraction failure = 'bill', never a dropped message.
  const isPdfDocument =
    !!msg.document &&
    (/\.pdf$/i.test(safeName) || msg.document.mime_type === 'application/pdf');
  let docClass: DocClass = 'bill';
  if (isPdfDocument && deps.extractPdfText) {
    try {
      // CLASSIFICATION_PAGES, not the whole document. This await sits on the
      // poll tick, ahead of the ack and the 'processing' row, so its cost is
      // paid before the landlord or the bell can see anything and — behind the
      // poller's re-entrancy guard — by every other realm too. The markers are
      // in the header, so two pages decide it; the worker re-extracts in full.
      const head = await deps.extractPdfText(file.buffer, CLASSIFICATION_PAGES);
      docClass = classifyDocumentText(head);
    } catch (err: any) {
      logger.warn(
        `telegram-inbox: pdf text extraction failed for ${safeName} (${err?.message || err}) — routing to the bill lane`
      );
    }
  }

  const ackText =
    docClass === 'lease'
      ? 'Ελήφθη το μισθωτήριο — το διαβάζω τώρα…'
      : docClass === 'e9'
        ? 'Ελήφθη το Ε9 — το διαβάζω τώρα…'
        : msg.document
          ? 'Ελήφθη το αρχείο — το διαβάζω τώρα…'
          : 'Ελήφθη η φωτογραφία — τη διαβάζω τώρα…';
  const ackMessageId =
    (await deps.sendReply?.(realm.botToken, msg.chat.id, ackText)) ?? null;

  const receivedAt = deps.now();
  const itemId = await deps.createInboxItem({
    realmId: realm.realmId,
    source: 'telegram',
    status: 'processing',
    kind:
      docClass === 'lease'
        ? 'leaseImport'
        : docClass === 'e9'
          ? 'e9Import'
          : 'bill',
    parsed: {},
    sourceFileName: safeName,
    // Stored so no downstream surface has to guess the type from the filename:
    // a PDF sent with no «.pdf» in its name was archived as image/jpeg and
    // served as octet-stream. For a classified PDF the type is known regardless
    // of what Telegram reported.
    sourceMimeType:
      docClass === 'bill' ? mimeType : mimeType || 'application/pdf',
    telegramMessageId: msg.message_id,
    telegramFileId: fileId,
    ackMessageId: ackMessageId ?? undefined,
    ackChatId: String(msg.chat.id),
    createdDate: receivedAt,
    updatedDate: receivedAt
  });

  // Bounded, single-flight, in-process. A real queue would be a new dependency for one
  // producer; what matters here is that only ONE parse runs at a time (the OCR is the
  // documented OOM risk in this container) and that a full queue degrades visibly rather
  // than silently dropping or ballooning memory with held buffers.
  await enqueueParse({
    realm,
    file,
    msg,
    safeName,
    itemId,
    ackMessageId,
    docClass,
    deps
  });
  return 'ingested';
}

// ── the parse worker ─────────────────────────────────────────────────────────────
/**
 * ONE parse at a time, at most QUEUE_CAP waiting.
 *
 * Why in-process rather than BullMQ: there is a single producer (this poller), the work is
 * idempotent per InboxItem, and a stalled item is recoverable from its own 'processing'
 * status by the sweep below. A queue server would add an operational dependency to buy
 * durability that the sweep already provides.
 *
 * Why the cap: each queued job holds the file's BUFFER in memory. Unbounded queueing of
 * 6MB buffers is how this container OOMs. At the cap the tick applies BACKPRESSURE — it
 * waits for the backlog to drain before queueing more. Slower under load, which is the
 * correct trade when memory is the constraint, and the bill is never lost.
 *
 * WHAT THIS MUST NOT DO, because the first version did: start the job with an un-awaited
 * `void _runParseJob(job)` at the cap. That is not "inline" — it runs CONCURRENTLY with the
 * draining job, so the single moment memory is under pressure was the single moment the
 * concurrency-1 guarantee broke, and a second OCR was launched. Exactly backwards.
 */
const QUEUE_CAP = 4;
/**
 * How long the tick will wait for the backlog before queueing anyway. Generous relative to
 * one parse (~50s/page) and far below the 15min stall sweep, so a genuinely slow queue
 * degrades to "one extra buffer" rather than to a lost bill or a wedged poller.
 */
const BACKPRESSURE_WAIT_MS = 180_000;
type ParseJob = {
  realm: TelegramRealmConfig;
  file: { buffer: Buffer };
  msg: NonNullable<TgUpdate['message']>;
  safeName: string;
  itemId: string;
  ackMessageId: number | null;
  /** Receipt-time routing decision; 'bill' runs the OCR lane unchanged. */
  docClass: DocClass;
  deps: InboxScanDeps;
};
const parseQueue: ParseJob[] = [];
let parseRunning = false;

/**
 * The rows THIS process still owns: queued, or being parsed right now.
 *
 * A row is "stalled" precisely when no live worker owns it, and this is the set of live
 * owners — so the sweep consults it instead of inferring ownership from a timestamp.
 *
 * The timestamp inference was wrong. `updatedDate` is written once, at receipt, and never
 * heartbeated, so it measures how long ago the bill ARRIVED, not how long the work has
 * been silent. Four bills queued behind a 3-page PDF (~50s per page, plus download) can
 * sit for longer than STALE_PROCESSING_MS before their parse even starts, and the sweep
 * would then release a job that was still perfectly alive. The damage compounded: the
 * released row is no longer 'processing', so when the parse DID finish `_updateInboxItem`
 * matched nothing and threw the result away — the bill was read correctly and the landlord
 * was told to enter it by hand.
 *
 * Heartbeating would also work, but it means a write per row per interval to answer a
 * question this process can answer exactly. Note the deliberate asymmetry: after a restart
 * the set is empty, and that is correct, because a row left 'processing' by a dead process
 * genuinely IS stalled — which is what the startup sweep is for.
 */
const ownedItemIds = new Set<string>();

async function enqueueParse(job: ParseJob): Promise<void> {
  if (parseQueue.length >= QUEUE_CAP) {
    logger.warn(
      `telegram-inbox: parse queue at cap (${QUEUE_CAP}) — applying backpressure before queueing item ${job.itemId}`
    );
    // BACKPRESSURE. Waiting here blocks the poll tick, which is the point: it bounds
    // retained buffers at QUEUE_CAP and keeps exactly one parse running. If the wait times
    // out we queue anyway — one extra buffer beats losing the bill, and the row is already
    // 'processing' so the sweep is the backstop either way.
    await _awaitParseQueue(BACKPRESSURE_WAIT_MS).catch((err) =>
      logger.warn(
        `telegram-inbox: backpressure wait gave up (${err?.message || err}); queueing anyway`
      )
    );
  }
  // Claim the row BEFORE it can be seen waiting. Registering it after the push would leave
  // a window in which the sweep sees a 'processing' row that nothing owns.
  ownedItemIds.add(job.itemId);
  parseQueue.push(job);
  // Un-awaited on purpose — this is the handoff. _runParseJob catches everything, so the
  // drain cannot reject.
  void _drainParseQueue();
}

async function _drainParseQueue(): Promise<void> {
  if (parseRunning) return;
  parseRunning = true;
  try {
    while (parseQueue.length) {
      const job = parseQueue.shift();
      if (job) await _runParseJob(job);
    }
  } finally {
    parseRunning = false;
  }
}

async function _runParseJob(job: ParseJob): Promise<void> {
  const { realm, file, msg, safeName, itemId, ackMessageId, deps } = job;
  try {
    if (job.docClass === 'lease' || job.docClass === 'e9') {
      await _parseImportDocAndFinish(job);
    } else {
      await _parseAndFinish(
        realm,
        file,
        msg,
        safeName,
        itemId,
        ackMessageId,
        deps
      );
    }
  } catch (err: any) {
    logger.error(
      `telegram-inbox: parse of item ${itemId} threw: ${err?.message || err}`
    );
    // Leave a row the landlord can see, and tell them. A 'processing' row that never
    // resolves is the absent-representation shape: it reads as "still working" forever.
    // `?? true`: when no updateInboxItem is injected there is no row to disagree with, so
    // the normal sentence is the honest one. A discarded update is the case that must not
    // claim a notification the landlord will not find.
    // Kind-aware: for a lease/Ε9 the remedy is the import dialog, not a δαπάνη.
    const failKind =
      job.docClass === 'lease'
        ? 'leaseImport'
        : job.docClass === 'e9'
          ? 'e9Import'
          : 'bill';
    const landed =
      (await deps
        .updateInboxItem?.(itemId, {
          status: 'pending',
          parseError: `Η ανάλυση απέτυχε απρόσμενα. ${_manualFallback(failKind)}`
        })
        .catch(() => true)) ?? true;
    await deps.editReply?.(
      realm.botToken,
      msg.chat.id,
      ackMessageId,
      landed
        ? `Ελήφθη, αλλά η ανάλυση απέτυχε. Θα το βρείτε στις ειδοποιήσεις. ${_manualFallback(failKind)}`
        : 'Ελήφθη, αλλά η ανάλυση απέτυχε και η καταχώρηση ακυρώθηκε στο μεταξύ. Στείλτε το ξανά αν το χρειάζεστε.'
    );
  } finally {
    // Release ownership on EVERY exit, including the throw above — a leaked id would make
    // the row permanently un-sweepable, which is the same «reading…» forever this whole
    // mechanism exists to prevent.
    ownedItemIds.delete(itemId);
  }
}

/**
 * The lease/Ε9 worker lane — the orchestrator's other half. Same contract as
 * _parseAndFinish: finish the row the tick created (never create a second one),
 * respect a dismiss-while-parsing (updateInboxItem returns false), edit the ack
 * into the outcome, and keep every failure VISIBLE as a parseError row rather
 * than silence.
 *
 * What it deliberately does NOT do: import anything. The row stores the parse
 * so the bell can open the SAME dialog the in-app upload opens (prefilled from
 * this payload); creating tenants/buildings stays behind those dialogs' own
 * endpoints with their own guards. A wrong classification therefore costs a
 * dismiss, never a wrong record.
 */
async function _parseImportDocAndFinish(job: ParseJob): Promise<void> {
  const { realm, file, msg, safeName, itemId, ackMessageId, deps } = job;
  const docKind = job.docClass as 'lease' | 'e9';

  let parsed: any = null;
  let parseError: string | undefined;
  let summary: { title?: string; subtitle?: string; classification?: string } =
    {};

  try {
    // FULL extraction here, not on the tick: a μισθωτήριο runs to several pages
    // and an Ε9 to dozens, and the tick only ever read the header to route.
    const text = deps.extractPdfText
      ? await deps.extractPdfText(file.buffer)
      : '';
    if (docKind === 'lease') {
      parsed = deps.parseLeaseText ? deps.parseLeaseText(text) : null;
      const hasContent =
        parsed &&
        ((parsed.tenants && parsed.tenants.length > 0) ||
          (parsed.properties && parsed.properties.length > 0));
      if (!hasContent) {
        // The receipt-time sniff saw the AADE header but the full parser found
        // neither tenants nor properties — same boundary the upload route 422s
        // on. Honest dead-end, not a silent re-route: a document carrying the
        // lease header IS a lease to a human, and pushing it through bill OCR
        // would produce a garbage «δεν αναγνωρίστηκε ο πάροχος» that misnames
        // the problem.
        parsed = null;
        parseError =
          'Το PDF έχει επικεφαλίδα μισθωτηρίου αλλά δεν διαβάστηκαν στοιχεία μισθωτή/ακινήτου. Εισάγετέ το από την εφαρμογή (Ενοικιαστές → Εισαγωγή PDF).';
      } else {
        const t0 = parsed.tenants?.[0];
        const prop = parsed.properties?.[0];
        // Ingest-time classification is ADVISORY (shown on the card); the
        // dialog recomputes it fresh at open time because tenants change
        // between ingest and open.
        let classification: string | undefined;
        if (deps.classifyLease) {
          try {
            classification = (await deps.classifyLease(parsed, realm.realmId))
              ?.kind;
          } catch (cerr: any) {
            logger.warn(
              `telegram-inbox: lease classification failed (${cerr?.message || cerr}) — card shows no verdict`
            );
          }
        }
        summary = {
          title: [t0?.name, t0?.taxId ? `ΑΦΜ ${t0.taxId}` : '']
            .filter(Boolean)
            .join(' · '),
          subtitle: [
            prop?.address?.street1,
            parsed.totalMonthlyRent
              ? `${parsed.totalMonthlyRent} € / μήνα`
              : '',
            parsed.validityStart && parsed.validityEnd
              ? `${parsed.validityStart}–${parsed.validityEnd}`
              : ''
          ]
            .filter(Boolean)
            .join(' · '),
          classification
        };
      }
    } else {
      parsed = deps.parseE9Text ? deps.parseE9Text(text) : null;
      // Mirror importFromE9's own boundary guards, with its distinct messages —
      // «only land plots» must not read as «nothing found».
      if (!parsed?.owner?.taxId) {
        parsed = null;
        parseError =
          'Το PDF μοιάζει με Ε9 αλλά δεν διαβάστηκαν στοιχεία ιδιοκτήτη. Εισάγετέ το από την εφαρμογή (Κτίρια → Εισαγωγή Ε9).';
      } else if (!parsed.buildings?.length) {
        const landOnly = (parsed.skippedLandPlots || 0) > 0;
        parsed = null;
        parseError = landOnly
          ? 'Το Ε9 περιέχει μόνο γήπεδα/οικόπεδα (ΠΙΝΑΚΑΣ 2) — δεν υπάρχουν κτίρια για εισαγωγή.'
          : 'Δεν βρέθηκαν κτίρια στο Ε9.';
      } else {
        const nUnits = parsed.buildings.reduce(
          (n: number, b: any) => n + (b.units?.length || 0),
          0
        );
        const firstAddr = parsed.buildings[0]?.address?.street1 || '';
        const more = parsed.buildings.length - 1;
        summary = {
          title: `${parsed.buildings.length} ${parsed.buildings.length === 1 ? 'κτίριο' : 'κτίρια'} · ${nUnits} ${nUnits === 1 ? 'μονάδα' : 'μονάδες'}`,
          subtitle: more > 0 ? `${firstAddr} + ${more} ακόμη` : firstAddr
        };
      }
    }
  } catch (err: any) {
    parsed = null;
    parseError = `Η ανάλυση απέτυχε: ${err?.message || err}`;
  }

  // Archive the original — for these kinds it is LOAD-BEARING, not just an
  // audit copy: the dialogs re-use the file at confirm time (the lease dialog
  // persists it to the tenant's documents; the Ε9 confirm re-uploads it). Still
  // best-effort here because the fallback exists: the row keeps telegramFileId
  // and file_id does not expire, so /inbox/:id/original can re-fetch from
  // Telegram when B2 is off.
  const sourcePdfUrl = deps.archiveSource
    ? await deps.archiveSource(
        realm,
        `tg-${msg.message_id}`,
        safeName,
        file.buffer,
        'application/pdf'
      )
    : null;

  const landed = await deps.updateInboxItem?.(itemId, {
    status: 'pending',
    parseError,
    importDoc: parsed
      ? { docKind, parsed, summary }
      : { docKind, parsed: null, summary: {} },
    sourcePdfUrl: sourcePdfUrl || undefined
  });

  if (landed === false) {
    await deps.editReply?.(
      realm.botToken,
      msg.chat.id,
      ackMessageId,
      'Ελήφθη, αλλά η καταχώρηση ακυρώθηκε στο μεταξύ (απορρίφθηκε ή διακόπηκε). Στείλτε το έγγραφο ξανά αν το χρειάζεστε.'
    );
    return;
  }

  const docLabel = docKind === 'lease' ? 'το μισθωτήριο' : 'το Ε9';
  await deps.editReply?.(
    realm.botToken,
    msg.chat.id,
    ackMessageId,
    parseError
      ? `Ελήφθη ${docLabel}, αλλά δεν διαβάστηκε: ${parseError} Θα το βρείτε στις ειδοποιήσεις.`
      : `Ελήφθη ${docLabel}${summary.title ? ` (${summary.title})` : ''} — ανοίξτε τις ειδοποιήσεις της εφαρμογής για έλεγχο και εισαγωγή. Δεν καταχωρήθηκε τίποτα αυτόματα.`
  );
}

/** The OCR/parse/match/archive half — everything that was inline on the poll tick. */
async function _parseAndFinish(
  realm: TelegramRealmConfig,
  file: { buffer: Buffer },
  msg: NonNullable<TgUpdate['message']>,
  safeName: string,
  itemId: string,
  ackMessageId: number | null,
  deps: InboxScanDeps
): Promise<void> {
  // Same pipeline as the import dialog. A parse failure still creates an
  // InboxItem (with parseError) — the landlord must SEE that a bill arrived
  // and could not be read, rather than the message vanishing.
  let parsed: any = {};
  let parseError: string | undefined;
  // Warnings that must reach the bell card. Kept separate from parseError: a bill
  // that PARSED fine can still be attached to a month nobody is charged for, and
  // collapsing the two would make a warning look like a failure (or worse, a
  // failure look like a warning).
  const termWarnings: {
    level: 'warn' | 'block';
    code: string;
    message: string;
  }[] = [];
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
        // What tenants may be charged (ΜΕΡΙΚΟ ΣΥΝΟΛΟ), when the document states it
        // apart from what is OWED. Dropped here, so confirming from the bell split
        // ΠΛΗΡΩΤΕΟ and distributed the landlord's arrears across the tenants. This lane
        // is the WORSE of the two doors for it: the bell renders the amount read-only,
        // so there was not even a manual correction available.
        chargeableAmount: bill.chargeableAmount,
        periodStart: bill.periodStart,
        periodEnd: bill.periodEnd,
        issueDate: bill.issueDate,
        dueDate: bill.dueDate,
        rfCode: bill.rfCode,
        paymentCode: bill.paymentCode,
        // Same anchor as the upload lane: issue month, period end as the fallback.
        proposedTerm: BillTerm.computeChargeTerm(bill),
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
          bill.billingIdNormalized,
          bill.alternateBillingIds || []
        );
        // The bot lane hardcoded `warnings: []`, so the ONE warning the upload lane
        // gives — "this bill's month is outside its expense's active range" — was
        // absent here entirely. That is not cosmetic: when the term is outside the
        // range the rent engine charges the expense for no month at all, so the
        // amount is recorded and lands on NO surface. It happened in live data (a
        // June bill on an expense starting in August: €120 recorded, €0 charged,
        // nothing said). Same shared rule as the upload lane, so the two doors cannot
        // drift again.
        // The parser's own observations, as stable CODES, mapped into the schema shape
        // so the bell can render them. They were computed and dropped: the one that
        // matters most, 'prior-balance-included-in-payable', says ΠΛΗΡΩΤΕΟ carries a
        // balance from an earlier period — precisely the case where charging the wrong
        // figure costs the tenants money. The display surface already existed.
        // The override message states the disagreement AND what was done about it, so the
        // plainer «does not add up» row is a strictly weaker duplicate of it. Suppressed
        // here rather than in the message map, because it depends on the OTHER codes
        // present. Same rule as the upload dialog.
        const codes: string[] = bill.warnings || [];
        const superseded = codes.includes(
          'subtotal-label-overridden-by-breakdown-sum'
        )
          ? new Set(['breakdown-does-not-sum-to-subtotal'])
          : new Set<string>();
        for (const code of codes) {
          if (superseded.has(code)) continue;
          const message = _parserWarningMessage(code, bill);
          if (message) termWarnings.push({ level: 'warn', code, message });
        }
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
              // THE SCHEMA SHAPE, not a bare string. `InboxItem.warnings` is
              // `[{level, code, message}]` (collections/inboxItem.ts:85-91), and
              // pushing a string made mongoose throw «Cast to embedded failed» —
              // which rejects the WHOLE document, so every Telegram bill that earned
              // a warning was DESTROYED instead of merely un-warned. Strictly worse
              // than the defect the warning was added to fix.
              //
              // It survived my own e2e test because a direct mongo insert bypasses
              // mongoose validation, so the spec was green against a shape the
              // application can never produce.
              termWarnings.push({
                level: 'warn',
                code:
                  fit.reason === 'before-start'
                    ? 'bill-term-before-expense-start'
                    : fit.reason === 'after-end'
                      ? 'bill-term-after-expense-end'
                      : 'expense-has-no-start-term',
                message:
                  fit.reason === 'before-start'
                    ? `Η δαπάνη «${exp.name}» ξεκινά τον ${_termLabel(fit.startTerm)}, ενώ ο λογαριασμός αφορά τον ${_termLabel(Number(parsed.proposedTerm))} — δεν θα χρεωθεί σε κανέναν.`
                    : fit.reason === 'after-end'
                      ? `Η δαπάνη «${exp.name}» έληξε τον ${_termLabel(fit.endTerm)}, ενώ ο λογαριασμός αφορά τον ${_termLabel(Number(parsed.proposedTerm))} — δεν θα χρεωθεί σε κανέναν.`
                      : `Η δαπάνη «${exp.name}» δεν έχει μήνα έναρξης — δεν χρεώνεται σε κανέναν μήνα.`
              });
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
  const sourcePdfUrl = deps.archiveSource
    ? await deps.archiveSource(
        realm,
        `tg-${msg.message_id}`,
        safeName,
        file.buffer
      )
    : null;

  // (No `now` here: the row's timestamps were set at receipt, and updateInboxItem stamps
  // updatedDate itself — a second clock read would only invite the two to disagree.)
  // FINISH the row the tick already created — do not create a second one. The tick wrote
  // it as 'processing' with the identifiers; this fills in what the parse learned and moves
  // it to 'pending' so the bell offers it for confirmation. Creating again here would also
  // be rejected outright: {realmId, telegramMessageId} is unique.
  const landed = await deps.updateInboxItem?.(itemId, {
    status: 'pending',
    parsed,
    parseError,
    suggestedMatch,
    warnings: termWarnings,
    sourcePdfUrl: sourcePdfUrl || undefined
  });

  if (landed === false) {
    // The row is gone from under us — dismissed from the bell, or released by the sweep.
    // Editing the ack to «εκκρεμεί επιβεβαίωση» here would send the landlord to a
    // notification that either does not exist or says the opposite, and the figure in that
    // sentence would be one no surface in the app agrees with. Say what actually happened
    // and stop; the parse result has already been discarded by design.
    await deps.editReply?.(
      realm.botToken,
      msg.chat.id,
      ackMessageId,
      'Ελήφθη, αλλά η καταχώρηση ακυρώθηκε στο μεταξύ (απορρίφθηκε ή διακόπηκε). Στείλτε τον λογαριασμό ξανά αν τον χρειάζεστε.'
    );
    return;
  }

  // EDIT the ack rather than sending a second message: the landlord is watching the
  // «το διαβάζω τώρα…» line, and a new message below it leaves two states on screen with
  // no indication which is current.
  await deps.editReply?.(
    realm.botToken,
    msg.chat.id,
    ackMessageId,
    parseError
      ? `Ελήφθη, αλλά δεν διαβάστηκε (${parseError}).${
          // GATE THE HINT ON THE FAILURE KIND. «Send it at full resolution» is only
          // useful when legibility is the problem. When the parser refuses because it
          // does not COVER the provider — «Ο πάροχος ΕΠΑ δεν υποστηρίζεται ακόμα»,
          // «Δεν αναγνωρίστηκε ο πάροχος» — a bit-perfect file produces the
          // byte-identical refusal, so the sentence sent the landlord to Files, made
          // them wait a poll cycle, minted another pending item to dismiss, and
          // returned the same error. Asking for a better file when the file was never
          // the problem is the same unachievable-advice defect as «try a closer photo».
          _providerNotCovered(parseError)
            ? ' Καλύτερη φωτογραφία δεν θα βοηθήσει — καταχωρήστε τον λογαριασμό χειροκίνητα στη δαπάνη.'
            : msg.photo?.length
              ? ' Το Telegram συμπιέζει τις φωτογραφίες — στείλτε το ίδιο αρχείο ως ΑΡΧΕΙΟ (συνημμένο) για πλήρη ανάλυση.'
              : ''
        } Θα το βρείτε στις ειδοποιήσεις για χειροκίνητη καταχώρηση.`
      : `Ελήφθη ο λογαριασμός${parsed.totalAmount ? ` (${parsed.totalAmount}€)` : ''} — εκκρεμεί επιβεβαίωση στις ειδοποιήσεις της εφαρμογής.`
  );
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

/**
 * A 'processing' row that never resolved.
 *
 * The parse runs off the poll tick, so a container restart (deploy, OOM, crash) can leave a
 * row mid-flight. That row is the WORST state to leave behind: it renders as «διαβάζω
 * τώρα…» forever, which reads as progress rather than as failure — the
 * absent-representation shape, where the landlord waits instead of acting.
 *
 * This does NOT retry the parse — and the reason is a design choice, not a platform limit.
 * An earlier version of this comment claimed the file «is not re-fetchable because Telegram's
 * links expire». That is wrong and worth correcting, because it would stop the next reader
 * from implementing the better behaviour: `file_path` expires after about an hour, but
 * `file_id` does not, and the row stores `telegramFileId` — so getFile can mint a fresh link
 * and the parse COULD be retried from here.
 *
 * Not doing it yet, deliberately: a retry inside the sweep needs the realm's bot token and
 * the download path, which makes the sweep a second ingest lane with its own failure modes,
 * and the visible fallback below is already correct rather than merely acceptable. The row
 * becomes 'pending' with an explicit reason — exactly how a parse FAILURE already behaves —
 * so the landlord can enter the bill by hand or re-send it. Worth revisiting if stalls turn
 * out to be common; the data needed is already on the row.
 *
 * STALE_MS is generously above the worst observed parse (a 3-page PDF at ~50s/page plus
 * download) so a slow-but-live job is never mistaken for a dead one.
 */
const STALE_PROCESSING_MS = 15 * 60 * 1000;

/**
 * The bot token for a realm, memoised for the caller's batch. Returns null (and says so
 * once) when the realm no longer has Telegram configured — which is a normal state, not an
 * error: the landlord may have turned the channel off while a row was in flight.
 */
async function _botTokenForRealm(
  realmId: string,
  cache: Map<string, string | null>
): Promise<string | null> {
  if (cache.has(realmId)) return cache.get(realmId) ?? null;
  let token: string | null = null;
  try {
    const realm: any = await Collections.Realm.findOne({ _id: realmId }).lean();
    const tg = realm?.thirdParties?.telegram;
    if (tg?.selected && tg?.botToken) token = Crypto.decrypt(tg.botToken);
  } catch (err: any) {
    logger.warn(
      `telegram-inbox: no bot token for realm ${realmId}: ${err?.message || err}`
    );
  }
  cache.set(realmId, token);
  return token;
}

/**
 * Recovery wording BY KIND. Every failure sentence on this path used to say
 * «καταχωρήστε τον λογαριασμό χειροκίνητα» — record the BILL by hand — which is
 * the wrong instruction for a μισθωτήριο or an Ε9: those are not recorded on a
 * δαπάνη at all, they are imported from Ενοικιαστές / Κτίρια. Telling the
 * landlord to do the impossible is the same unachievable-advice defect as the
 * «send a closer photo» loop this file already documents.
 */
function _manualFallback(kind: string | undefined): string {
  if (kind === 'leaseImport') {
    return 'Εισάγετε το μισθωτήριο από την εφαρμογή (Ενοικιαστές → Εισαγωγή PDF) ή στείλτε το ξανά.';
  }
  if (kind === 'e9Import') {
    return 'Εισάγετε το Ε9 από την εφαρμογή (Κτίρια → Εισαγωγή Ε9) ή στείλτε το ξανά.';
  }
  return 'Καταχωρήστε τον λογαριασμό χειροκίνητα ή στείλτε τον ξανά.';
}

export async function sweepStalledProcessing(
  now: Date = new Date(),
  // Startup passes 0: in a process that has just booted, `ownedItemIds` is empty, so any
  // row still 'processing' was left there by the process that died and is stalled by
  // definition — waiting out the age cutoff would only make the landlord stare at
  // «το διαβάζω τώρα…» for another quarter of an hour. The comment at the call site has
  // always claimed this; without the parameter the code did the opposite.
  staleMs: number = STALE_PROCESSING_MS,
  /**
   * Injected for tests, same reason the scanner takes its deps: without a seam here the
   * sweep reaches api.telegram.org from a unit test — a real outbound call to a third
   * party, on every run, whose only saving grace is that the failure is caught.
   */
  hooks: {
    editReply?: InboxScanDeps['editReply'];
    botTokenFor?: (realmId: string) => Promise<string | null>;
  } = {}
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleMs);
  const candidates: any[] = await Collections.InboxItem.find({
    status: 'processing',
    updatedDate: { $lt: cutoff }
  })
    .limit(50)
    .lean();
  // Never release a row this process is still working on. See `ownedItemIds`.
  const stalled = candidates.filter(
    (item) => !ownedItemIds.has(String(item._id))
  );
  const skipped = candidates.length - stalled.length;
  if (skipped) {
    logger.info(
      `telegram-inbox: sweep left ${skipped} item(s) alone — still queued or parsing here`
    );
  }
  let released = 0;
  // One realm lookup per realm per sweep, not per row: a batch of 50 stalled rows is
  // overwhelmingly one realm's backlog, and each miss costs a Realm read plus an AES
  // decrypt. `null` is cached too, so a realm whose token is gone is not retried 50 times.
  const tokenCache = new Map<string, string | null>();
  for (const item of stalled) {
    // `status: 'processing'` in the FILTER, not just in the find. The find and this write
    // are separate round-trips, and the worker can finish in between: an unconditional
    // update then stamps «η ανάγνωση διακόπηκε» onto a row that parsed perfectly well, and
    // because the bell tests `parseError` before it renders the normal card, a correctly
    // read bill turns into an error card with no confirm button. Same predicate as
    // `_updateInboxItem`, for the same reason.
    const res = await Collections.InboxItem.updateOne(
      { _id: item._id, status: 'processing' },
      {
        $set: {
          status: 'pending',
          parseError: `Η ανάγνωση διακόπηκε (επανεκκίνηση υπηρεσίας). ${_manualFallback(item.kind)}`,
          updatedDate: new Date()
        }
      }
    );
    if (!res.matchedCount) {
      logger.info(
        `telegram-inbox: item ${item._id} finished between the sweep's find and its write — left as it is`
      );
      continue;
    }
    released++;
    logger.warn(
      `telegram-inbox: item ${item._id} was stuck in 'processing' since ${item.updatedDate} — marked pending`
    );
    // TELL THE LANDLORD ON THE MESSAGE THEY ARE LOOKING AT.
    //
    // This is what `ackMessageId`/`ackChatId` are stored FOR, and until now nothing read
    // them back: the worker carried its own copy in memory, so the persisted pair was dead
    // data. The consequence was the same two-surfaces-disagree defect as an unchecked
    // update, just triggered by a restart instead of a dismiss — the row correctly said
    // «η ανάγνωση διακόπηκε», while the Telegram message the landlord was staring at still
    // said «το διαβάζω τώρα…», forever. The in-memory copy cannot help here by definition:
    // the process that held it is the one that died.
    //
    // Best-effort and last: a Telegram failure must not stop the sweep from releasing the
    // remaining rows, and the row is already correct without the edit.
    if (item.ackMessageId && item.ackChatId) {
      const token = hooks.botTokenFor
        ? await hooks.botTokenFor(String(item.realmId))
        : await _botTokenForRealm(String(item.realmId), tokenCache);
      const edit = hooks.editReply ?? _editReply;
      if (token) {
        await edit(
          token,
          item.ackChatId,
          item.ackMessageId,
          `Η ανάγνωση διακόπηκε (επανεκκίνηση υπηρεσίας). Θα το βρείτε στις ειδοποιήσεις. ${_manualFallback(item.kind)}`
        ).catch((err: any) =>
          logger.warn(
            `telegram-inbox: could not update the ack for ${item._id}: ${err?.message || err}`
          )
        );
      }
    }
  }
  if (released) {
    logger.info(`telegram-inbox: released ${released} stalled item(s)`);
  }
  // The COUNT RELEASED, not the count considered. The two differ exactly when a row was
  // skipped or won the race, and reporting the larger number would claim work that did
  // not happen.
  return released;
}

export function startTelegramInboxCron(): void {
  if (pollTimer) return;
  // At startup: anything left 'processing' by the previous process is stalled by
  // definition, so release it before the first poll rather than after 15 minutes. Hence
  // staleMs 0 — with the age cutoff this released nothing for the first quarter of an hour
  // and the sentence above was simply untrue of the code beneath it.
  sweepStalledProcessing(new Date(), 0).catch((err) =>
    logger.error(`telegram-inbox: startup sweep failed: ${err?.message || err}`)
  );
  pollTimer = setInterval(() => {
    sweepStalledProcessing().catch((err) =>
      logger.error(`telegram-inbox: sweep failed: ${err?.message || err}`)
    );
    // Persist timed-out voice dialogues as 'abandoned' samples — the give-up
    // signal the validation dataset needs (gate-8 finding 1). Best-effort; a
    // failure logs and the session is already dropped from memory.
    _sweepAbandonedVoiceSessions().catch((err) =>
      logger.error(`telegram-inbox: voice sweep failed: ${err?.message || err}`)
    );
    runInboxPollOnce().catch((err) => {
      logger.error(
        `telegram-inbox: unexpected rejection: ${err?.message || err}`
      );
    });
  }, POLL_MS);
  pollTimer.unref();
  logger.info('telegram-inbox: 60s poller installed');
}

/**
 * TEST SEAM. The parse is deliberately fire-and-forget, so a test that asserts the finished
 * row has nothing to await. Rather than have every test sleep — a guess that is either
 * flaky or slow — this resolves when the queue is empty and no job is running.
 *
 * Exported for tests only; nothing in production needs it, because production's whole point
 * is not to wait.
 */
export async function _awaitParseQueue(timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (parseQueue.length || parseRunning) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `parse queue did not drain within ${timeoutMs}ms (queued=${parseQueue.length}, running=${parseRunning})`
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
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
