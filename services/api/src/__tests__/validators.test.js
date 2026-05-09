/* eslint-env node */
jest.mock('winston');
jest.mock('express-winston');

import { validateObjectId, validateTerm, validateFiniteNumber, validateEnum, validateStringLength, validatePercentageAllocations, validateRatioAllocations, validateAllocationValues, sanitizeMongoObject } from '../validators.js';

describe('validators', () => {
  describe('validateObjectId', () => {
    it('should accept valid 24-char hex strings', () => {
      expect(() => validateObjectId('507f1f77bcf86cd799439011')).not.toThrow();
      expect(() => validateObjectId('AABBCCDDEE1122334455FF66')).not.toThrow();
    });

    it('should reject invalid ids', () => {
      expect(() => validateObjectId('')).toThrow('Invalid id');
      expect(() => validateObjectId('short')).toThrow('Invalid id');
      expect(() => validateObjectId('507f1f77bcf86cd79943901z')).toThrow('Invalid id');
      expect(() => validateObjectId(null)).toThrow('Invalid id');
      expect(() => validateObjectId(undefined)).toThrow('Invalid id');
      expect(() => validateObjectId(12345)).toThrow('Invalid id');
    });

    it('should use custom field name in error', () => {
      expect(() => validateObjectId('bad', 'tenantId')).toThrow('Invalid tenantId');
    });
  });

  describe('validateTerm', () => {
    it('should accept valid YYYYMMDDHH terms', () => {
      expect(validateTerm('2024010100')).toBe(2024010100);
      expect(validateTerm('2099123100')).toBe(2099123100);
      expect(validateTerm(2025060100)).toBe(2025060100);
    });

    it('should reject invalid terms', () => {
      expect(() => validateTerm('202401')).toThrow('Invalid term');
      expect(() => validateTerm('abcdefghij')).toThrow('Invalid term');
      expect(() => validateTerm('')).toThrow('Invalid term');
      expect(() => validateTerm('2019123100')).toThrow('out of valid range');
      expect(() => validateTerm('2100010100')).toThrow('out of valid range');
    });
  });

  describe('validateFiniteNumber', () => {
    it('should return the number for valid inputs', () => {
      expect(validateFiniteNumber(42, 'amount')).toBe(42);
      expect(validateFiniteNumber('100.5', 'price')).toBe(100.5);
      expect(validateFiniteNumber(0, 'discount')).toBe(0);
    });

    it('should return undefined for null/empty when not required', () => {
      expect(validateFiniteNumber(null, 'optional')).toBeUndefined();
      expect(validateFiniteNumber(undefined, 'optional')).toBeUndefined();
      expect(validateFiniteNumber('', 'optional')).toBeUndefined();
    });

    it('should throw when required and missing', () => {
      expect(() => validateFiniteNumber(null, 'amount', { required: true })).toThrow('amount is required');
    });

    it('should reject non-finite values', () => {
      expect(() => validateFiniteNumber(Infinity, 'val')).toThrow('must be a valid number');
      expect(() => validateFiniteNumber(NaN, 'val')).toThrow('must be a valid number');
      expect(() => validateFiniteNumber('abc', 'val')).toThrow('must be a valid number');
    });

    it('should enforce min/max bounds', () => {
      expect(() => validateFiniteNumber(-1, 'val', { min: 0 })).toThrow('must be at least 0');
      expect(() => validateFiniteNumber(101, 'val', { max: 100 })).toThrow('must be at most 100');
    });
  });

  describe('validateEnum', () => {
    const allowed = ['a', 'b', 'c'];

    it('should accept valid values', () => {
      expect(validateEnum('a', allowed, 'field')).toBe('a');
      expect(validateEnum('c', allowed, 'field')).toBe('c');
    });

    it('should return undefined for empty when not required', () => {
      expect(validateEnum(null, allowed, 'field')).toBeUndefined();
      expect(validateEnum('', allowed, 'field')).toBeUndefined();
    });

    it('should throw for invalid values', () => {
      expect(() => validateEnum('x', allowed, 'field')).toThrow("Invalid field: 'x'");
    });

    it('should throw when required and missing', () => {
      expect(() => validateEnum(null, allowed, 'field', { required: true })).toThrow('field is required');
    });
  });

  describe('validateStringLength', () => {
    it('should accept valid strings', () => {
      expect(validateStringLength('hello', 10, 'name')).toBe('hello');
    });

    it('should reject strings exceeding max length', () => {
      expect(() => validateStringLength('too long string', 5, 'name')).toThrow('must be at most 5');
    });

    it('should enforce min length', () => {
      expect(() => validateStringLength('ab', 100, 'name', { minLength: 3 })).toThrow('must be at least 3');
    });

    it('should return undefined when not required and empty', () => {
      expect(validateStringLength(null, 100, 'name')).toBeUndefined();
      expect(validateStringLength('', 100, 'name')).toBeUndefined();
    });

    it('should throw when required and empty', () => {
      expect(() => validateStringLength('', 100, 'name', { required: true })).toThrow('name is required');
    });
  });

  describe('validatePercentageAllocations', () => {
    it('should pass when allocations sum to 100', () => {
      expect(() => validatePercentageAllocations(
        [{ value: 60 }, { value: 40 }],
        'custom_percentage'
      )).not.toThrow();
    });

    it('should throw when allocations do not sum to 100', () => {
      expect(() => validatePercentageAllocations(
        [{ value: 60 }, { value: 30 }],
        'custom_percentage'
      )).toThrow('must sum to 100%');
    });

    it('should throw when no allocations for custom_percentage', () => {
      expect(() => validatePercentageAllocations([], 'custom_percentage')).toThrow('requires at least one');
    });

    it('should skip validation for other methods', () => {
      expect(() => validatePercentageAllocations([], 'equal')).not.toThrow();
    });
  });

  describe('validateRatioAllocations', () => {
    it('should pass with at least one non-zero ratio', () => {
      expect(() => validateRatioAllocations(
        [{ value: 3 }, { value: 0 }],
        'custom_ratio'
      )).not.toThrow();
    });

    it('should throw when all ratios are zero', () => {
      expect(() => validateRatioAllocations(
        [{ value: 0 }, { value: 0 }],
        'custom_ratio'
      )).toThrow('at least one non-zero');
    });

    it('should skip for other methods', () => {
      expect(() => validateRatioAllocations([], 'fixed')).not.toThrow();
    });
  });

  describe('validateAllocationValues', () => {
    it('should pass for valid non-negative values', () => {
      expect(() => validateAllocationValues([{ value: 0 }, { value: 5.5 }])).not.toThrow();
    });

    it('should throw for negative values', () => {
      expect(() => validateAllocationValues([{ value: -1 }])).toThrow('non-negative');
    });

    it('should throw for non-finite values', () => {
      expect(() => validateAllocationValues([{ value: NaN }])).toThrow('non-negative');
    });

    it('should pass for undefined allocations', () => {
      expect(() => validateAllocationValues(undefined)).not.toThrow();
    });
  });

  describe('sanitizeMongoObject', () => {
    it('should strip keys starting with $', () => {
      const result = sanitizeMongoObject({
        name: 'test',
        $gt: 100,
        $regex: '.*',
        email: 'a@b.com'
      });
      expect(result).toEqual({ name: 'test', email: 'a@b.com' });
    });

    it('should return empty object for all $ keys', () => {
      expect(sanitizeMongoObject({ $set: 1, $inc: 2 })).toEqual({});
    });

    it('should pass through clean objects unchanged', () => {
      const obj = { a: 1, b: 'two', c: true };
      expect(sanitizeMongoObject(obj)).toEqual(obj);
    });
  });
});
