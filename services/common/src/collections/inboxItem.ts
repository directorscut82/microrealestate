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
  source: { type: String, enum: ['telegram', 'upload'], required: true },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'dismissed'],
    default: 'pending'
  },
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
// (e.g. offset-persist raced a crash). Sparse so 'upload' items are exempt.
InboxItemSchema.index(
  { realmId: 1, telegramMessageId: 1 },
  { unique: true, sparse: true }
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
