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
        content.items.map((item: any) => item.str).join(' ') +
        '\n--- PAGE BREAK ---\n';
    }
    return fullText;
  } catch (error) {
    throw new Error(`Failed to extract text from PDF: ${String(error)}`);
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
  const text = await extractTextFromPdf(buffer);

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
