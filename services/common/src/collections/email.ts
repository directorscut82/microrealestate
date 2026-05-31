import { CollectionTypes } from '@microrealestate/types';
import mongoose from 'mongoose';
import Realm from './realm.js';

const EmailSchema = new mongoose.Schema<CollectionTypes.Email>({
  realmId: { type: String, ref: Realm, required: true, index: true },
  templateName: String,
  recordId: String,
  params: {},
  sentTo: String,
  sentDate: Date,
  // 'queued' on successful send (provider accepted), 'failed' when the
  // emailer service threw (provider rejected, missing config, network).
  status: String,
  emailId: String,
  // Optional message captured when the send fails; bounded to 1k chars
  // by the writer to avoid unbounded log payloads in mongo.
  error: String
} as Record<string, unknown>);

EmailSchema.index({ recordId: 1 });
EmailSchema.index({ templateName: 1, recordId: 1 });
EmailSchema.index({ realmId: 1, recordId: 1 });

export default mongoose.model<CollectionTypes.Email>('Email', EmailSchema);
