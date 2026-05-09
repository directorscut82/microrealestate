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
  'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage'
] as const;

const REPAIR_STATUSES = [
  'planned', 'in_progress', 'completed', 'cancelled'
] as const;

const CHARGEABLE_TO = ['owners', 'tenants', 'split'] as const;

const TIME_RANGES = ['months', 'weeks', 'days', 'years'] as const;

const LOCALES = ['en', 'fr-FR', 'de-DE', 'el', 'es-CO', 'pt-BR'] as const;

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
  if (Array.isArray(arr) && arr.length > maxLength) {
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
  const s = String(value);
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
 * Strip MongoDB operators from an object (prevent injection)
 */
export function sanitizeMongoObject(
  obj: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!key.startsWith('$')) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// Re-export constants for use in managers
export {
  EXPENSE_TYPES,
  ALLOCATION_METHODS,
  REPAIR_STATUSES,
  CHARGEABLE_TO,
  TIME_RANGES,
  LOCALES
};
