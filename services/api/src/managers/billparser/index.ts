import { BillParseResult, ParsedBill } from './types.js';
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
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { getDocument } = pdfjs;
  // Disable worker for Node.js environment
  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = '';
  }
  const data = new Uint8Array(buffer);
  const doc = await getDocument({ data, useWorkerFetch: false }).promise;
  let fullText = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    fullText +=
      content.items.map((item: any) => item.str).join(' ') +
      '\n--- PAGE BREAK ---\n';
  }
  return fullText;
}

export async function extractQrImageFromPdf(
  buffer: Buffer
): Promise<Buffer | null> {
  // Extract the first roughly-square small image from page 1.
  // QR/IRIS codes are typically 100-400px squares.
  // Uses sharp (prebuilt, no native deps to install) to encode raw pixels to PNG.
  const sharp = (await import('sharp')).default;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { getDocument, OPS } = pdfjs;

  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = '';
  }

  const data = new Uint8Array(buffer);
  const doc = await getDocument({ data, useWorkerFetch: false }).promise;
  const page = await doc.getPage(1);
  const ops = await page.getOperatorList();

  for (let i = 0; i < ops.fnArray.length; i++) {
    if (
      ops.fnArray[i] === OPS.paintImageXObject ||
      ops.fnArray[i] === OPS.paintJpegXObject
    ) {
      const imgName = ops.argsArray[i][0];
      // In pdfjs v4, objs.get() returns synchronously if loaded
      const imgData = page.objs.has(imgName)
        ? page.objs.get(imgName)
        : null;

      if (
        imgData &&
        imgData.width &&
        imgData.height &&
        Math.abs(imgData.width - imgData.height) < 20 &&
        imgData.width >= 50 &&
        imgData.width <= 500
      ) {
        const { width, height } = imgData;
        const src: Uint8Array | Uint8ClampedArray = imgData.data;
        const channels = src.length === width * height * 3 ? 3 : 4;

        const pngBuffer = await sharp(Buffer.from(src), {
          raw: { width, height, channels }
        })
          .png()
          .toBuffer();

        return pngBuffer;
      }
    }
  }

  return null;
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
