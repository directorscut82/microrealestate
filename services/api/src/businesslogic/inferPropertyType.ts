/**
 * AADE E9-derived property type inference.
 *
 * AADE E9 building categories (Πίνακας 1 — Κατηγορίες κτισμάτων):
 *   1   Κατοικία (residence)            -> 'apartment'
 *   2   Επαγγελματική στέγη (commercial) -> 'store'
 *   3   Γραφείο (office)                -> 'office'
 *   4   Γεωργική / κτηνοτροφική στέγη   -> 'apartment' (rare; no better mapping)
 *   5/6 Αποθήκη / κάθετη ιδιοκτησία υπόγειου χώρου (storage) -> 'storage'
 *   7   Στάσιμη (vacant lot)            -> not a unit, never produced
 *   ≥50 Θέση στάθμευσης (parking)        -> 'parking'
 *
 * Floor-based fallbacks fire only when category is null. Negative floors
 * map to 'storage' (basement/cellar — Greek residential buildings store
 * cellars as αποθήκη more often than as parking). Ground floor without
 * category maps to 'store' (shop-front pattern).
 *
 * Extracted to its own module so the inference can be unit-tested without
 * loading the full buildingmanager dependency chain.
 */

export type PropertyTypeInferenceInput = {
  category: number | null;
  floor: number | null;
};

export function inferPropertyType(unit: PropertyTypeInferenceInput): string {
  if (unit.category !== null) {
    if (unit.category === 5 || unit.category === 6) return 'storage';
    if (unit.category === 2) return 'store';
    if (unit.category === 3) return 'office';
    if (unit.category >= 50) return 'parking';
    return 'apartment';
  }
  if (unit.floor !== null && unit.floor < 0) return 'storage';
  if (unit.floor === 0) return 'store';
  return 'apartment';
}
