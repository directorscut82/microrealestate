// Wave-26 round-3u: shared label rule for rent / property-charge /
// building-charge lines. Used by every surface that renders these:
//   - RentDetails (Πρόγραμμα tile)
//   - RentTable.MonthlyBreakdown tooltip on /rents
//   - PaymentTabs saved-tile bullet (via _resolveLineSource)
//   - AllocationBlock dropdown + preview rows
//   - PDF body (mirrored in invoicebody.ejs)
//
// Rule:
//   preTaxAmounts[i]                     → Ενοίκιο  (<description>)
//   charges[i]                           → Δαπάνη επί του ενοικίου  (<description>)
//   buildingCharges[i] (type !== repair) → <TypeLabel>  (<buildingName> - <description>)
//   buildingCharges[i] (type === repair) → Επισκευή  (<buildingName> - <description>)
//
// Empty-description fallbacks:
//   preTax empty   → Ενοίκιο (no paren)
//   charges empty  → Δαπάνη επί του ενοικίου (no paren)
//   bldg empty     → <TypeLabel>  (<buildingName>)
//   debts empty    → Έκτακτη χρέωση

// SINGLE source of truth for the building-expense type → label. These MUST be
// the SAME label keys the expense table (ExpenseList.js EXPENSE_TYPES) and the
// PDF (invoicebody.ejs) use, so the SAME type reads identically on EVERY surface
// (payment lines, rents tooltip, dashboard chart, owner ledger, PDF, the expense
// table). Previously this map used ABBREVIATED keys (Water/Electricity/
// Management) while the table used the full keys (Water Common/Electricity
// Common/Management Fee) — so «Κοινόχρηστο Ρεύμα» in the table became
// «Ηλεκτρισμός» in a payment. Aligned to the full expense-table labels.
export const BUILDING_TYPE_LABEL_KEY = {
  heating: 'Heating',
  elevator: 'Elevator',
  cleaning: 'Cleaning',
  water_common: 'Water Common',
  electricity_common: 'Electricity Common',
  insurance: 'Insurance',
  management_fee: 'Management Fee',
  garden: 'Garden',
  repairs_fund: 'Repairs Fund',
  pest_control: 'Pest Control',
  monthly_charge: 'Other',
  other: 'Other',
  repair: 'Repair'
};

const _trim = (s) => (s == null ? '' : String(s).trim());

export function rentLineLabel(t, preTaxItem) {
  const d = _trim(preTaxItem?.description);
  return d ? `${t('Rent')}  (${d})` : t('Rent');
}

export function chargeLineLabel(t, charge) {
  const d = _trim(charge?.description);
  return d ? `${t('Property charge')}  (${d})` : t('Property charge');
}

export function buildingLineLabel(t, charge) {
  const typeKey = BUILDING_TYPE_LABEL_KEY[charge?.type] || 'Other';
  const typeLabel = t(typeKey);
  // Strip the server's legacy English "Repair: <title>" prefix so a repair
  // buildingCharge doesn't render «Επισκευή (Building - Repair: <title>)» — the
  // type label already says «Επισκευή». Mirrors chargeLineLabel/ownerChargeLabel.
  const d = _trim(charge?.description).replace(/^Repair:\s*/i, '');
  const b = _trim(charge?.buildingName);
  let paren = '';
  if (b && d) paren = ` (${b} - ${d})`;
  else if (b) paren = ` (${b})`;
  else if (d) paren = ` (${d})`;
  return paren ? `${typeLabel} ${paren}`.replace(/\s+\(/, '  (') : typeLabel;
}

export function debtLineLabel(t, debt) {
  const d = _trim(debt?.description);
  return d || t('Additional cost');
}

// Localized label for an OWNER ledger charge (ownerMonthlyExpenses row). Used
// by the owner detail page + owner payment dialog so neither leaks a raw
// English source enum ('repair-vacant', 'owner-fixed') or 'Repair:' prefix.
// Rule (user, 2026-06): ALWAYS show "Τύπος (Όνομα)" — the type label PLUS the
// name the user declared, so the kind AND the name are both visible. Drop the
// parenthetical ONLY when the name is exactly the type label (pure duplicate).
// Never silently hide a user-typed name (even hash-looking ones — the user
// must SEE a junk name to fix it).
const _SOURCE_LABEL_KEY = {
  expense: 'Owner expense',
  'owner-fixed': 'Owner expense',
  vacant: 'Vacant-unit share',
  'owner-resident': 'Owner-resident share',
  repair: 'Repair',
  'repair-vacant': 'Repair'
};
export function ownerChargeLabel(t, charge) {
  const typeKey = charge?.expenseType
    ? BUILDING_TYPE_LABEL_KEY[charge.expenseType]
    : null;
  // strip a hardcoded legacy "Repair: <title>" English prefix if present
  const desc = _trim(charge?.description).replace(/^Repair:\s*/i, '');
  const base = typeKey
    ? t(typeKey)
    : t(_SOURCE_LABEL_KEY[charge?.source] || 'Owner expense');
  if (desc && desc !== base) return `${base}  (${desc})`;
  return base;
}

/**
 * Per-unit scope label for an owner charge. The server sends `scope`
 * ('building' | 'unit') plus `unitFloor` / `unitVacant` (ownermanager.ts
 * OwnerCharge) precisely so identical-looking lines can be told apart: a
 * building-wide owner-portion reads «Ολόκληρο κτίριο», a unit line reads its
 * floor (Ισόγειο / Όροφος N), suffixed ΚΕΝΟ when that unit is vacant.
 *
 * Returns '' when the scope is unknown, so callers can omit the suffix.
 *
 * This lived privately in owners/[id].js, which is why the OwnerPaymentDialog
 * still rendered five visually-identical «Θέρμανση (…) / <κτίριο>» rows for
 * five different units — the discriminator existed server-side and simply was
 * not read on that surface. One implementation, both surfaces.
 */
export function ownerChargeScopeLabel(t, charge) {
  if (charge?.scope === 'building') return t('Whole building');
  if (charge?.scope !== 'unit') return '';
  let floorLabel = '';
  if (charge.unitFloor === 0) floorLabel = t('Ground floor');
  else if (typeof charge.unitFloor === 'number')
    floorLabel = `${t('Floor')} ${charge.unitFloor}`;
  if (charge.unitVacant) {
    // ΚΕΝΟ (neuter) per the user. With a known floor: "Ισόγειο — ΚΕΝΟ".
    return floorLabel
      ? `${floorLabel} — ${t('Vacant unit')}`
      : t('Vacant unit');
  }
  return floorLabel;
}
