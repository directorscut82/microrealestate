/**
 * Client-side field-format validators — the mirror of
 * services/api/src/validators.ts.
 *
 * WHY THIS FILE EXISTS. A 34-surface option-matrix audit found 49 confirmed
 * "bad data persisted" combinations, and nearly all of them share ONE root
 * cause: the server has had `isValidGreekAFM`, `isValidATAK`, `isValidDEH`,
 * `isValidGreekPostalCode` and `isValidIBAN` for a long time, but the forms
 * either never called them or re-implemented a weaker copy. Measured against
 * the live API before this file was written:
 *
 *   POST /buildings  taxId "NOT-AN-AFM"      -> 200, persisted
 *                    phone "abc-not-a-phone" -> 200, persisted
 *                    iban  "NOTANIBAN"       -> 200, persisted
 *                    email "not-an-email"    -> 200, persisted
 *   POST /buildings/:id/contractors
 *                    taxId "NOT-AN-AFM", phone "letters-only" -> 200, persisted
 *
 * A garbage IBAN is the worst of these: it prints as the pay-to account on
 * every receipt and invoice PDF, so the tenant pays into nothing.
 *
 * Two ad-hoc copies of the ΑΦΜ check already existed (TenantForm.js:44 and
 * NewTenantDialog.js:34). Both carried the same `000000000` hole the server
 * copy had, and neither trimmed. Consolidated here so there is one rule.
 *
 * KEEP IN SYNC with services/api/src/validators.ts. These are CLIENT
 * conveniences that give the landlord an inline message instead of an opaque
 * 422 — they are NOT the security boundary. The server must validate too, and
 * a finding that says `needsServerGuard` is not closed by editing this file.
 */

// Strip whitespace INCLUDING NBSP ( ). A value pasted out of a PDF or an
// E9 statement routinely carries a trailing NBSP, and rejecting it as "invalid"
// reads to the landlord as the app refusing a number they can see is correct.
const _clean = (v) => (typeof v === 'string' ? v.replace(/[\s ]+/g, '') : '');

/**
 * Greek ΑΦΜ: 9 digits + modulo-11 checksum on the weighted first 8.
 * Mirrors validators.ts isValidGreekAFM, including its rejection of
 * "000000000" — that value satisfies the checksum arithmetically (sum 0 ->
 * check 0) but is not an issued ΑΦΜ, and it becomes a real identity key: it is
 * what the owner matcher and `_markAlsoRents` compare on, so two different
 * people both carrying it get merged into one.
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
 * Phone: deliberately PERMISSIVE. There is no server-side phone validator to
 * mirror, and Greek landlords legitimately store a landline with a country code,
 * a mobile annotated «(κιν. …)», or a number with an extension. The defect is a
 * field that accepted "abc-not-a-phone" — pure letters with no digits at all —
 * not one that accepts unusual formatting. So: require at least 8 digits, and
 * require digits to dominate the content, which admits «εσωτ.»/«κιν.» notes.
 */
export function isValidPhone(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return false;
  // Reject only a value with NO usable number in it. An earlier version also
  // required every character to look "phone-like", which rejected
  // «210 1234567 εσωτ. 5» — a perfectly normal Greek entry naming an extension.
  // That is a FALSE POSITIVE on real data, which is worse than the hole being
  // closed. So the rule is: enough digits to be a number, and digits must
  // dominate, which still rejects "abc-not-a-phone" and "letters-only".
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
