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
}

export async function extractQrImageFromPdf(
  buffer: Buffer
): Promise<Buffer | null> {
  // QR code extraction from PDF images
  // pdfjs-dist can extract operator list which includes images
  // For now, we extract the first small-ish square image from page 1
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(buffer);
    const doc = await getDocument({ data }).promise;
    const page = await doc.getPage(1);
    const ops = await page.getOperatorList();
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');

    for (let i = 0; i < ops.fnArray.length; i++) {
      if (
        ops.fnArray[i] === OPS.paintImageXObject ||
        ops.fnArray[i] === OPS.paintJpegXObject
      ) {
        const imgName = ops.argsArray[i][0];
        const imgData = await new Promise<any>((resolve) => {
          page.objs.get(imgName, resolve);
        });
        // QR codes are roughly square and relatively small
        if (
          imgData &&
          imgData.width &&
          imgData.height &&
          Math.abs(imgData.width - imgData.height) < 20 &&
          imgData.width >= 50 &&
          imgData.width <= 500
        ) {
          // Convert raw image data to PNG buffer
          const { createCanvas } = await import('canvas');
          const canvas = createCanvas(imgData.width, imgData.height);
          const ctx = canvas.getContext('2d');
          const imageData = ctx.createImageData(
            imgData.width,
            imgData.height
          );

          // pdfjs image data can be RGB or RGBA
          const src = imgData.data;
          const dest = imageData.data;
          if (src.length === imgData.width * imgData.height * 3) {
            // RGB → RGBA
            for (let j = 0; j < imgData.width * imgData.height; j++) {
              dest[j * 4] = src[j * 3];
              dest[j * 4 + 1] = src[j * 3 + 1];
              dest[j * 4 + 2] = src[j * 3 + 2];
              dest[j * 4 + 3] = 255;
            }
          } else {
            // Assume RGBA
            for (let j = 0; j < src.length; j++) {
              dest[j] = src[j];
            }
          }
          ctx.putImageData(imageData, 0, 0);
          return canvas.toBuffer('image/png');
        }
      }
    }
  } catch {
    // QR extraction is best-effort
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
