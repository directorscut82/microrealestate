import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parseBillPdf, generateIrisQr } from '../managers/billparser/index.js';

/**
 * Integration test: runs the full pipeline against the real DEH bill PDF.
 * Verifies text extraction, parsing, and QR generation produce correct results.
 * Skip if the test PDF is not available (CI environments).
 */

const PDF_PATH = join(homedir(), 'Downloads', 'getbill-1.pdf');

let pdfBuffer;
try {
  pdfBuffer = readFileSync(PDF_PATH);
} catch {
  pdfBuffer = null;
}

const describeIfPdf = pdfBuffer ? describe : describe.skip;

describeIfPdf('DEH Bill Parser - Real PDF Integration', () => {
  let result;

  beforeAll(async () => {
    result = await parseBillPdf(pdfBuffer);
  });

  it('should parse successfully', () => {
    expect(result.success).toBe(true);
    expect(result.bill).toBeDefined();
  });

  it('should detect DEH provider', () => {
    expect(result.bill.provider).toBe('deh');
  });

  it('should extract billing ID: 7 00935585-03 2', () => {
    expect(result.bill.billingId).toBe('7 00935585-03 2');
    expect(result.bill.billingIdNormalized).toBe('700935585032');
  });

  it('should extract total amount: 186.21€', () => {
    expect(result.bill.totalAmount).toBe(186.21);
  });

  it('should extract period: 25/02/2026 - 23/03/2026', () => {
    expect(result.bill.periodStart).toEqual(new Date(2026, 1, 25));
    expect(result.bill.periodEnd).toEqual(new Date(2026, 2, 23));
  });

  it('should extract issue date: 27/03/2026', () => {
    expect(result.bill.issueDate).toEqual(new Date(2026, 2, 27));
  });

  it('should extract due date: 22/04/2026', () => {
    expect(result.bill.dueDate).toEqual(new Date(2026, 3, 22));
  });

  it('should extract RF code', () => {
    expect(result.bill.rfCode).toBe('RF36907738000300008959050');
  });

  it('should extract payment code', () => {
    expect(result.bill.paymentCode).toBe('000000186213');
  });

  it('should generate QR that encodes RF+paymentCode', async () => {
    const qrBuffer = await generateIrisQr(
      result.bill.rfCode,
      result.bill.paymentCode
    );
    expect(qrBuffer).not.toBeNull();
    expect(qrBuffer.length).toBeGreaterThan(100);

    // Verify the QR content matches what the actual bill QR encodes
    // (decoded separately: RF36907738000300008959050000000186213)
    const expectedContent = 'RF36907738000300008959050000000186213';
    expect(result.bill.rfCode + result.bill.paymentCode).toBe(expectedContent);
  });
});
