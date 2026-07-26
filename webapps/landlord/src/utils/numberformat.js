export const formatNumber = (
  locale = 'en',
  currency = 'EUR',
  value,
  minimumFractionDigits = 2
) => {
  return Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency,
    minimumFractionDigits
  }).format(value);
};

// Parse a human-typed money string into a number, handling BOTH the Greek
// grouped format ("1.234,56") and the English one ("1,234.56"): whichever
// separator is rightmost is the decimal separator, the other is a thousands
// separator to strip. Mirrors the server-side parseGreekMoney
// (services/api/src/managers/billparser/matching.ts) so client and server
// agree. Returns NaN for unparseable input. O1 (destructive-write audit
// 2026-07): the receipt dialog previously did parseFloat(x.replace(',','.')),
// which turned "1.234,56" into "1.234.56" → 1.234 (a ~1000x understated
// payment recorded silently).
export const parseGreekMoney = (raw) => {
  let s = String(raw == null ? '' : raw).replace(/[^\d.,]/g, '');
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    s = s.replace(/,/g, '');
  } else {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};
