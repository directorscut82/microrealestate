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

  const text = await extractTextFromPdf(file.buffer);
  const parsed = parseGreekLease(text);
  res.json(parsed);
}
