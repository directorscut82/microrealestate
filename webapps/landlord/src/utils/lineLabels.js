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

export const BUILDING_TYPE_LABEL_KEY = {
  heating: 'Heating',
  elevator: 'Elevator',
  cleaning: 'Cleaning',
  water_common: 'Water',
  electricity_common: 'Electricity',
  insurance: 'Insurance',
  management_fee: 'Management',
  garden: 'Garden',
  repairs_fund: 'Repairs fund',
  pest_control: 'Pest control',
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
  const d = _trim(charge?.description);
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
