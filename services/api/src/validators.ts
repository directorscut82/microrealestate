import { ServiceError } from '@microrealestate/common';

// ---------------------------------------------------------------------------
// Shared validation helpers for API handlers
// ---------------------------------------------------------------------------

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const TERM_RE = /^\d{10}$/;

const EXPENSE_TYPES = [
  'heating', 'elevator', 'cleaning', 'water_common',
  'electricity_common', 'insurance', 'management_fee',
  'garden', 'repairs_fund', 'pest_control', 'other'
] as const;

const ALLOCATION_METHODS = [
  'general_thousandths', 'heating_thousandths', 'elevator_thousandths',
  'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage',
  'single_unit'
] as const;

const REPAIR_STATUSES = [
  'planned', 'in_progress', 'completed', 'cancelled'
] as const;

const CHARGEABLE_TO = ['owners', 'tenants', 'split'] as const;

const TIME_RANGES = ['months', 'weeks', 'days', 'years'] as const;

// Accept both short forms and IETF tags. Frontend may emit either ('en-US'
// vs 'en', 'el-GR' vs 'el'). Aliases are normalized in the manager layer
// when persisted; downstream locale resolution (PDF/CSV/i18n) keys on the
// short form so e.g. 'el-GR' resolves to the same Greek translations as
// 'el'.
const LOCALES = [
  'en',
  'en-US',
  'fr-FR',
  'de-DE',
  'el',
  'el-GR',
  'es-CO',
  'pt-BR'
] as const;

// Wave-21 C29-B1: ISO-4217 subset accepted on realm.currency. Without this
// guard, a malformed currency code (e.g. "NOTACURRENCY") was accepted at
// PATCH time and later crashed Intl.NumberFormat in the accounting CSV
// pipeline with a 500. Add new codes here as needed; the list intentionally
// stays narrow to keep the surface area small.
const CURRENCIES = [
  'EUR',
  'USD',
  'GBP',
  'BRL',
  'COP',
  'AUD',
  'CAD',
  'CHF',
  'JPY',
  'CNY',
  'INR',
  'NOK',
  'SEK',
  'DKK'
] as const;

const PROPERTY_TYPES = [
  'store',
  'building',
  'apartment',
  'room',
  'office',
  'garage',
  'parking',
  'letterbox',
  // Wave-17 B8: 'storage' (αποθήκη) is a common Greek property type for
  // cellars / storage rooms attached to buildings. We expose ONE canonical
  // type (not 'cellar' as a separate id) — the i18n label is per-locale.
  // Surface lower-bound for 'storage' follows the parking/letterbox path
  // (allow 0) since basements may be declared with no usable surface.
  'storage'
] as const;

export function validateObjectId(
  id: unknown,
  fieldName = 'id'
): asserts id is string {
  if (typeof id !== 'string' || !OBJECT_ID_RE.test(id)) {
    throw new ServiceError(`Invalid ${fieldName}`, 422);
  }
}

export function validateTerm(
  term: unknown,
  fieldName = 'term'
): number {
  const s = String(term);
  if (!TERM_RE.test(s)) {
    throw new ServiceError(
      `Invalid ${fieldName} format (expected YYYYMMDDHH)`,
      422
    );
  }
  const n = Number(s);
  if (n < 2020010100 || n > 2099123100) {
    throw new ServiceError(`${fieldName} out of valid range`, 422);
  }
  return n;
}

export function validateFiniteNumber(
  value: unknown,
  fieldName: string,
  opts: { min?: number; max?: number; required?: boolean } = {}
): number | undefined {
  const { min, max, required = false } = opts;
  if (value == null || value === '') {
    if (required) {
      throw new ServiceError(`${fieldName} is required`, 422);
    }
    return undefined;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ServiceError(`${fieldName} must be a valid number`, 422);
  }
  if (min != null && n < min) {
    throw new ServiceError(
      `${fieldName} must be at least ${min}`,
      422
    );
  }
  if (max != null && n > max) {
    throw new ServiceError(
      `${fieldName} must be at most ${max}`,
      422
    );
  }
  return n;
}

export function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fieldName: string,
  opts: { required?: boolean } = {}
): T | undefined {
  if (value == null || value === '') {
    if (opts.required) {
      throw new ServiceError(`${fieldName} is required`, 422);
    }
    return undefined;
  }
  if (!allowed.includes(value as T)) {
    throw new ServiceError(
      `Invalid ${fieldName}: '${value}'. Must be one of: ${allowed.join(', ')}`,
      422
    );
  }
  return value as T;
}

export function validateArrayMaxLength(
  arr: unknown,
  maxLength: number,
  fieldName: string
): void {
  // Reject non-array inputs explicitly. Previously silent: a string or
  // object slipped past this guard because the only check was
  // `Array.isArray(arr) && arr.length > max`. Downstream code that
  // assumed an array shape (e.g. .forEach / [i]) would either crash
  // with a confusing TypeError or coerce wrong. Surface a 422 here.
  if (arr == null) return;
  if (!Array.isArray(arr)) {
    throw new ServiceError(`${fieldName} must be an array`, 422);
  }
  if (arr.length > maxLength) {
    throw new ServiceError(
      `${fieldName} exceeds maximum of ${maxLength} items`,
      422
    );
  }
}

export function validateStringLength(
  value: unknown,
  maxLength: number,
  fieldName: string,
  opts: { required?: boolean; minLength?: number } = {}
): string | undefined {
  if (value == null || value === '') {
    if (opts.required) {
      throw new ServiceError(`${fieldName} is required`, 422);
    }
    return undefined;
  }
  // Reject non-string inputs. Previously coerced via String(value) — an
  // array or object payload would land as e.g. "1,2,3" or "[object Object]"
  // and pass length checks, then be persisted in mongo as garbage. Mirrors
  // the strict shape used by validateStringField below.
  if (typeof value !== 'string') {
    throw new ServiceError(`${fieldName} must be a string`, 422);
  }
  const s = value;
  if (opts.minLength && s.trim().length < opts.minLength) {
    throw new ServiceError(
      `${fieldName} must be at least ${opts.minLength} characters`,
      422
    );
  }
  if (s.length > maxLength) {
    throw new ServiceError(
      `${fieldName} must be at most ${maxLength} characters`,
      422
    );
  }
  return s;
}

/**
 * Strict version of validateStringLength: validates name-style fields with
 * a {min, max, required} options shape. Trims whitespace before checking
 * minimum length and rejects pure whitespace strings.
 */
export function validateStringField(
  value: unknown,
  fieldName: string,
  opts: { min?: number; max?: number; required?: boolean } = {}
): string | undefined {
  const { min, max, required = false } = opts;
  if (value == null || value === '') {
    if (required) {
      throw new ServiceError(`${fieldName} is required`, 422);
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ServiceError(`${fieldName} must be a string`, 422);
  }
  const trimmed = value.trim();
  if (required && trimmed.length === 0) {
    throw new ServiceError(`${fieldName} is required`, 422);
  }
  if (min != null && trimmed.length < min) {
    throw new ServiceError(
      `${fieldName} must be at least ${min} character${min === 1 ? '' : 's'}`,
      422
    );
  }
  if (max != null && value.length > max) {
    throw new ServiceError(
      `${fieldName} must be at most ${max} characters`,
      422
    );
  }
  return trimmed;
}

/**
 * Validate a date string in DD/MM/YYYY format. Rejects empty strings (when
 * required) and structurally invalid dates (e.g. 31/02/2024). Returns the
 * trimmed string when valid, or undefined when empty and not required.
 */
export function validateDateString(
  value: unknown,
  fieldName: string,
  opts: { required?: boolean } = {}
): string | undefined {
  const { required = false } = opts;
  if (value == null || value === '') {
    if (required) {
      throw new ServiceError(`${fieldName} is required`, 422);
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ServiceError(`${fieldName} must be a string`, 422);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    if (required) {
      throw new ServiceError(`${fieldName} is required`, 422);
    }
    return undefined;
  }
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (!m) {
    throw new ServiceError(
      `${fieldName} must be in DD/MM/YYYY format`,
      422
    );
  }
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ServiceError(`${fieldName} is not a valid date`, 422);
  }
  // Cross-check using Date — catches 31/02 etc.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new ServiceError(`${fieldName} is not a valid date`, 422);
  }
  return trimmed;
}

/**
 * Validate a year parameter. Enforces integer in 1900..2099 (inclusive).
 * Wave-24 A17: /accounting/abc, /csv/settlements/-1, /csv/settlements/9999
 * were all returning 200 with empty/garbage data because the manager
 * coerced bad inputs via `Number(req.params.year)` and quietly mapped 0
 * or NaN onto the empty result set.
 */
export function validateYear(value: unknown, fieldName = 'year'): number {
  if (value == null || value === '') {
    throw new ServiceError(`${fieldName} is required`, 422);
  }
  const s = String(value);
  if (!/^-?\d+$/.test(s)) {
    throw new ServiceError(`${fieldName} must be an integer`, 422);
  }
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1900 || n > 2099) {
    throw new ServiceError(
      `${fieldName} must be an integer in [1900, 2099]`,
      422
    );
  }
  return n;
}

/**
 * Validate custom_percentage allocations sum to 100
 */
export function validatePercentageAllocations(
  allocations: Array<{ propertyId?: string; value?: number }> | undefined,
  allocationMethod: string
): void {
  if (allocationMethod !== 'custom_percentage') return;
  if (!allocations || allocations.length === 0) {
    throw new ServiceError(
      'custom_percentage requires at least one allocation',
      422
    );
  }
  const sum = allocations.reduce(
    (s, a) => s + (Number(a.value) || 0),
    0
  );
  if (Math.abs(sum - 100) > 0.01) {
    throw new ServiceError(
      `Percentage allocations must sum to 100% (currently ${sum.toFixed(2)}%)`,
      422
    );
  }
}

/**
 * Validate custom_ratio allocations have at least one non-zero value
 */
export function validateRatioAllocations(
  allocations: Array<{ propertyId?: string; value?: number }> | undefined,
  allocationMethod: string
): void {
  if (allocationMethod !== 'custom_ratio') return;
  if (!allocations || allocations.length === 0) return;
  const total = allocations.reduce(
    (s, a) => s + (Number(a.value) || 0),
    0
  );
  if (total <= 0) {
    throw new ServiceError(
      'custom_ratio requires at least one non-zero ratio value',
      422
    );
  }
}

/**
 * Validate 'fixed' allocations: each unit pays a predefined per-unit euro
 * amount via customAllocations. A fixed expense with no allocations, or
 * all-zero values, bills NOBODY (the rent pipeline exempts 'fixed' from the
 * amount>0 gate, so a €0 fixed expense persists and silently charges no
 * one). The client zod guard catches this in the form, but a direct REST
 * caller bypasses it — enforce server-side too, mirroring
 * validatePercentageAllocations / validateRatioAllocations.
 */
export function validateFixedAllocations(
  allocations: Array<{ propertyId?: string; value?: number }> | undefined,
  allocationMethod: string
): void {
  if (allocationMethod !== 'fixed') return;
  if (!allocations || allocations.length === 0) {
    throw new ServiceError(
      'fixed allocation requires at least one unit with a non-zero amount',
      422
    );
  }
  const total = allocations.reduce((s, a) => s + (Number(a.value) || 0), 0);
  if (total <= 0) {
    throw new ServiceError(
      'fixed allocation requires at least one unit with a non-zero amount',
      422
    );
  }
}

/**
 * Validate individual allocation values are non-negative numbers
 */
export function validateAllocationValues(
  allocations: Array<{ propertyId?: string; value?: number }> | undefined
): void {
  if (!allocations) return;
  for (let i = 0; i < allocations.length; i++) {
    const a = allocations[i];
    const v = Number(a.value);
    if (!Number.isFinite(v) || v < 0) {
      throw new ServiceError(
        `Allocation value at index ${i} must be a non-negative number`,
        422
      );
    }
  }
}

/**
 * Strip MongoDB operators from an object (prevent injection).
 * Walks nested objects and arrays, dropping any `$`-prefixed key at any depth.
 * Dates, ObjectIds, Buffers and other non-plain objects are returned as-is.
 */
function _isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function _sanitizeRecursive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(_sanitizeRecursive);
  }
  if (_isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$')) continue;
      out[k] = _sanitizeRecursive(v);
    }
    return out;
  }
  return value;
}

export function sanitizeMongoObject(
  obj: Record<string, unknown>
): Record<string, unknown> {
  return _sanitizeRecursive(obj) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tier C — Greek-context format validators
// ---------------------------------------------------------------------------

/**
 * Greek tax ID (ΑΦΜ): 9 digits + checksum (modulo-11 on weighted sum of the
 * first 8 digits). The 9th digit is the check digit. Used by AADE for both
 * natural persons and legal entities.
 *
 * Returns true iff `value` is exactly 9 digits AND the checksum is valid.
 *
 * Reference: https://el.wikipedia.org/wiki/Αριθμός_Φορολογικού_Μητρώου
 *   - Sum = Σ digit[i] * 2^(8-i)  for i in 0..7
 *   - check = (Sum mod 11) mod 10
 *   - check must equal digit[8]
 */
export function isValidGreekAFM(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (!/^[0-9]{9}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += parseInt(value[i], 10) * Math.pow(2, 8 - i);
  }
  const check = (sum % 11) % 10;
  return check === parseInt(value[8], 10);
}

export function validateGreekAFM(
  value: unknown,
  fieldName = 'taxId'
): string {
  if (!isValidGreekAFM(value)) {
    throw new ServiceError(
      `${fieldName} is not a valid Greek AFM (9 digits + checksum)`,
      422
    );
  }
  return value as string;
}

/**
 * AADE ATAK (ΑΤΑΚ): 11-digit cadastral identifier. No checksum — pure
 * format check. Imports always carry a valid value; manual entry can
 * mistype it.
 */
export function isValidATAK(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9]{11}$/.test(value);
}

/**
 * DEH (ΔΕΗ) electricity supply number: 9 digits, no checksum.
 */
export function isValidDEH(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9]{9}$/.test(value);
}

/**
 * Greek postal code: 5 digits, no further structure.
 */
export function isValidGreekPostalCode(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9]{5}$/.test(value);
}

/**
 * IBAN structural validator — letters+digits, 15-34 length, mod-97 == 1.
 * Greek IBANs are exactly 27 chars but the validator is generic so it
 * accepts any country.
 */
export function isValidIBAN(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const v = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(v)) return false;
  // Move first 4 chars to the end; replace each letter with its
  // 0-indexed-from-A + 10 numeric value; result mod 97 must be 1.
  const rearranged = v.slice(4) + v.slice(0, 4);
  let n = '';
  for (const ch of rearranged) {
    if (/[A-Z]/.test(ch)) {
      n += (ch.charCodeAt(0) - 'A'.charCodeAt(0) + 10).toString();
    } else {
      n += ch;
    }
  }
  // mod-97 over arbitrary-length numeric string by chunks
  let remainder = 0;
  for (const digit of n) {
    remainder = (remainder * 10 + parseInt(digit, 10)) % 97;
  }
  return remainder === 1;
}

/**
 * Phone number — accept country-code prefix + digits/spaces/parens/hyphens.
 * Length 6..30 chars total.
 */
export function isValidPhone(value: unknown): boolean {
  return typeof value === 'string' && /^[+0-9\s()-]{6,30}$/.test(value);
}

/**
 * Email — RFC-ish but pragmatic. Mirrors zod's email regex shape.
 */
export function isValidEmail(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

// Re-export constants for use in managers
export {
  EXPENSE_TYPES,
  ALLOCATION_METHODS,
  REPAIR_STATUSES,
  CHARGEABLE_TO,
  TIME_RANGES,
  LOCALES,
  PROPERTY_TYPES,
  CURRENCIES
};
