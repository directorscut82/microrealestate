import { logger, ServiceError } from '@microrealestate/common';
import { Request, Response } from 'express';
import { parseGreekLease } from './greekleaseparser.js';

async function extractTextFromPdf(buffer: Buffer): Promise<string> {
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

export async function parseImportedPdf(
  req: Request,
  res: Response
): Promise<void> {
  const file = (req as any).file;
  if (!file) {
    res.sendStatus(422);
    return;
  }

  // pdfjs-dist throws "Invalid PDF structure" / "InvalidPDFException" on
  // corrupted or non-PDF input. Without this guard the rejection bubbles
  // up to the global error handler as an opaque 500. Translate to 422 so
  // the client knows the file is unprocessable rather than the server is
  // broken. Any ServiceError already raised inside parsing is rethrown
  // unchanged.
  try {
    const text = await extractTextFromPdf(file.buffer);
    const parsed = parseGreekLease(text);
    // P1.1 / M6: reject non-lease PDFs (e.g. E9 wealth declarations,
    // ΠΕΡΙΟΥΣΙΑΚΗ ΚΑΤΑΣΤΑΣΗ printouts, random Taxisnet receipts) at the
    // server boundary. parseGreekLease returns the empty default shape
    // for any input that lacks the AADE lease section markers; the
    // landlord dialog then crashes on `primaryTenant.name.split` and on
    // `prop.address?.street1` (optional chain on .address, not on prop).
    // 5/16 PDFs in the user's corpus took this path. Better to fail fast
    // here with a recognisable 422 than crash the dialog client-side.
    if (
      (!parsed.tenants || parsed.tenants.length === 0) &&
      (!parsed.properties || parsed.properties.length === 0)
    ) {
      throw new ServiceError(
        'PDF does not appear to be an AADE Taxisnet lease declaration',
        422
      );
    }
    res.json(parsed);
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`PDF parse failed: ${message}`);
    throw new ServiceError(`Could not parse PDF: ${message}`, 422);
  }
}
