// Tier E4: lock the E9-based property type inference. AADE category
// numbers + floor-only fallback rules per businesslogic/inferPropertyType.ts.

const { inferPropertyType } = require('../../businesslogic/inferPropertyType.js');

const u = (over = {}) => ({
  category: null,
  floor: 1,
  ...over
});

describe('inferPropertyType', () => {
  describe('AADE category mapping', () => {
    it('category 1 -> apartment', () => {
      expect(inferPropertyType(u({ category: 1 }))).toBe('apartment');
    });
    it('category 2 -> store', () => {
      expect(inferPropertyType(u({ category: 2 }))).toBe('store');
    });
    it('category 3 -> office', () => {
      expect(inferPropertyType(u({ category: 3 }))).toBe('office');
    });
    it('category 4 -> apartment (agricultural rare fallback)', () => {
      expect(inferPropertyType(u({ category: 4 }))).toBe('apartment');
    });
    it('category 5 -> storage', () => {
      expect(inferPropertyType(u({ category: 5 }))).toBe('storage');
    });
    it('category 6 -> storage', () => {
      expect(inferPropertyType(u({ category: 6 }))).toBe('storage');
    });
    it('category 50 -> parking', () => {
      expect(inferPropertyType(u({ category: 50 }))).toBe('parking');
    });
    it('category 51 -> parking', () => {
      expect(inferPropertyType(u({ category: 51 }))).toBe('parking');
    });
  });

  describe('floor-based fallback when category missing', () => {
    it('basement (-1) -> storage', () => {
      expect(inferPropertyType(u({ category: null, floor: -1 }))).toBe('storage');
    });
    it('basement (-2) -> storage', () => {
      expect(inferPropertyType(u({ category: null, floor: -2 }))).toBe('storage');
    });
    it('ground floor (0) -> store', () => {
      expect(inferPropertyType(u({ category: null, floor: 0 }))).toBe('store');
    });
    it('first floor and up -> apartment', () => {
      expect(inferPropertyType(u({ category: null, floor: 1 }))).toBe('apartment');
      expect(inferPropertyType(u({ category: null, floor: 5 }))).toBe('apartment');
    });
    it('floor null (no data) -> apartment', () => {
      expect(inferPropertyType(u({ category: null, floor: null }))).toBe('apartment');
    });
  });

  describe('category dominates floor when both present', () => {
    it('category=2 + floor=5 -> store (not apartment)', () => {
      expect(inferPropertyType(u({ category: 2, floor: 5 }))).toBe('store');
    });
    it('category=5 + floor=2 -> storage (basement category overrides floor)', () => {
      expect(inferPropertyType(u({ category: 5, floor: 2 }))).toBe('storage');
    });
  });
});
