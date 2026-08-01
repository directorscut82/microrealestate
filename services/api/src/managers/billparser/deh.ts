import { BillParseResult, normalizeBillingId } from './types.js';
import { isValidRF } from './matching.js';

function parseGreekAmount(raw: string): number | null {
  // O3 (destructive-write audit 2026-07): last-separator-wins, mirroring
  // matching.parseGreekMoney and the client numberformat.parseGreekMoney, so
  // every amount path parses identically. The OLD logic only normalised when a
  // comma was present, so "1.234" (dot as thousands, no decimal) parsed as
  // 1.234 (÷1000) and "1.234.00" (OCR comma→dot) as 1.234 too. Whichever of
  // '.' / ',' is RIGHTMOST is the decimal separator; the other is thousands.
  const s = raw.replace(/[^\d.,]/g, '');
  if (!s) return null;
  let cleaned: string;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    cleaned = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    // Rightmost is a dot. A single dot with exactly 3 trailing digits and no
    // comma is ambiguous (1.234 = 1234 thousands, NOT 1.234) — treat a lone
    // 3-digit group after a dot as a thousands separator (DEH prints no
    // sub-euro-less totals as "1.234"); otherwise the dot is decimal.
    if (/^\d{1,3}\.\d{3}$/.test(s)) {
      cleaned = s.replace(/\./g, '');
    } else {
      cleaned = s.replace(/,/g, '');
    }
  } else {
    cleaned = s;
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parseGreekDate(raw: string): Date | null {
  // DD/MM/YYYY format — MUST use UTC to avoid the timezone bug (C4):
  // Athens summer (UTC+3) + local Date → periodEnd 01/08 becomes July 31 21:00Z
  // → computeDefaultTerm (which reads getUTCMonth) maps it to the WRONG month.
  const match = raw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  const [, day, month, year] = match;
  const d = parseInt(day);
  const mo = parseInt(month);
  const y = parseInt(year);
  // O8 (destructive-write audit 2026-07): reject calendar-invalid OCR dates
  // rather than let Date.UTC ROLL them over ("31/02/2025" → March 3 → the
  // charge lands in the wrong month). Range-check, then confirm the
  // constructed date's parts round-trip (catches 31/04, 29/02 non-leap, etc.).
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt;
}

export function parseDehBill(text: string): BillParseResult {
  // Extract billing ID - handle both full and abbreviated forms:
  // "Αριθμός παροχής 9 99935585-03 2"
  // "Αρ. παροχής: 9 99935585-03 2"
  // The value class is [\d \t-] (NOT \s): a DEH provision number is a single
  // line of digits/spaces/hyphens. Allowing \s let it cross a newline on the
  // OCR path (page text joined with \n), swallowing the next line's digits
  // into the billing ID. Restrict to spaces/tabs so it stops at the line end.
  const billingIdMatch = text.match(
    /(?:Αριθμός\s+παροχής|Αρ\.?\s*παροχής\s*:?)[ \t]+([\d][\d \t-]+\d)/i
  );
  if (!billingIdMatch) {
    return { success: false, error: 'Δεν βρέθηκε αριθμός παροχής' };
  }
  const billingId = billingIdMatch[1].trim();

  // Extract total amount - try multiple patterns
  let totalAmount: number | null = null;

  // Pattern 1: "Συνολικό ποσό πληρωμής" line
  const totalMatch = text.match(
    /Συνολικό ποσό πληρωμής\s*\*?\s*([\d\s,.]+)\s*€/i
  );
  if (totalMatch) {
    totalAmount = parseGreekAmount(totalMatch[1]);
  }

  // Pattern 2: "ΠΟΣΟ ΠΛΗΡΩΜΗΣ" then "*amount€"
  if (totalAmount === null) {
    const altMatch = text.match(/\*\s*([\d,.]+)\s*€/);
    if (altMatch) {
      totalAmount = parseGreekAmount(altMatch[1]);
    }
  }

  if (totalAmount === null) {
    return { success: false, error: 'Δεν βρέθηκε ποσό πληρωμής' };
  }

  // Extract consumption period
  const periodMatch = text.match(
    /Περίοδος Κατανάλωσης\s+(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/i
  );
  if (!periodMatch) {
    return { success: false, error: 'Δεν βρέθηκε περίοδος κατανάλωσης' };
  }
  const periodStart = parseGreekDate(periodMatch[1]);
  const periodEnd = parseGreekDate(periodMatch[2]);
  if (!periodStart || !periodEnd) {
    return {
      success: false,
      error: 'Μη έγκυρες ημερομηνίες περιόδου κατανάλωσης'
    };
  }

  // Extract issue date
  const issueDateMatch = text.match(/Ημ\/νία Έκδοσης\s+(\d{2}\/\d{2}\/\d{4})/i);
  const issueDate = issueDateMatch
    ? parseGreekDate(issueDateMatch[1])
    : undefined;

  // Extract due date
  const dueDateMatch = text.match(
    /(?:ΕΞΟΦΛΗΣΗ ΕΩΣ|Εξόφληση έως)\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i
  );
  const dueDate = dueDateMatch ? parseGreekDate(dueDateMatch[1]) : undefined;

  // Extract RF code — and VALIDATE its ISO-11649 mod-97 checksum (O5,
  // destructive-write audit 2026-07). A photographed/OCR'd bill can drop or
  // swap an RF digit; the RF + paymentCode are combined into the IRIS payment
  // QR, so a corrupt RF would produce a SCANNABLE QR that sends the landlord's
  // bank transfer to the wrong reference. Reject a checksum-failed RF (leave
  // rfCode undefined → no QR / QR without a bad reference) rather than encode
  // it. The receipt-matching path already validates via isValidRF; this closes
  // the bill-ingest side.
  const rfMatch = text.match(/(RF\d{15,30})/);
  const rfCode = rfMatch && isValidRF(rfMatch[1]) ? rfMatch[1] : undefined;

  // Extract payment amount code (e.g., "000000186,21 3" → "000000186213")
  // This is combined with RF code to form the IRIS QR content
  const paymentCodeMatch = text.match(/(\d{6,12}),(\d{2})\s+(\d)/);
  const paymentCode = paymentCodeMatch
    ? paymentCodeMatch[1] + paymentCodeMatch[2] + paymentCodeMatch[3]
    : undefined;

  return {
    success: true,
    bill: {
      provider: 'deh',
      billingId,
      billingIdNormalized: normalizeBillingId(billingId),
      totalAmount,
      periodStart,
      periodEnd,
      issueDate: issueDate || undefined,
      dueDate: dueDate || undefined,
      rfCode,
      paymentCode
    }
  };
}
