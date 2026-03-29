import { CollectionTypes } from '@microrealestate/types';
import mongoose from 'mongoose';

const EmailSchema = new mongoose.Schema<CollectionTypes.Email>({
  templateName: String,
  recordId: String,
  params: {},
  sentTo: String,
  sentDate: Date,
  status: String,
  emailId: String
});

EmailSchema.index({ recordId: 1 });
EmailSchema.index({ templateName: 1, recordId: 1 });

export default mongoose.model<CollectionTypes.Email>('Email', EmailSchema);
