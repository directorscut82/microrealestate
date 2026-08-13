export type ParsedBill = {
  provider: 'deh' | 'eydap' | 'epa' | 'telecom' | 'nova' | 'other';
  billingId: string;
  billingIdNormalized: string;
  /**
   * What is OWED to the utility — the «ΠΛΗΡΩΤΕΟ» figure, prior balance included.
   * This is the payment-tracking number.
   */
  totalAmount: number;
  periodStart: Date;
  periodEnd: Date;
  issueDate?: Date;
  dueDate?: Date;
  rfCode?: string;
  paymentCode?: string;

  /**
   * What may be CHARGED TO TENANTS — this period's own charges («ΜΕΡΙΚΟ ΣΥΝΟΛΟ»),
   * excluding any prior balance.
   *
   * These are two different questions and a bill answers both. `totalAmount` is
   * what the landlord owes; splitting THAT among tenants would bill them the
   * landlord's arrears. Equal to `totalAmount` on a bill with no prior balance,
   * which is the common case — so nothing changes there. Absent when the document
   * states no separate subtotal (ΔΕΗ prints one figure).
   */
  chargeableAmount?: number;

  /**
   * OTHER identifiers printed on the bill that could legitimately be what the
   * landlord recorded on the apartment or the shared meter.
   *
   * ΕΥΔΑΠ prints an ΑΡΙΘΜΟΣ ΛΟΓΑΡΙΑΣΜΟΥ (what you pay with) AND an ΑΡΙΘΜΟΣ
   * ΜΗΤΡΩΟΥ (the permanent registry number). Either is a reasonable thing to have
   * typed into `eydapNumber`, so the matcher must be allowed to try both rather
   * than fail because the landlord chose the other one. Normalised, like
   * `billingIdNormalized`.
   */
  alternateBillingIds?: string[];

  /**
   * Everything else the OCR read, verbatim-ish and provider-shaped.
   *
   * Kept because throwing it away is a decision that cannot be undone later: the
   * source image is archived but re-OCR costs ~60s per page, and the consumption
   * history (meter readings, m³, tariff tiers) is exactly what a landlord needs to
   * tell a leak from a hot summer. Nothing downstream may compute money from
   * these — the money fields above are the contract.
   */
  details?: Record<string, unknown>;

  /**
   * Non-fatal observations about a bill that PARSED. Stable codes, not prose, for
   * the same reason `missingFields` uses codes: the consumer renders them on a
   * localised surface.
   */
  warnings?: string[];
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
  /**
   * WHICH route produced the text: a PDF's own text layer, a rasterised+OCR'd scanned
   * PDF, or an OCR'd image. The card's provenance label needs it, and it is NOT
   * inferable from the payload — `rawText`/`parsed.ocrText` are populated by all three
   * routes, so every attempt to derive it downstream produced a constant (first always
   * «PDF», then always «OCR»).
   */
  textSource?: 'pdf-text' | 'pdf-ocr' | 'image-ocr';
};

export function normalizeBillingId(id: string): string {
  return id.replace(/[\s\-.]/g, '');
}
