import { CollectionTypes } from '@microrealestate/types';
import mongoose from 'mongoose';
import Realm from './realm.js';

const BillSchema = new mongoose.Schema<CollectionTypes.Bill>({
  realmId: { type: String, ref: Realm, required: true },
  buildingId: { type: String, required: true },
  expenseId: { type: String, required: true },
  provider: {
    type: String,
    // Must stay in step with `VALID_PROVIDERS` (billmanager), `ALLOWED_PROVIDERS`
    // (buildingmanager) and SharedMeterSchema. `telecom` is the service the
    // landlord picks; `nova` is the brand the parser reads off a document. Both
    // were accepted everywhere EXCEPT here, so confirming a telecom bill threw a
    // mongoose ValidationError after the OCR had already run.
    enum: ['deh', 'eydap', 'epa', 'telecom', 'nova', 'other'],
    required: true
  },
  billingId: { type: String, required: true },
  // WHAT IS OWED to the provider — the ΠΛΗΡΩΤΕΟ figure, any prior balance included.
  // It is the payment-tracking number: `status` compares Σ(receipts) against it
  // (:paid/:partial), the receipt matcher scores against it, and `remaining` and
  // `overpaid` are derived from it.
  totalAmount: { type: Number, required: true },
  /**
   * WHAT MAY BE CHARGED TO TENANTS — this period's own charges (ΜΕΡΙΚΟ ΣΥΝΟΛΟ),
   * excluding any prior balance. Absent on a bill that states one figure only, which
   * is every ΔΕΗ bill and every bill imported before 2026-08-14.
   *
   * WHY A SECOND COLUMN AND NOT AN EDITED totalAmount. One number was answering two
   * questions. ΕΥΔΑΠ prints both, and the parser has separated them since Slice 3 —
   * but nothing persisted the second one, so the tenant-charge bridge split ΠΛΗΡΩΤΕΟ:
   * on a bill of ΜΕΡΙΚΟ ΣΥΝΟΛΟ 89,94 / ΠΛΗΡΩΤΕΟ 289,94 a 100‰ tenant was billed 28,99
   * instead of 8,99, i.e. the landlord's €200 of arrears distributed across the payers.
   * Correcting it by retyping the amount is not a workaround: the same field is the
   * target `status` compares receipts against, so an 89,94 receipt would mark a 289,94
   * debt as paid.
   *
   * Readers must use `chargeableAmount ?? totalAmount`, so a bill without it behaves
   * exactly as before.
   */
  chargeableAmount: Number,
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
