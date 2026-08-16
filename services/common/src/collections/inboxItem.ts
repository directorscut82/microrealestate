import { CollectionTypes } from '@microrealestate/types';
import mongoose from 'mongoose';
import Realm from './realm.js';

// A bill photo/document that arrived out-of-band (Telegram bot) and was parsed
// server-side. It waits in the landlord's notification bell until confirmed
// (becomes a Bill via the same confirm pipeline as the import dialog) or
// dismissed. Parse failures are kept too (parseError set) so the landlord sees
// that a photo arrived but could not be read, instead of silence.
const InboxItemSchema = new mongoose.Schema<CollectionTypes.InboxItem>({
  realmId: { type: String, ref: Realm, required: true },
  // 'system' — a server-generated notice (kind:'notice'), not an ingested file.
  source: {
    type: String,
    enum: ['telegram', 'upload', 'system'],
    required: true
  },
  status: {
    type: String,
    /**
     * 'processing' — the file has ARRIVED and is being read. Written at receipt, before
     * OCR, so the bell has something to show while a 50s-per-page parse runs. Without it
     * the row appeared only after OCR finished, so pressing the notification mid-parse
     * showed the previous state and the landlord had no way to tell «not received» from
     * «still working».
     *
     * A processing item is NOT confirmable — there is nothing parsed to confirm yet — and
     * inboxmanager.confirm refuses it for the same reason it refuses a 'notice'.
     */
    // voiceCommand adds three: 'awaiting_confirmation' (the dialogue asked
    // «ναι/όχι»), 'validated' (confirmed — a sample, NOT an executed payment),
    // 'abandoned' (dialogue timed out / restart lost the in-memory session).
    enum: [
      'processing',
      'pending',
      'confirmed',
      'dismissed',
      'awaiting_confirmation',
      'validated',
      'abandoned'
    ],
    default: 'pending'
  },
  // 'bill' (default, legacy docs have no kind) — a parsed bill waiting for
  // confirm/dismiss. 'notice' — a server-composed alert (lease expiry, bill
  // due, deposit unreturned, …) that can only be opened or dismissed; the
  // confirm pipeline rejects it.
  // 'voiceCommand' — a money-command dialogue held over Telegram (voice OR
  // text), in SHADOW MODE: the completed row is a validation SAMPLE, never an
  // executed operation. Nothing reads these rows into any money pipeline.
  kind: { type: String, enum: ['bill', 'notice', 'voiceCommand'], default: 'bill' },
  /**
   * kind:'voiceCommand' payload. EVERY sub-path is declared — mongoose strict
   * mode silently DELETES undeclared paths on write (measured 6.13.6: no
   * throw, no warning), which is exactly how parsed.chargeableAmount vanished
   * and the bot lane charged arrears. A field added to the writer without a
   * line here does not exist.
   */
  voiceCommand: {
    type: {
      intent: String, // rentPayment | commonChargesPayment | ownerPayment
      personId: String,
      personName: String,
      personConfidence: Number,
      amount: Number,
      amountSource: String, // 'voice' | 'text'
      month: Number, // 1..12
      // The whole dialogue, for the validation dataset: what was said/typed,
      // in order. Audio itself stays in Telegram (file_id reference) — no
      // voice bytes anywhere near this public repo's backups.
      transcript: [{ text: String, source: String }],
      telegramFileIds: [String],
      // One row per recognizer call — the calibration dataset. The human
      // outcome labels these raw scores; the threshold work (frame-normalized
      // LR, Platt-style calibration) runs over exactly these fields. Without
      // them a sample is a label with no score attached.
      decodes: [
        {
          mode: String, // 'command' | 'amount' | 'yesno' | 'month'
          value: String, // stringified recognized value ('96', 'yes'); null when refused
          p: Number,
          lr: Number,
          nFrames: Number, // post-VAD logit frames scored; null from pre-2026-08-16 containers
          accept: Boolean,
          reason: String,
          ms: Number
        }
      ],
      corrections: Number,
      outcome: String // 'validated' | 'rejected' | 'abandoned'
    },
    default: null
  },
  // kind:'notice' payload. `message` is the server-composed Greek text (same
  // string that goes to Telegram — precedent: the scanner's Telegram literals).
  // `link` is app-relative WITHOUT the org segment ('/tenants/{id}', …, or '').
  notice: {
    type: {
      code: String,
      message: String,
      link: String
    },
    default: null
  },
  // Idempotence for notices: one notice per (realm, condition, window). The
  // scanner re-runs daily; the unique index turns a re-fire into an E11000 the
  // helper swallows. Sparse so bill items (no dedupeKey) are exempt.
  dedupeKey: String,
  parsed: {
    provider: String,
    billingId: String,
    billingIdNormalized: String,
    // What is OWED (ΠΛΗΡΩΤΕΟ, any prior balance included).
    totalAmount: Number,
    /**
     * What may be CHARGED TO TENANTS (ΜΕΡΙΚΟ ΣΥΝΟΛΟ), when the document states it apart
     * from what is owed.
     *
     * WHY THIS LINE IS LOAD-BEARING. It was missing, and mongoose strict mode drops an
     * undeclared sub-path SILENTLY — verified against this repo's mongoose 6.13.6, on both
     * the document path and the updateOne path. So the ΕΥΔΑΠ parser computed 89,94, the
     * scanner wrote it, mongoose deleted it, inboxmanager read undefined, and the bridge
     * fell back to ΠΛΗΡΩΤΕΟ: a 100‰ tenant was billed 28,99 instead of 8,99 — €20 of the
     * landlord's €200 arrears, per tenant, on every bell-confirmed bill.
     *
     * And the bell RENDERED the warning correctly the whole time, because `warnings` IS a
     * declared path — so the screen said «οι ενοικιαστές χρεώνονται μόνο τα 89,94 €» while
     * the confirm charged 289,94. The commit that introduced this said it fixed the split
     * «on both lanes»; the Bill schema had the column and this one did not.
     */
    chargeableAmount: Number,
    periodStart: Date,
    periodEnd: Date,
    issueDate: Date,
    dueDate: Date,
    rfCode: String,
    paymentCode: String,
    proposedTerm: Number,
    ocrText: String
  },
  parseError: String,
  suggestedMatch: {
    type: {
      buildingId: String,
      buildingName: String,
      expenseId: String,
      expenseName: String,
      // Set ONLY when the παροχή matched a building's κοινόχρηστος meter (then
      // expenseId is '' — there is no δαπάνη yet). These two drive the
      // create-expense prefill: a shared bill splits across the building by
      // χιλιοστά, and WHICH vector depends on the utility (gas → heating). An
      // unlisted field is dropped by Mongoose without a word, which is why the
      // prefill previously fell back to an equal split and mis-billed every unit.
      sharedProvider: String,
      sharedLabel: String,
      // Set ONLY when the παροχή is recorded on an APARTMENT (expenseId is ''
      // here too). The prefill then proposes `single_unit` — the whole amount to
      // that flat — instead of splitting it across the building.
      unitPropertyId: String,
      unitLabel: String,
      // 'expense' | 'sharedMeter': several candidates claim this παροχή, so no
      // target is proposed. Recorded because the card's only other message is
      // «δεν βρέθηκε δαπάνη» — the opposite of the truth, and acting on it (create
      // another δαπάνη for the same παροχή) makes the ambiguity permanent.
      ambiguous: String
    },
    default: null
  },
  warnings: [
    {
      level: { type: String, enum: ['block', 'warn'] },
      code: String,
      message: String
    }
  ],
  sourceFileName: String,
  /**
   * The Telegram message id of the bot's own ACK. Kept so the ack can be EDITED into the
   * outcome instead of the landlord receiving two messages and having to work out which
   * one is current.
   */
  ackMessageId: Number,
  /** Chat the ack was sent to — an edit needs both ids. */
  ackChatId: String,
  telegramMessageId: Number,
  telegramFileId: String,
  irisCodeBase64: String,
  // B2 object key of the archived source file (set at ingest — Slice 5).
  sourcePdfUrl: String,
  createdDate: Date,
  updatedDate: Date
});

InboxItemSchema.index({ realmId: 1, status: 1 });
// Dedup guard: the poller must never ingest the same Telegram message twice
// (e.g. offset-persist raced a crash).
//
// partialFilterExpression, NOT `sparse` — the comment here used to claim
// "sparse so 'upload' items are exempt", which is FALSE for a COMPOUND index:
// mongo indexes the doc when AT LEAST ONE key is present, and `realmId` is
// `required`. So every telegramMessageId-less item was indexed as
// {realmId, telegramMessageId: null} and only the FIRST such item per realm
// could exist — the second was rejected with
// `dup key: { realmId: "…", telegramMessageId: null }`.
//
// That was already latent for `source:'upload'` items, and became acute with
// kind:'notice' items (none carry a telegramMessageId): exactly ONE notice per
// realm could ever be inserted, and createNotice swallows E11000 as
// "already exists", so 7 of the 8 notice types would silently never appear.
// Verified against the live mongo 4.4 both ways before this comment was
// written. The partial filter indexes only docs that actually carry the field.
InboxItemSchema.index(
  { realmId: 1, telegramMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: { telegramMessageId: { $type: 'number' } }
  }
);
// Notice dedup: a daily scanner window that already produced its notice hits
// E11000 instead of duplicating — dismissed/confirmed notices keep their key,
// so a dismissed window stays dismissed (it does not resurrect the next day).
//
// partialFilterExpression, NOT `sparse` (unlike the telegramMessageId guard
// above, whose leading key is the optional one). A COMPOUND sparse index
// indexes a document when AT LEAST ONE key is present, and `realmId` is
// `required` — so every kind:'bill' item would be indexed as
// {realmId, dedupeKey: null} and the SECOND bill in a realm would be rejected
// with `dup key: { realmId: "…", dedupeKey: null }`, wedging Telegram ingest
// entirely. Verified against the live mongo 4.4 before this comment was
// written. The partial filter indexes only docs that actually carry a
// string dedupeKey.
InboxItemSchema.index(
  { realmId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } }
);
// D11 — expire PENDING items after 30 days. TTL must be partial: a plain TTL
// index would also delete confirmed/dismissed history. This is the codebase's
// first TTL index (no other expireAfterSeconds precedent).
InboxItemSchema.index(
  { createdDate: 1 },
  {
    expireAfterSeconds: 2592000,
    partialFilterExpression: { status: 'pending' }
  }
);

export default mongoose.model<CollectionTypes.InboxItem>(
  'InboxItem',
  InboxItemSchema
);
