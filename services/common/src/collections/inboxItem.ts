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
    enum: ['pending', 'confirmed', 'dismissed'],
    default: 'pending'
  },
  // 'bill' (default, legacy docs have no kind) — a parsed bill waiting for
  // confirm/dismiss. 'notice' — a server-composed alert (lease expiry, bill
  // due, deposit unreturned, …) that can only be opened or dismissed; the
  // confirm pipeline rejects it.
  kind: { type: String, enum: ['bill', 'notice'], default: 'bill' },
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
    totalAmount: Number,
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
      expenseName: String
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
