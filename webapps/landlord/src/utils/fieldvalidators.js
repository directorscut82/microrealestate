/**
 * Client-side field-format validators — the mirror of
 * services/api/src/validators.ts. KEEP THE TWO IN SYNC.
 *
 * These are CLIENT conveniences: they give the landlord an inline message instead
 * of an opaque 422. They are NOT the security boundary — the server must validate
 * the same fields, because every endpoint is callable directly.
 *
 * A garbage IBAN is the costliest miss here: it prints as the pay-to account on
 * every receipt and invoice PDF, so the tenant pays into nothing.
 */

// Strip whitespace INCLUDING NBSP ( ). A value pasted out of a PDF or an
// E9 statement routinely carries a trailing NBSP, and rejecting it as "invalid"
// reads to the landlord as the app refusing a number they can see is correct.
const _clean = (v) => (typeof v === 'string' ? v.replace(/[\s ]+/g, '') : '');

/**
 * Greek ΑΦΜ: 9 digits + modulo-11 checksum on the weighted first 8.
 * "000000000" satisfies the checksum but is not an issued ΑΦΜ, and it is an
 * identity key — the owner matcher and `_markAlsoRents` compare on it, so two
 * different people both carrying it get merged into one.
 */
export function isValidAFM(value) {
  const afm = _clean(value);
  if (!/^[0-9]{9}$/.test(afm)) return false;
  if (afm === '000000000') return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += parseInt(afm[i], 10) * Math.pow(2, 8 - i);
  }
  return (sum % 11) % 10 === parseInt(afm[8], 10);
}

/** AADE ΑΤΑΚ: 11 digits, no checksum. Mirrors validators.ts isValidATAK. */
export function isValidATAK(value) {
  return /^[0-9]{11}$/.test(_clean(value));
}

/** ΔΕΗ electricity supply number: 9 digits. Mirrors validators.ts isValidDEH. */
export function isValidDEH(value) {
  return /^[0-9]{9}$/.test(_clean(value));
}

/** Greek postal code: 5 digits. Mirrors validators.ts isValidGreekPostalCode. */
export function isValidGreekPostalCode(value) {
  return /^[0-9]{5}$/.test(_clean(value));
}

/**
 * IBAN: structural + mod-97 check digit. Mirrors validators.ts isValidIBAN,
 * which is generic across countries (a Greek IBAN is 27 chars, but the rule
 * accepts any valid one so a foreign account is not rejected).
 */
export function isValidIBAN(value) {
  const iban = _clean(value).toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  // Move the first four chars to the end, then letters -> digits (A=10..Z=35),
  // and the whole number mod 97 must be 1.
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /[0-9]/.test(ch)
      ? ch
      : String(ch.charCodeAt(0) - 55); // 'A'.charCodeAt(0) === 65 -> 10
    for (const d of digits) {
      remainder = (remainder * 10 + Number(d)) % 97;
    }
  }
  return remainder === 1;
}

/**
 * Phone: deliberately PERMISSIVE. Greek landlords legitimately store a country
 * code, a mobile annotated «(κιν. …)», or an extension, so the rule only rejects
 * a value with no usable number in it. Enough digits, and digits must dominate —
 * that admits «εσωτ.»/«κιν.» notes while still rejecting a letters-only value.
 */
export function isValidPhone(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return false;
  const digits = (s.match(/[0-9]/g) || []).length;
  if (digits < 8) return false;
  const nonSpace = s.replace(/\s/g, '').length;
  return digits >= Math.ceil(nonSpace * 0.4);
}

/**
 * Helpers for zod schemas. Each returns a predicate usable with `.refine()`,
 * treating empty as VALID so an optional field is not made mandatory by
 * accident — requiredness stays the schema's business, format is ours.
 */
export const optionalFormat = (fn) => (v) =>
  v == null || v === '' || fn(v);
