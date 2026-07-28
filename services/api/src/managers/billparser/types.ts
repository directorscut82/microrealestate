export type ParsedBill = {
  provider: 'deh' | 'eydap' | 'epa' | 'other';
  billingId: string;
  billingIdNormalized: string;
  totalAmount: number;
  periodStart: Date;
  periodEnd: Date;
  issueDate?: Date;
  dueDate?: Date;
  rfCode?: string;
  paymentCode?: string;
};

export type BillParseResult = {
  success: boolean;
  bill?: ParsedBill;
  error?: string;
  // Slice 6 — the full raw OCR/text-layer of the source, surfaced so the
  // confirm step can extract the element bag (matchKeys) for receipt matching.
  rawText?: string;
  // Step-7 (recapture-hijack follow-up) — which provider MARKER was recognized
  // in the source, if any. Set even when the provider is recognized but not yet
  // parseable (EYDAP/EPA → success:false), so a caller can tell "this photo IS a
  // utility bill" from "no bill markers found" (a receipt / single-code zoom).
  // Absent when no provider marker matched.
  detectedProvider?: 'deh' | 'eydap' | 'epa';
};

export function normalizeBillingId(id: string): string {
  return id.replace(/[\s\-.]/g, '');
}
