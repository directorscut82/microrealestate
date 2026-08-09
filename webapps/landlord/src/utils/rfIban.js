/**
 * ISO 11649 payment reference (RF) validator for the client.
 *
 * The server already has one (billparser/matching.ts isValidRF) but the receipt
 * dialog needs to check what the landlord TYPES before it is sent: that field
 * only appears because the OCR'd code failed its checksum, and the typed value
 * is appended to the stored ocrText, from which the matcher rebuilds its element
 * bag. An unchecked typo becomes a permanent match key.
 *
 * IBAN is re-exported from fieldvalidators so there is one IBAN rule on the
 * client, not two.
 */
export { isValidIBAN } from './fieldvalidators';

const mod97 = (numeric) => {
  let remainder = 0;
  for (const ch of numeric) {
    remainder = (remainder * 10 + Number(ch)) % 97;
  }
  return remainder;
};

const lettersToDigits = (s) => {
  let out = '';
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') {
      out += ch;
    } else if (ch >= 'A' && ch <= 'Z') {
      out += String(ch.charCodeAt(0) - 55); // 'A' -> 10
    } else {
      return '';
    }
  }
  return out;
};

/** RF + 2 check digits + up to 21 alphanumerics, mod-97 == 1. */
export function isValidRF(value) {
  if (typeof value !== 'string') return false;
  const v = value.replace(/\s+/g, '').toUpperCase();
  if (!/^RF[0-9]{2}[A-Z0-9]{1,21}$/.test(v)) return false;
  const numeric = lettersToDigits(v.slice(4) + v.slice(0, 4));
  if (!numeric) return false;
  return mod97(numeric) === 1;
}
