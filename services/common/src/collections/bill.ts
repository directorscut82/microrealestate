import { CollectionTypes } from '@microrealestate/types';
import mongoose from 'mongoose';
import Realm from './realm.js';

const BillSchema = new mongoose.Schema<CollectionTypes.Bill>({
  realmId: { type: String, ref: Realm, required: true },
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
  // O4 (destructive-write audit 2026-07): the total this bill was FIRST created
  // with. Seeded once and never overwritten on a corrective re-import (replace),
  // so a pre-Slice-6 paymentDate-only bill (which records no paid amount) can be
  // re-classified against a STABLE baseline — making the replace idempotent
  // (re-saving the same correction can't flip partial↔paid).
  originalTotalAmount: Number,
  rfCode: String,
  paymentCode: String,
  irisCodeBase64: String,
  irisCodeUrl: String,
  pdfUrl: String,
  status: {
    type: String,
    // 'partial' — some receipts recorded but Σ(receipts) < totalAmount (Slice 6
    // installments). 'paid' — fully covered. 'pending' — nothing recorded.
    enum: ['pending', 'partial', 'paid'],
    default: 'pending'
  },
  // Slice 6 — the raw OCR text captured at bill-confirm (capped). An incoming
  // απόδειξη is matched by rebuilding a soft-TF-IDF token bag from this text
  // (plus the bill's structured strong keys) at match time — see
  // parsePaymentReceipts. This is the single source of truth for matching; a
  // pre-built element bag is deliberately NOT persisted (it would be a lossy
  // partial and could go stale relative to the scorer).
  ocrText: String,
  // Slice 6 — each recorded payment απόδειξη as its own record (installments).
  // The bill is 'paid' only when Σ(receipts.amount) >= totalAmount, else
  // 'partial'. Replaces the single-shot paymentProofUrl overwrite (kept for
  // back-compat / the pre-Slice-6 confirmPayment path).
  receipts: [
    {
      amount: Number,
      date: Date,
      proofUrl: String,
      ocrText: String,
      matchedOn: [String],
      createdDate: Date
    }
  ],
  paymentProofUrl: String,
  paymentDate: Date,
  createdDate: Date,
  updatedDate: Date
});

BillSchema.index(
  { realmId: 1, buildingId: 1, expenseId: 1, term: 1 },
  { unique: true }
);
BillSchema.index({ realmId: 1, status: 1 });
BillSchema.index({ realmId: 1, billingId: 1 });
BillSchema.index({ realmId: 1, rfCode: 1 });

export default mongoose.model<CollectionTypes.Bill>('Bill', BillSchema);
