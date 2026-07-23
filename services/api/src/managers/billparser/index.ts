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

function detectProvider(text: string): Provider | null {
  for (const { provider, patterns } of PROVIDER_MARKERS) {
    if (patterns.some((p) => p.test(text))) {
      return provider;
    }
  }
  return null;
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
    buffer.length >= 4 &&
    buffer.subarray(0, 4).toString('ascii') === '%PDF';

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
      error: 'Δεν αναγνωρίστηκε ο πάροχος'
    };
  }

  switch (provider) {
    case 'deh':
      return parseDehBill(text);
    case 'eydap':
      return {
        success: false,
        error: 'Ο πάροχος ΕΥΔΑΠ δεν υποστηρίζεται ακόμα'
      };
    case 'epa':
      return {
        success: false,
        error: 'Ο πάροχος ΕΠΑ δεν υποστηρίζεται ακόμα'
      };
    default:
      return {
        success: false,
        error: 'Μη υποστηριζόμενος πάροχος'
      };
  }
}
