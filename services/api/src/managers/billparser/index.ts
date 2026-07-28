import { logger, ServiceError } from '@microrealestate/common';
import type { BillParseResult } from './types.js';
import { parseDehBill } from './deh.js';

export { normalizeBillingId } from './types.js';
export type { ParsedBill, BillParseResult } from './types.js';

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
      rawText: text
    };
  }

  switch (provider) {
    case 'deh': {
      // Slice 6 — surface the raw text so the confirm step can build matchKeys.
      const parsed = parseDehBill(text);
      return { ...parsed, rawText: text, detectedProvider: 'deh' };
    }
    case 'eydap':
      // Recognized as a bill (marker matched) but not yet parseable. Carry
      // detectedProvider + rawText so a caller can tell this IS a utility bill
      // — the recapture gate needs that to avoid swallowing it (Step-7), and
      // carrying rawText avoids a redundant second OCR downstream.
      return {
        success: false,
        error: 'Ο πάροχος ΕΥΔΑΠ δεν υποστηρίζεται ακόμα',
        rawText: text,
        detectedProvider: 'eydap'
      };
    case 'epa':
      return {
        success: false,
        error: 'Ο πάροχος ΕΠΑ δεν υποστηρίζεται ακόμα',
        rawText: text,
        detectedProvider: 'epa'
      };
    default:
      return {
        success: false,
        error: 'Μη υποστηριζόμενος πάροχος',
        rawText: text
      };
  }
}
