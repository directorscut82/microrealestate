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
  // Optional Greek floor-label hint composed by the importer (e.g.
  // "ΟΔΟΣ 9 - Υπόγειο" / "Ισόγειο" / "Όροφος 3"). When category is
  // null AND floor is null, a name pattern still tells us 'storage'
  // (basement) vs 'parking' (Πάρκινγκ) vs 'apartment'.
  name?: string | null;
};

export function inferPropertyType(unit: PropertyTypeInferenceInput): string {
  if (unit.category !== null) {
    if (unit.category === 5 || unit.category === 6) return 'storage';
    if (unit.category === 2) return 'store';
    if (unit.category === 3) return 'office';
    if (unit.category >= 50) return 'parking';
    return 'apartment';
  }
  // Name-based fallback BEFORE floor-based: a unit named "Πάρκινγκ Υπογείου"
  // is parking, not storage, even though it lives on a negative floor.
  // Same for "Αποθήκη Ισογείου" — explicit storage on the ground floor
  // beats the floor=0 → 'store' default. The token order inside the
  // checks matters: parking match wins over generic basement/storage so
  // a name carrying both "Υπόγειο" and "Πάρκινγκ" classifies as parking.
  if (typeof unit.name === 'string' && unit.name) {
    if (/Πάρκινγκ|PARKING|Στάθμευσ/i.test(unit.name)) return 'parking';
    if (/Αποθήκη|APOTHIKI|STORAGE/i.test(unit.name)) return 'storage';
    if (/Υπόγειο|YPOGEIO/i.test(unit.name)) return 'storage';
  }
  // Floor-based fallback last.
  if (unit.floor !== null && unit.floor < 0) return 'storage';
  if (unit.floor === 0) return 'store';
  return 'apartment';
}
