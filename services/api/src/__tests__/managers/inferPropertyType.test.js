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
  describe('AADE category mapping (verified against real E9 PDFs)', () => {
    it('category 1 (κατοικία/διαμέρισμα) -> apartment', () => {
      expect(inferPropertyType(u({ category: 1 }))).toBe('apartment');
    });
    it('category 2 (μονοκατοικία) -> apartment', () => {
      expect(inferPropertyType(u({ category: 2 }))).toBe('apartment');
    });
    it('category 3 (επαγγελματική στέγη/γραφείο) -> office', () => {
      expect(inferPropertyType(u({ category: 3 }))).toBe('office');
    });
    it('category 4 (οικόπεδο) -> apartment (rare fallback)', () => {
      expect(inferPropertyType(u({ category: 4 }))).toBe('apartment');
    });
    it('category 5 (αποθήκη) -> storage', () => {
      expect(inferPropertyType(u({ category: 5 }))).toBe('storage');
    });
    it('category 6 (θέση στάθμευσης) -> parking', () => {
      expect(inferPropertyType(u({ category: 6 }))).toBe('parking');
    });
    it('category 7 (κτίσματα εκτός σχεδίου) -> apartment', () => {
      expect(inferPropertyType(u({ category: 7 }))).toBe('apartment');
    });
    it('category 8 (πλεωβολές) -> apartment', () => {
      expect(inferPropertyType(u({ category: 8 }))).toBe('apartment');
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
    it('category=6 + floor=5 -> parking (parking category beats apartment-floor)', () => {
      expect(inferPropertyType(u({ category: 6, floor: 5 }))).toBe('parking');
    });
    it('category=5 + floor=2 -> storage (storage category overrides floor)', () => {
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
    it('category overrides name pattern (cat=6 wins over apartment name)', () => {
      expect(inferPropertyType({ category: 6, floor: null, name: 'Όροφος 1' })).toBe('parking');
    });
    it('floor overrides name pattern (floor=0 wins over apartment-named)', () => {
      expect(inferPropertyType({ category: null, floor: 0, name: 'Όροφος 1' })).toBe('store');
    });
  });
});
