import { CollectionTypes } from '@microrealestate/types';
import mongoose from 'mongoose';
import Realm from './realm.js';

const BillSchema = new mongoose.Schema<CollectionTypes.Bill>({
  realmId: { type: String, ref: Realm },
  buildingId: { type: String, required: true },
  expenseId: { type: String, required: true },
  provider: {
    type: String,
    enum: ['deh', 'eydap', 'epa', 'other'],
    required: true
  },
  billingId: { type: String, required: true },
  totalAmount: { type: Number, required: true },
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  issueDate: Date,
  dueDate: Date,
  term: { type: Number, required: true },
  rfCode: String,
  irisCodeUrl: String,
  pdfUrl: String,
  status: {
    type: String,
    enum: ['pending', 'paid'],
    default: 'pending'
  },
  paymentProofUrl: String,
  paymentDate: Date,
  createdDate: Date,
  updatedDate: Date
});

BillSchema.index({ realmId: 1, buildingId: 1 });
BillSchema.index({ realmId: 1, status: 1 });
BillSchema.index({ realmId: 1, billingId: 1 });
BillSchema.index({ realmId: 1, rfCode: 1 });
BillSchema.index({ realmId: 1, expenseId: 1, term: 1 });

export default mongoose.model<CollectionTypes.Bill>('Bill', BillSchema);
