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

/**
 * The fields a parse RECOVERED, regardless of whether the parse as a whole
 * succeeded. Every member is optional by construction.
 *
 * WHY THIS EXISTS: a parse that cannot satisfy the full `ParsedBill` contract
 * used to return nothing but an error string, discarding fields the OCR had read
 * perfectly well. On 2026-08-09 three real ΔΕΗ bills failed on the παροχή alone
 * while the amount, period, dates and RF were all present and correct — the
 * landlord saw «Δεν βρέθηκε αριθμός παροχής» after 51s and had no way to see or
 * use any of it.
 *
 * This is DIAGNOSTIC/PREFILL data only. It is deliberately a separate type from
 * `ParsedBill` so it can never be mistaken for a complete, ledger-ready bill:
 * nothing downstream may treat a `partial` as chargeable, because the very
 * reason it is partial is that a required field is missing or unreadable.
 */
export type PartialBillFields = {
  billingId?: string;
  billingIdNormalized?: string;
  totalAmount?: number;
  periodStart?: Date;
  periodEnd?: Date;
  issueDate?: Date;
  dueDate?: Date;
  rfCode?: string;
  paymentCode?: string;
  /**
   * STABLE CODES for the fields the parse could not recover — `'billingId'`,
   * `'totalAmount'`, `'period'`. Codes, not prose: the consumer renders them on a
   * localised surface and maps each through its own i18n keys. Emitting Greek
   * literals here put untranslated Greek under a German heading.
   */
  missingFields?: string[];
};

export type BillParseResult = {
  success: boolean;
  bill?: ParsedBill;
  error?: string;
  // Set on a FAILED parse: whatever the parser did manage to read. Never set
  // alongside `bill` — a successful parse's data lives in `bill`.
  partial?: PartialBillFields;
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
