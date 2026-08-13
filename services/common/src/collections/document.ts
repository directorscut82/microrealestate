import { CollectionTypes } from '@microrealestate/types';
import Lease from './lease.js';
import mongoose from 'mongoose';
import Realm from './realm.js';
import Template from './template.js';
import Tenant from './tenant.js';

const DocumentSchema = new mongoose.Schema<CollectionTypes.Document>({
  realmId: { type: String, ref: Realm, required: true },
  // OWNER ENTITY — exactly one of tenantId / buildingId / propertyId /
  // ownerKey must be set (route-enforced). tenantId+leaseId were historically
  // required; they are now optional so buildings, apartments and owners can hold
  // documents too. Legacy tenant documents are untouched.
  tenantId: { type: String, ref: Tenant },
  leaseId: { type: String, ref: Lease },
  buildingId: { type: String },
  // An APARTMENT's own documents — a private ΔΕΗ/ΕΥΔΑΠ bill, an energy
  // certificate, photos. Distinct from buildingId: those are the κοινόχρηστα
  // papers (permits, common-area invoices). Until this field existed an
  // apartment document had nowhere to be stored, so the property page had no
  // documents surface at all.
  propertyId: { type: String },
  // canonical owner key (m:<memberId> | n:<name>|<taxId>) — a string, not a
  // ref; owners are embedded in buildings, not a collection.
  ownerKey: { type: String },
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
DocumentSchema.index({ realmId: 1, buildingId: 1 });
DocumentSchema.index({ realmId: 1, propertyId: 1 });
DocumentSchema.index({ realmId: 1, ownerKey: 1 });

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
