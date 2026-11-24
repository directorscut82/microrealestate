/**
 * What «Πληροφορίες → Αποθήκευση» of a building sends: the building's id and the fields
 * the form edits. NOT the loaded record with the form laid over it.
 *
 * The record holds every owner charge ever stored for the building — one per apartment,
 * expense and month — and grows with every month (489 KB for an 11-apartment building in
 * 11/2026). The api reads 100 KB of JSON per request (Express's default; see
 * services/common/src/utils/service.ts) and its update keeps only the detail fields
 * (an explicit allowlist in buildingmanager.ts `update`). So sending the record never
 * stored anything more, and past 100 KB the save failed with a 413 and the screen said
 * only «Κάτι πήγε στραβά»: the details of that building could not be changed at all.
 */
export function buildingDetailsRequest(building, formPart) {
  return { _id: building._id, ...formPart };
}
