import { CollectionTypes } from '@microrealestate/types';
import Lease from './lease.js';
import mongoose from 'mongoose';
import Realm from './realm.js';
import Template from './template.js';
import Tenant from './tenant.js';

const DocumentSchema = new mongoose.Schema<CollectionTypes.Document>({
  realmId: { type: String, ref: Realm, required: true },
  tenantId: { type: String, ref: Tenant, required: true },
  leaseId: { type: String, ref: Lease, required: true },
  templateId: {
    type: String,
    ref: Template,
    required: function (this: CollectionTypes.Document) {
      return this.type === 'text';
    }
  },
  // 'fileDescriptor' is accepted for legacy data
  type: {
    type: String,
    enum: ['text', 'file', 'fileDescriptor'],
    required: true
  },
  name: String,
  description: String,
  mimeType: String, // used only when type === "file"
  expiryDate: Date, // used only when type === "file"
  contents: Object, // used only when type === "text"
  html: String, // used only when type === "text"
  url: String, // used only when type === "file"
  versionId: String, // used only when type === "file"
  createdDate: Date,
  updatedDate: Date
});

DocumentSchema.index({ realmId: 1 });
DocumentSchema.index({ tenantId: 1 });
DocumentSchema.index({ realmId: 1, tenantId: 1 });

DocumentSchema.pre('save', function (next) {
  const now = new Date();
  if (!this.createdDate) {
    this.createdDate = now;
  }
  this.updatedDate = now;
  next();
});

DocumentSchema.pre('findOneAndUpdate', function (next) {
  const update = this?.getUpdate();
  if (!update || !('set' in update)) {
    return next();
  }
  /* @ts-expect-error update is a generic mongoose type, $set existence verified at runtime */
  update.$set.updatedDate = new Date();
  next();
});

export default mongoose.model<CollectionTypes.Document>(
  'Document',
  DocumentSchema
);
