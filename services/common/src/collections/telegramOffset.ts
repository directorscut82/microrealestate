import { CollectionTypes } from '@microrealestate/types';
import mongoose from 'mongoose';
import Realm from './realm.js';

// One doc per realm: the last Telegram getUpdates update_id the inbox poller
// consumed. Persisted so an api restart resumes from where it left off instead
// of re-ingesting (or worse, skipping) messages. See
// services/api/src/jobs/telegramInboxScanner.ts.
const TelegramOffsetSchema =
  new mongoose.Schema<CollectionTypes.TelegramOffset>({
    realmId: { type: String, ref: Realm, required: true },
    lastUpdateId: { type: Number, required: true, default: 0 },
    updatedDate: Date
  });

TelegramOffsetSchema.index({ realmId: 1 }, { unique: true });

export default mongoose.model<CollectionTypes.TelegramOffset>(
  'TelegramOffset',
  TelegramOffsetSchema
);
