import { logger, ServiceError } from '@microrealestate/common';
import type { BillParseResult, PartialBillFields } from './types.js';
import { isValidRF } from './matching.js';
import { parseDehBill } from './deh.js';
import { parseEydapBill } from './eydap.js';

export { normalizeBillingId } from './types.js';
export type {
  ParsedBill,
  BillParseResult,
  PartialBillFields
} from './types.js';

type Provider = 'deh' | 'eydap' | 'epa' | 'other';

const PROVIDER_MARKERS: { provider: Provider; patterns: RegExp[] }[] = [
  {
    provider: 'deh',
    patterns: [/ΔΕΗ/i, /dei\.gr/i, /Χρεώσεις\s*[Ππ]ρομήθειας\s*ΔΕΗ/i]
  },
  {
    provider: 'eydap',
    patterns: [/ΕΥΔΑΠ/i, /eydap\.gr/i]
  },
  {
    provider: 'epa',
    patterns: [/Φυσικό Αέριο/i, /epa\.gr/i, /ΔΕΠΑ/i]
  }
];

// Exported (pure) so the recapture gate's "is this a utility bill?" signal is
// unit-testable without a real PDF fixture (Step-7 follow-up). Returns the
// recognized provider marker, or null when the text carries none (a receipt or
// single-code zoom — NOT a full bill).
export function detectProvider(text: string): Provider | null {
  for (const { provider, patterns } of PROVIDER_MARKERS) {
    if (patterns.some((p) => p.test(text))) {
      return provider;
    }
  }
  return null;
}

// Provider-AGNOSTIC "this OCR text is a whole document, not a single-code zoom"
// signal (Step-7 round-4 residual C). detectProvider only covers named
// providers, so a GARBLED DEH scan or an UNLISTED retailer (Elpedison,
// Protergia, HERON, …) whose full bill arrives during an open recapture window
// would slip past the provider gate and be SWALLOWED as the re-shot (silent
// bill loss). A genuine re-shot is a tight zoom of ONE RF/IBAN line → short
// text; a full A4 bill → hundreds of chars across many lines. So text VOLUME
// separates them regardless of provider recognition — and, unlike a marker
// match, a tight code crop that incidentally catches a provider name stays
// short, so this does NOT reintroduce the DEH-slip false-reject the marker
// approach caused (round-3). PAGE_BREAK separators are stripped first (mirrors
// the H3 real-text measure) so they don't inflate the count.
//
// THE BOUNDARY IS DELIBERATELY ASYMMETRIC (Step-7 round-5): any zoom-vs-bill
// threshold has a gray zone (~300-500 chars: a LOOSE re-shot crop of the whole
// payment stub). The two failure directions are not equal —
//   - classifying a sparse/garbled BILL as a zoom SWALLOWS it (silent,
//     money-adjacent loss);
//   - classifying a loose re-shot CROP as a bill fails the recapture (UX only:
//     the photo is preserved as a visible InboxItem, the bot replies, and the
//     dialog's field stays manually editable).
// 300 therefore errs toward bill-preservation: tight spec-compliant zooms
// (~70-250 chars) always pass; a loose stub crop may be false-rejected, which
// is the recoverable direction. Raising the threshold would trade that bounded
// UX annoyance for real silent loss on sparse bills — do not "tune" it upward
// without fixtures proving sparse bills stay above it.
const FULL_BILL_MIN_CHARS = 300;
export function looksLikeFullBillText(text: string | undefined): boolean {
  if (!text) return false;
  const stripped = text.split(PAGE_BREAK).join('').replace(/\s/g, '');
  return stripped.length >= FULL_BILL_MIN_CHARS;
}

// Page separator injected between PDF pages. Also stripped before the
// scanned-PDF emptiness check (H3) so a multi-page image-only PDF isn't judged
// "has text" purely because of N separators (~15 non-space chars each).
export const PAGE_BREAK = '\n--- PAGE BREAK ---\n';

export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(buffer);
    const doc = await getDocument({ data }).promise;
    let fullText = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      fullText +=
        content.items.map((item: any) => item.str).join(' ') + PAGE_BREAK;
    }
    return fullText;
  } catch (err: any) {
    if (err instanceof ServiceError) throw err;
    logger.warn(`Bill PDF parse failed: ${err?.message || err}`);
    throw new ServiceError(
      `Could not parse bill PDF: ${err?.message || 'invalid PDF structure'}`,
      422
    );
  }
}

/**
 * Generate the payment BARCODE PNG for a provider that prints one instead of an IRIS
 * QR — ΕΥΔΑΠ, whose scannable code is the 41-digit run under the barcode to the right
 * of the ΑΠΟΚΟΜΜΑ ΤΑΜΕΙΟΥ.
 *
 * WHY A BARCODE AND NOT A QR HERE. `generateIrisQr` requires an rfCode, and ΕΥΔΑΠ
 * prints none — so a ΕΥΔΑΠ bill card showed no scannable code at all. The QR that IS
 * printed on an ΕΥΔΑΠ bill is not a payment code either: decoding the real one gives
 * `https://epsilondigital-eydap.epsilonnet.gr/fd/<hash>:106`, a link to the e-invoice
 * on the provider's portal, and that hash appears nowhere in the OCR text — so it can
 * never be regenerated, only decoded from the image. The barcode is the payable code,
 * and its content the OCR does read.
 *
 * Code 128 because the string is 41 digits: both Interleaved 2 of 5 and Code 128
 * subset C encode digits in PAIRS, so neither can hold an odd count on its own;
 * bwip-js switches subsets as needed.
 */
export async function generatePaymentBarcode(
  paymentString: string | undefined
): Promise<Buffer | null> {
  if (!paymentString) {
    return null;
  }
  try {
    const bwipjs = (await import('bwip-js')).default;
    return await bwipjs.toBuffer({
      bcid: 'code128',
      text: paymentString,
      scale: 3,
      height: 12,
      // The digits under the bars, exactly as the bill prints them — the landlord
      // reads them off when a scan fails, which is the whole point of a printed code.
      includetext: true,
      textxalign: 'center'
    });
  } catch (error) {
    logger.debug(`barcode generation failed: ${error}`);
    return null;
  }
}

/**
 * Generate IRIS QR code PNG from RF code + payment code.
 * QR content = RF code + payment amount code (verified against real DEH bill).
 * Returns null if either component is missing.
 */
export async function generateIrisQr(
  rfCode: string | undefined,
  paymentCode: string | undefined
): Promise<Buffer | null> {
  if (!rfCode || !paymentCode) {
    return null;
  }
  try {
    const qrContent = rfCode + paymentCode;
    const QRCode = (await import('qrcode')).default;
    return await QRCode.toBuffer(qrContent, {
      type: 'png',
      width: 200,
      margin: 1,
      errorCorrectionLevel: 'M'
    });
  } catch (error) {
    return null;
  }
}

/**
 * Provider-agnostic best-effort field recovery for a document that could NOT be
 * parsed (unknown provider, or a known-but-unimplemented one like ΕΥΔΑΠ).
 *
 * Purely so the operator can SEE what the OCR read and hand-create the έξοδο
 * from it. Strictly diagnostic:
 *  - no `billingId` is guessed — the provision number is provider-specific and a
 *    wrong one would silently match the bill to the wrong expense;
 *  - the amount is taken ONLY from an unambiguous total label. A bill states
 *    several euro figures (per-charge lines, prior balance, VAT), and picking the
 *    largest is exactly the prior-balance double-count trap recorded in
 *    BILL_OCR_INBOX_PLAN §17.5.2 — so if no total label is found, no amount is
 *    reported, and the operator types it from the document.
 */
export function salvageGenericFields(text: string): PartialBillFields {
  const out: PartialBillFields = {};
  if (!text) return out;

  // Total: only from an explicit "amount payable"-class label, same-line or on
  // the immediately following line (the scan layout). Greek decimal comma.
  const AMOUNT = /(\d{1,3}(?:[.\s]\d{3})*|\d+)[,.](\d{2})/;
  //
  // TWO TIERS, and the ORDER IS LOAD-BEARING (adversarial-review finding).
  // ΕΥΔΑΠ prints BOTH «ΜΕΡΙΚΟ ΣΥΝΟΛΟ» (current charges only) and «ΠΛΗΡΩΤΕΟ»
  // (what is actually owed, prior balances included) — and the subtotal comes
  // FIRST in the document. A single alternation scanned top-down therefore
  // returned the SUBTOTAL, so on a bill carrying a prior balance the card showed
  // LESS than the landlord owes; they would type that figure and the difference
  // would leave no trace on any surface. Silent UNDER-reporting reads as correct
  // everywhere (MONEY_SURFACE_MATRIX "absent representation").
  //
  // So: try the PAYABLE labels across the whole document first, and fall back to
  // a subtotal only when no payable label exists at all. §17.5.2's warning about
  // the prior-balance DOUBLE-count still holds — that trap is picking the largest
  // arbitrary figure, which this never does; it reads only labelled values.
  const PAYABLE_LABELS =
    /(?:Συνολικό\s+ποσό\s+πληρωμής|Συνολικ[όο]\s+ποσ[όο]\s+πληρωμ[ήη]ς|ΠΟΣΟ\s+ΠΛΗΡΩΜΗΣ|ΠΛΗΡΩΤΕΟ|Πληρωτέο\s+ποσ[όο]|Συνολικ[όο]\s+ποσ[όο])/i;
  const SUBTOTAL_LABELS = /(?:ΜΕΡΙΚΟ\s+ΣΥΝΟΛΟ)/i;
  const lines = text.split('\n');

  const amountNear = (label: RegExp): number | undefined => {
    for (let i = 0; i < lines.length; i++) {
      if (!label.test(lines[i])) continue;
      const candidates = [lines[i].replace(label, ' ')];
      for (let j = i + 1; j <= i + 2 && j < lines.length; j++) {
        candidates.push(lines[j]);
      }
      for (const c of candidates) {
        // A DOT-formatted date reads as money to the amount pattern:
        // "23.06.2026" yields 23.06 and "1.4.2026" yields 4.2 (found by
        // self-probe). ΔΕΗ and ΕΥΔΑΠ both print dot-dates, and a total label
        // sitting above one would put a DATE in the amount field of the card the
        // operator reads. Strip every date-shaped run before matching.
        const withoutDates = c
          .replace(/\d{1,2}[./]\d{1,2}[./]\d{2,4}/g, ' ')
          .replace(/\d{4}[./]\d{1,2}[./]\d{1,2}/g, ' ');
        const m = withoutDates.match(AMOUNT);
        if (m) {
          const n = parseFloat(`${m[1].replace(/[.\s]/g, '')}.${m[2]}`);
          if (!isNaN(n) && n > 0) return n;
        }
      }
    }
    return undefined;
  };

  out.totalAmount = amountNear(PAYABLE_LABELS) ?? amountNear(SUBTOTAL_LABELS);

  // Dates: report only labelled ones, never a bare date found anywhere.
  const labelledDate = (label: RegExp): Date | undefined => {
    for (let i = 0; i < lines.length; i++) {
      if (!label.test(lines[i])) continue;
      for (let j = i; j <= i + 2 && j < lines.length; j++) {
        // On the label's OWN line take only the text AFTER the label. Using
        // `replace(label,' ')` kept the rest of the line, and the date pattern is
        // unanchored — so on the pdfjs digital path, where a whole page is joined
        // into ONE line, this returned the first date anywhere on the page. On the
        // real ΕΥΔΑΠ bill that reported the ISSUE date (07/05) as the payment
        // DEADLINE, a month early, on the card the operator reads. Same bug and
        // same fix as findLabelledValue in deh.ts.
        let subject: string;
        if (j === i) {
          const hit = lines[i].match(label);
          subject =
            hit && hit.index !== undefined
              ? lines[i].slice(hit.index + hit[0].length)
              : '';
        } else {
          subject = lines[j];
        }
        const m = subject.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (m) {
          const [, d, mo, y] = m;
          const dt = new Date(
            Date.UTC(parseInt(y), parseInt(mo) - 1, parseInt(d))
          );
          // Reject a rolled-over invalid OCR date (e.g. 31/02) rather than
          // reporting a date the document never stated.
          if (
            dt.getUTCFullYear() === parseInt(y) &&
            dt.getUTCMonth() === parseInt(mo) - 1 &&
            dt.getUTCDate() === parseInt(d)
          ) {
            return dt;
          }
        }
      }
    }
    return undefined;
  };
  // NOTE on the 2-line lookahead: it is deliberately too short for a fully
  // COLUMNAR bill. On the real ΕΥΔΑΠ scan, «ΛΗΞΗ ΠΡΟΘΕΣΜΙΑΣ ΠΛΗΡΩΜΗΣ» is
  // followed by three MORE labels before any value, so its date is 4 lines away
  // and this returns undefined — correct, because the first date-shaped line
  // within reach belongs to a different column. Reporting no date beats
  // reporting another field's date. (BILL_OCR_INBOX_PLAN §17.4: ΕΥΔΑΠ needs
  // positional column pairing, which is Slice 3 work, not salvage's job.)
  out.dueDate = labelledDate(
    /(?:ΕΞΟΦΛΗΣΗ\s+ΕΩΣ|Εξόφληση\s+έως|ΛΗΞΗ\s+ΠΡΟΘΕΣΜΙΑΣ(?:\s+ΠΛΗΡΩΜΗΣ)?|ΗΜ\.?\/?ΝΙΑ\s+ΛΗ[ΞΕ]?[ΕΩ]?ΩΣ|Ημερομηνία\s+λήξης)\s*:?/i
  );
  // `ΗΜΝΙΑ` (no slash) and `ΗΜ/ΝΙΑ` both occur in ONE real ΕΥΔΑΠ scan — the OCR
  // drops the slash in the top block and keeps it in the payment stub. The
  // stub's copy sits directly above its value, which is the one this finds.
  out.issueDate = labelledDate(
    /(?:Ημ\.?\/?νία\s+[ΈΕ]κδοσης|ΗΜ\.?\/?ΝΙΑ\s+[ΈΕ]ΚΔΟΣΗΣ|ΗΜΕΡΟΜΗΝΙΑ\s+[ΈΕ]ΚΔΟΣΗΣ|Ημερομηνία\s+[ΈΕ]κδοσης)\s*:?/i
  );

  // RF: only if the ISO-11649 checksum passes — an OCR'd RF with a dropped digit
  // would otherwise be shown as if it were a usable payment reference.
  const rf = text.match(/(RF\d{15,30})/);
  if (rf && isValidRF(rf[1])) out.rfCode = rf[1];

  return out;
}

export async function parseBillPdf(buffer: Buffer): Promise<BillParseResult> {
  let text: string;

  const isPdf =
    buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === '%PDF';

  if (isPdf) {
    text = await extractTextFromPdf(buffer);
    // Scanned / image-only PDF (no text layer — e.g. CamScanner export, which
    // is exactly how many bills arrive). Rasterize each page to an image via
    // pdfium (pure WASM) and OCR every page, joining with the same PAGE BREAK
    // separator the digital multi-page path uses.
    // H3: measure REAL text — strip the injected PAGE BREAK separators first, or
    // an N-page image-only PDF reads as ~15N non-space chars of separator and
    // wrongly skips OCR (a 4+-page scan cleared the old 50-char gate).
    const realTextLen = text
      .split(PAGE_BREAK)
      .join('')
      .replace(/\s/g, '').length;
    if (realTextLen < 50) {
      const { rasterizePdfToImages, ocrImage } = await import('./ocr.js');
      const pages = await rasterizePdfToImages(buffer);
      const pageTexts: string[] = [];
      for (const png of pages) {
        pageTexts.push(await ocrImage(png));
      }
      text = pageTexts.join(PAGE_BREAK);
    }
  } else {
    // Image file (JPEG/PNG/WEBP) — OCR in-process via paddleocr + WASM.
    const { ocrImage } = await import('./ocr.js');
    text = await ocrImage(buffer);
  }

  const provider = detectProvider(text);
  if (!provider) {
    return {
      success: false,
      error: 'Δεν αναγνωρίστηκε ο πάροχος',
      rawText: text,
      // Even with no provider marker, generic money/date/RF shapes are usually
      // readable and are what let the operator create the έξοδο by hand instead
      // of being told only that the parse failed. Measured on the three real
      // NOVA bills, which have no marker in detectProvider at all.
      partial: salvageGenericFields(text)
    };
  }

  switch (provider) {
    case 'deh': {
      // Slice 6 — surface the raw text so the confirm step can build matchKeys.
      const parsed = parseDehBill(text);
      return { ...parsed, rawText: text, detectedProvider: 'deh' };
    }
    case 'eydap': {
      // Slice 3. The two things that kept this branch unimplemented — a ~3-month
      // consumption period and a prior-balance line — are now REPORTED rather than
      // used as reasons to refuse the bill: `warnings` carries
      // 'period-spans-multiple-months' and 'prior-balance-included-in-payable', and
      // `chargeableAmount` (ΜΕΡΙΚΟ ΣΥΝΟΛΟ) is kept apart from `totalAmount`
      // (ΠΛΗΡΩΤΕΟ) so tenants are never split the landlord's arrears.
      //
      // The parser does NOT decide κοινόχρηστος vs ιδιωτικός — that is the
      // matcher's answer, from WHICH list the number is found in (a shared meter
      // → water_common split by χιλιοστά; an apartment → water_private on that
      // unit alone). A parser that guessed would file a whole building's water on
      // one flat, or split one flat's water across the building.
      const parsed = parseEydapBill(text);
      return { ...parsed, rawText: text, detectedProvider: 'eydap' };
    }
    case 'epa':
      return {
        success: false,
        error: 'Ο πάροχος ΕΠΑ δεν υποστηρίζεται ακόμα',
        rawText: text,
        detectedProvider: 'epa',
        partial: salvageGenericFields(text)
      };
    default:
      return {
        success: false,
        error: 'Μη υποστηριζόμενος πάροχος',
        rawText: text,
        partial: salvageGenericFields(text)
      };
  }
}
