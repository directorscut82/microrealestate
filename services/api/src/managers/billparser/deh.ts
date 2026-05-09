import { BillParseResult, normalizeBillingId } from './types.js';

function parseGreekAmount(raw: string): number | null {
  // Handle "186 , 21" or "186,21" or "186.21"
  const cleaned = raw.replace(/\s/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parseGreekDate(raw: string): Date | null {
  // DD/MM/YYYY format
  const match = raw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  const [, day, month, year] = match;
  return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
}

export function parseDehBill(text: string): BillParseResult {
  // Extract billing ID (Αριθμός παροχής)
  const billingIdMatch = text.match(
    /Αριθμός παροχής\s+([\d][\d\s\-]+\d)/i
  );
  if (!billingIdMatch) {
    return { success: false, error: 'Δεν βρέθηκε αριθμός παροχής' };
  }
  const billingId = billingIdMatch[1].trim();

  // Extract total amount - try multiple patterns
  let totalAmount: number | null = null;

  // Pattern 1: "Συνολικό ποσό πληρωμής" line
  const totalMatch = text.match(
    /Συνολικό ποσό πληρωμής\s*\*?\s*([\d\s,\.]+)\s*€/i
  );
  if (totalMatch) {
    totalAmount = parseGreekAmount(totalMatch[1]);
  }

  // Pattern 2: "ΠΟΣΟ ΠΛΗΡΩΜΗΣ" then "*amount€"
  if (totalAmount === null) {
    const altMatch = text.match(/\*\s*([\d,\.]+)\s*€/);
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
  const issueDateMatch = text.match(
    /Ημ\/νία Έκδοσης\s+(\d{2}\/\d{2}\/\d{4})/i
  );
  const issueDate = issueDateMatch
    ? parseGreekDate(issueDateMatch[1])
    : undefined;

  // Extract due date
  const dueDateMatch = text.match(
    /(?:ΕΞΟΦΛΗΣΗ ΕΩΣ|Εξόφληση έως)\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i
  );
  const dueDate = dueDateMatch ? parseGreekDate(dueDateMatch[1]) : undefined;

  // Extract RF code
  const rfMatch = text.match(/(RF\d{15,30})/);
  const rfCode = rfMatch ? rfMatch[1] : undefined;

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
      rfCode
    }
  };
}
