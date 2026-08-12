import { ServiceError } from '@microrealestate/common';

// ---------------------------------------------------------------------------
// Shared validation helpers for API handlers
// ---------------------------------------------------------------------------

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const TERM_RE = /^\d{10}$/;

const EXPENSE_TYPES = [
  'heating',
  'elevator',
  'cleaning',
  'water_common',
  'electricity_common',
  // Must stay in step with BuildingExpenseSchema.type (services/common).
  'electricity_private',
  'water_private',
  'gas_private',
  'telecom_private',
  'telecom_common',
  'insurance',
  'management_fee',
  'garden',
  'repairs_fund',
  'pest_control',
  'other'
] as const;

const ALLOCATION_METHODS = [
  'general_thousandths',
  'heating_thousandths',
  'elevator_thousandths',
  'equal',
  'by_surface',
  'fixed',
  'custom_ratio',
  'custom_percentage',
  'single_unit'
] as const;

const REPAIR_STATUSES = [
  'planned',
  'in_progress',
  'completed',
  'cancelled'
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

// Wave-21 C29-B1: validate realm.currency. The guard exists to keep a
// malformed code (e.g. "NOTACURRENCY") from reaching Intl.NumberFormat in the
// accounting CSV pipeline (RangeError → 500).
//
// Round-2 audit H6 + Step-7: a STATIC list (whether the old 14 codes or
// Intl.supportedValuesOf — 162 codes) is NARROWER than what the org-settings
// dropdown offers (167 codes from `currency-codes`) AND narrower than what
// Intl.NumberFormat actually accepts — 9 fund/unit-of-account codes
// (BOV/CHE/CHW/CLF/COU/MXV/UYI/UYW/XUA) are offered by the dropdown and accepted
// by NumberFormat but absent from supportedValuesOf, so a static list 422-locks
// those realms on every settings save. The ONLY non-drifting source of truth is
// the downstream consumer itself: validate by PROBING `Intl.NumberFormat`. It
// accepts exactly the set that will never crash the accounting pipeline and
// rejects genuine garbage — by construction it can never diverge from the
// consumer again. `validateCurrency` below replaces the static-enum check.
function _isFormattableCurrency(code: string): boolean {
  try {
    // Intl normalizes case; require a 3-letter ISO-shaped code first so junk
    // like "1" or "$" is rejected before the (lenient) Intl probe.
    if (!/^[A-Za-z]{3}$/.test(code)) return false;
    // Throws RangeError on an invalid currency — exactly the crash we prevent.
    new Intl.NumberFormat('en', { style: 'currency', currency: code });
    return true;
  } catch {
    return false;
  }
}

export function validateCurrency(
  value: unknown,
  fieldName = 'currency'
): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !_isFormattableCurrency(value)) {
    throw new ServiceError(
      `Invalid ${fieldName}: '${String(value)}'. Must be a valid ISO-4217 currency code.`,
      422
    );
  }
  return value;
}

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

export function validateTerm(term: unknown, fieldName = 'term'): number {
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
    throw new ServiceError(`${fieldName} must be at least ${min}`, 422);
  }
  if (max != null && n > max) {
    throw new ServiceError(`${fieldName} must be at most ${max}`, 422);
  }
  return n;
}

/**
 * A strict boolean body field. Mongoose would happily CAST `"no"`, `"0"` and `[]`
 * to a boolean, so a typo in a client payload becomes a silent money flag —
 * `isVariable` decides whether a €0 expense means «κυμαινόμενο» or «unfinished».
 * Absent is fine (the schema default applies); present-but-not-boolean is not.
 */
/**
 * A `_private` (per-apartment) expense must NEVER be split by χιλιοστά.
 *
 * The browser filters the method list per type, but it also deliberately RE-APPENDS a
 * persisted method so a saved value is never hidden, and the repair effect declines to
 * rewrite a value it believes was persisted. Both are correct alone; together they let
 * an existing `electricity_common + general_thousandths` expense be switched to
 * `electricity_private` while KEEPING the χιλιοστά split — and the server validated
 * `type` and `allocationMethod` against two independent enums with no compatibility
 * check. One apartment's €87,40 then kept splitting across the other flats, every
 * month, on the very type introduced to prevent that.
 *
 * A client-side filter cannot bind a value that is already in the database, so the rule
 * lives here.
 */
export function validateTypeAllocationCompatible(
  type: unknown,
  allocationMethod: unknown,
  fieldName = 'allocationMethod'
): void {
  if (typeof type !== 'string' || typeof allocationMethod !== 'string') return;
  if (!type.endsWith('_private')) return;
  if (allocationMethod.endsWith('_thousandths')) {
    throw new ServiceError(
      `${fieldName}: a per-apartment expense (${type}) cannot be split by χιλιοστά — ` +
        'that would charge the whole building for one apartment\'s bill',
      422
    );
  }
}

export function validateBooleanField(
  value: unknown,
  fieldName: string
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ServiceError(`${fieldName} must be true or false`, 422);
  }
  return value;
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
    throw new ServiceError(`${fieldName} must be in DD/MM/YYYY format`, 422);
  }
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (
    year < 1900 ||
    year > 2999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
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
  const sum = allocations.reduce((s, a) => s + (Number(a.value) || 0), 0);
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
  const total = allocations.reduce((s, a) => s + (Number(a.value) || 0), 0);
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
  // Sum the PER-UNIT ROUNDED shares, not the raw values. The rent pipeline
  // bills each unit Math.round(value * 100) / 100, so an all-sub-cent
  // allocation set (e.g. every value 0.0001) has a raw total > 0 yet rounds
  // to €0 on every unit — the silent-€0 bug the raw `total <= 0` check let
  // through. Require at least one cent of actually-billable money.
  const billableTotal = allocations.reduce(
    (s, a) => s + Math.round((Number(a.value) || 0) * 100) / 100,
    0
  );
  if (billableTotal < 0.01) {
    throw new ServiceError(
      'fixed allocation requires at least one unit with a non-zero amount',
      422
    );
  }
}

/**
 * Validate 'single_unit' allocations: the whole expense is billed to ONE unit
 * named in customAllocations[0].propertyId. Without a target propertyId the
 * rent pipeline's single_unit branch (1_base.ts) matches no unit and silently
 * bills €0 every term. The propertyId-is-in-this-building check lives in
 * _assertCustomAllocationPropertyIds; this guards the missing/empty target.
 */
export function validateSingleUnitAllocations(
  allocations: Array<{ propertyId?: string; value?: number }> | undefined,
  allocationMethod: string
): void {
  if (allocationMethod !== 'single_unit') return;
  const target = (allocations || [])[0];
  if (!target?.propertyId) {
    throw new ServiceError(
      'single_unit allocation requires a target unit',
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
  const seenPropertyIds = new Set<string>();
  for (let i = 0; i < allocations.length; i++) {
    const a = allocations[i];
    const v = Number(a.value);
    if (!Number.isFinite(v) || v < 0) {
      throw new ServiceError(
        `Allocation value at index ${i} must be a non-negative number`,
        422
      );
    }
    // Reject DUPLICATE propertyIds. The rent pipeline resolves a unit's share
    // via customAllocations.find(propertyId) — it honors only the FIRST row
    // per unit. A second row for the same unit is silently ignored by billing
    // but WAS summed by validateFixedAllocations, so a payload like
    // [{P,0.004},{P,0.006}] passed the >= €0.01 check yet billed €0 (the first
    // row, 0.004, rounds to 0). Duplicates are never legitimate (the UI emits
    // one row per unit); reject them so validator and pipeline agree.
    if (a?.propertyId) {
      const pid = String(a.propertyId);
      if (seenPropertyIds.has(pid)) {
        throw new ServiceError(
          `customAllocations has a duplicate entry for propertyId ${pid}`,
          422
        );
      }
      seenPropertyIds.add(pid);
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
  // TRIM first. A pasted ΑΦΜ carries a trailing space or NBSP more often than not
  // (copying from a PDF or an E9 statement), and rejecting it as "not a valid ΑΦΜ"
  // reads to the landlord as the app refusing a number they can see is correct.
  // \u00a0 is NBSP, written as an escape: a literal NBSP in source trips eslint
  // no-irregular-whitespace and is invisible to a reviewer.
  const afm = value.replace(/[\s\u00a0]+/g, '');
  if (!/^[0-9]{9}$/.test(afm)) return false;
  // 000000000 satisfies the checksum arithmetically (sum 0 → check 0 → digit 0) but
  // is NOT an issued ΑΦΜ. It was accepted and PERSISTED on the live realm (measured
  // via POST /tenants), while the sibling copy in greekleaseparser.ts:15 rejects it
  // explicitly — two validators, divergent behaviour, and the permissive one is the
  // one wired into the write path (occupantmanager.ts:1163). An all-zero tax id
  // silently becomes a real owner/tenant identity key: it is what `_markAlsoRents`
  // and the E9 owner matcher compare on, so two different people both carrying it
  // are merged into one. Reject it here so the two copies agree.
  if (afm === '000000000') return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += parseInt(afm[i], 10) * Math.pow(2, 8 - i);
  }
  const check = (sum % 11) % 10;
  return check === parseInt(afm[8], 10);
}

export function validateGreekAFM(value: unknown, fieldName = 'taxId'): string {
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
 * ΑΤΑΚ *prefix*: the first 6 digits of an 11-digit ΑΤΑΚ — the building-level
 * part, shared by every unit in the building.
 *
 * DO NOT wire `isValidATAK` (above) here: that is the FULL 11-digit number and
 * would reject every legitimate prefix. This is a separate rule, and 6 is not a
 * guess — three consumers slice exactly 6 characters and compare for equality:
 *   - e9parser.ts (`u.atakNumber.substring(0, 6)`) derives the building's
 *     prefix from the imported units.
 *   - occupantmanager.ts (`prefixMap.get(p.atakNumber.substring(0, 6))`) links
 *     an imported property to its building by that exact key.
 * So a prefix of any other length — or one carrying whitespace — never matches
 * and the import silently links nothing, with no error anywhere. Trim before
 * testing for the same reason `isValidGreekAFM` does: a value pasted out of an
 * E9 statement routinely carries a trailing space or NBSP.
 */
export function isValidATAKPrefix(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^[0-9]{6}$/.test(value.replace(/[\s\u00a0]+/g, ''));
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
 * Phone number — deliberately PERMISSIVE, and kept in sync with the client
 * mirror in webapps/landlord/src/utils/fieldvalidators.js.
 *
 * This function had NO callers until a manager.phone guard was wired to it, so
 * its original rule ("every character must be one of +0-9()- or space") had
 * never been measured against real data. It rejects «210 1234567 εσωτ. 5» — a
 * normal Greek entry naming an extension — and the client mirror was already
 * loosened for exactly that false positive. Shipping the strict version as a
 * 422 would have made the server refuse a value the form accepts.
 *
 * The DEFECT being closed is a field that accepted "abc-not-a-phone": letters
 * with no usable number in them. So the rule is "enough digits, and digits
 * dominate the content", which admits «εσωτ.»/«κιν.» notes and still rejects
 * pure letters. A false positive on real data is worse than the hole.
 */
export function isValidPhone(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s) return false;
  const digits = (s.match(/[0-9]/g) || []).length;
  if (digits < 8) return false;
  const nonSpace = s.replace(/\s/g, '').length;
  return digits >= Math.ceil(nonSpace * 0.4);
}

/**
 * Email — RFC-ish but pragmatic. Mirrors zod's email regex shape.
 */
export function isValidEmail(value: unknown): boolean {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Re-export constants for use in managers
export {
  EXPENSE_TYPES,
  ALLOCATION_METHODS,
  REPAIR_STATUSES,
  CHARGEABLE_TO,
  TIME_RANGES,
  LOCALES,
  PROPERTY_TYPES
};
