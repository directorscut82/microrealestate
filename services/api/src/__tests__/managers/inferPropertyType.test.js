// Tier E4: lock the E9-based property type inference. AADE category
// numbers + floor-only fallback rules per businesslogic/inferPropertyType.ts.
/* eslint-env node, mocha */
import { inferPropertyType } from '../../businesslogic/inferPropertyType.js';

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

  describe('name-based fallback when category + floor null', () => {
    it('name contains Ypogeio -> storage', () => {
      expect(inferPropertyType({ category: null, floor: null, name: 'ΑΓ. ΑΝΑΡΓΥΡΩΝ 28 - Υπόγειο' })).toBe('storage');
    });
    it('name contains Apothiki -> storage', () => {
      expect(inferPropertyType({ category: null, floor: null, name: 'Αποθήκη Β1' })).toBe('storage');
    });
    it('name contains Parkingk -> parking', () => {
      expect(inferPropertyType({ category: null, floor: null, name: 'Πάρκινγκ Π2' })).toBe('parking');
    });
    it('plain name Orofos 1 -> apartment', () => {
      expect(inferPropertyType({ category: null, floor: null, name: 'ΣΠΑΡΤΙΑΤΩΝ 9 - Όροφος 1' })).toBe('apartment');
    });
    it('category overrides name pattern (cat=2 wins over Ypogeio)', () => {
      expect(inferPropertyType({ category: 2, floor: null, name: 'Υπόγειο' })).toBe('store');
    });
    it('floor overrides name pattern (floor=0 wins over apartment-named)', () => {
      expect(inferPropertyType({ category: null, floor: 0, name: 'Όροφος 1' })).toBe('store');
    });
  });
});
