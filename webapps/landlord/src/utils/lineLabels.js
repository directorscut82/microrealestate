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
