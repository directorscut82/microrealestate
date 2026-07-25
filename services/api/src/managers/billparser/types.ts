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
};

export function normalizeBillingId(id: string): string {
  return id.replace(/[\s\-.]/g, '');
}
