/**
 * AADE E9 property type inference. Catalog verified against real user
 * E9 PDFs (PeriousiakiKatastasi*.pdf) and the official AADE form
 * column "ΚΑΤΗΓΟΡΙΑ ΑΚΙΝΗΤΟΥ":
 *
 *   1  Κατοικία ή διαμέρισμα           -> 'apartment'
 *   2  Μονοκατοικία (single-family)    -> 'apartment'
 *   3  Επαγγελματική στέγη / γραφείο   -> 'office'
 *   4  Οικόπεδα εντός σχεδίου (lot)    -> 'apartment' (rare; no good mapping
 *                                         — ΠΙΝΑΚΑΣ 2 lots are skipped at
 *                                         the parser layer so this almost
 *                                         never reaches us)
 *   5  Αποθήκη                         -> 'storage'
 *   6  Θέση στάθμευσης (parking)       -> 'parking'   ← NOT storage
 *   7  Κτίσματα εκτός σχεδίου          -> 'apartment'
 *   8  Πλεωβολές / λοιπά               -> 'apartment'
 *   ≥50 Special-use codes (Πίνακας 2)  -> 'parking' for ≥51 (Greek deeds
 *                                         encode underground parking as 51,
 *                                         52 etc. in some forms)
 *
 * Floor-based fallbacks fire only when category is null. The order of
 * the name-fallback regexes matters: a unit named "Πάρκινγκ Υπογείου"
 * is parking, not storage, even though the basement keyword matches.
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
    // AADE Πίνακας 1 catalog (verified against real E9 PDFs):
    //   1, 2, 4, 7, 8 -> residential or generic building -> 'apartment'
    //   3            -> professional space              -> 'office'
    //   5            -> αποθήκη                          -> 'storage'
    //   6            -> θέση στάθμευσης                  -> 'parking'
    //   ≥50          -> special parking codes            -> 'parking'
    if (unit.category === 5) return 'storage';
    if (unit.category === 6) return 'parking';
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
