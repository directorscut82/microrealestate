/**
 * The pre-filled synthetic expense for «➕ Νέα δαπάνη», shared by BOTH bill-ingest
 * surfaces: the upload dialog (BillImportDialog) and the Telegram inbox bell
 * (InboxBell).
 *
 * WHY THIS IS SHARED CODE AND NOT A SECOND COPY: the upload dialog grew a
 * carefully-reasoned three-way allocation choice (each branch was a defect found
 * by adversarial review), and the bell — which reaches the same
 * create-expense form for the same bills — carried a flat
 * `allocationMethod: 'equal'`. A κοινόχρηστο bill routed through the bell
 * therefore split EQUALLY where the upload path splits by χιλιοστά: on a €200
 * stairwell bill over 400/300/200/100‰ units that is €80/60/40/20 the right way
 * versus €50 each, so the 400‰ owner is under-billed €30 and the 100‰ owner
 * over-billed €30 — every month, since these expenses are recurring. That is the
 * same failure shape as the duplicated bill→expense matcher it was found beside:
 * two implementations of one money rule, and only one of them got the fix.
 *
 * THE THREE-WAY, and why each branch is load-bearing:
 *
 * · SHARED (κοινόχρηστος) meter → split across the building by χιλιοστά. WHICH
 *   vector depends on the utility: gas (ΕΠΑ) maps to expense type `heating`, and
 *   `ALLOCATION_METHODS_BY_TYPE.heating` does NOT offer `general_thousandths`
 *   (ExpenseFormDialog) — pairing them yields a combination the picker itself
 *   forbids, and the form's auto-correct declines to repair a value it believes was
 *   persisted, so gas would split by GENERAL thousandths and bill unheated units
 *   for heating.
 * · …and χιλιοστά are OPTIONAL. An E9-imported building has none, so
 *   `Σ thousandths === 0`; `1_base.ts` then returns a 0 share for every unit, no
 *   monthlyCharge row is written, and the amount lands on NO surface at all —
 *   invisible money (MONEY_SURFACE_MATRIX). The server's
 *   `_assertThousandthsAvailable` cannot catch it either: it is gated on
 *   `amount > 0` and this prefill deliberately sends 0. So degrade to an equal
 *   split when the target building has no vector for the method.
 * · UNIT's own meter → `single_unit`, the whole amount to that apartment. Putting
 *   `single_unit` on a SHARED meter would charge one flat for the building's entire
 *   supply while every other unit paid zero.
 * · Neither → an equal split, the honest default for an unidentified bill.
 */

/**
 * Provider → expense `type`, and it depends on WHOSE meter it is.
 *
 * The map used to be flat (`deh → electricity_common`), so an apartment's own ΔΕΗ
 * bill was typed as COMMON-AREA electricity — a cost the whole building shares.
 * The landlord caught it and corrected the type by hand. Since 2026-08-12 the
 * schema has private counterparts, so the choice is made from the MATCH:
 * a unit meter → the `_private` type, a κοινόχρηστος meter → the `_common` one.
 *
 * Deliberately not exported: these lived as two identical copies (here and in
 * InboxBell) and an unexported constant cannot grow a third.
 */
const PROVIDER_TYPE_SHARED = {
  deh: 'electricity_common',
  eydap: 'water_common',
  epa: 'heating',
  nova: 'telecom_common',
  // The generic service the landlord picks in the UI; `nova` is only what the parser
  // reads off a NOVA document.
  telecom: 'telecom_common'
};
const PROVIDER_TYPE_PRIVATE = {
  deh: 'electricity_private',
  eydap: 'water_private',
  epa: 'gas_private',
  nova: 'telecom_private',
  telecom: 'telecom_private'
};

/**
 * Provider code → the Greek brand name. The landlord's screens are Greek and the
 * approved mock shows «ΔΕΗ», not the raw code «DEH» — yet the prefill named
 * expenses `provider.toUpperCase()`, which is why a live building now has an
 * expense called «DEH» sitting among Greek ones. This map already existed in
 * InboxBell for a badge; it lives here now so both surfaces read the same one.
 */
const PROVIDER_LABEL = {
  deh: 'ΔΕΗ',
  eydap: 'ΕΥΔΑΠ',
  epa: 'ΕΠΑ',
  nova: 'NOVA',
  telecom: 'Τηλεπικοινωνίες'
};

/** The Greek display name for a provider code, or '' when unknown. */
export function providerLabel(provider) {
  const key = String(provider ?? '')
    .trim()
    .toLowerCase();
  return PROVIDER_LABEL[key] || '';
}

/**
 * The expense `type` for this bill. `kind` is 'private' for a unit-meter bill,
 * 'shared' for a κοινόχρηστος one, and anything else falls back to `other` —
 * guessing a utility type for an unidentified bill would file it against the wrong
 * cost category.
 */
export function providerExpenseType(provider, kind) {
  const key = String(provider ?? '')
    .trim()
    .toLowerCase();
  const map = kind === 'private' ? PROVIDER_TYPE_PRIVATE : PROVIDER_TYPE_SHARED;
  if (kind !== 'private' && kind !== 'shared') return 'other';
  return map[key] || 'other';
}

/**
 * Which χιλιοστά vector a utility splits by, and whether `building` actually has
 * it. Returns the allocationMethod to use for a SHARED meter of this type.
 */
export function sharedThousandthsMethod(expenseType, building) {
  const field =
    expenseType === 'heating' ? 'heatingThousandths' : 'generalThousandths';
  const total = (building?.units || []).reduce(
    (sum, u) => sum + (Number(u?.[field]) || 0),
    0
  );
  if (!(total > 0)) return 'equal';
  return expenseType === 'heating' ? 'heating_thousandths' : 'general_thousandths';
}

/**
 * Build the synthetic expense (NO `_id` → add mode in ExpenseFormDialog).
 *
 * @param {object}  args
 * @param {object}  args.building     the building the expense is created on
 * @param {string}  args.provider     parsed/detected provider ('deh'|'eydap'|'epa'|…)
 * @param {string}  args.billingId    the bill's αριθμός παροχής, as printed
 * @param {object=} args.sharedMatch  κοινόχρηστος hit: {provider?, label?}
 * @param {object=} args.unitMatch    apartment hit: {propertyId}
 */
export function buildExpensePrefill({
  building,
  provider,
  billingId,
  sharedMatch,
  unitMatch
}) {
  // On a shared hit the provider from the STORED meter is more reliable than the
  // parse (it is what the landlord recorded) and survives a failed parse.
  const effectiveProvider = sharedMatch?.provider || provider || '';
  // WHOSE meter decides the type: an apartment's own bill is a `_private` cost,
  // a κοινόχρηστος one is `_common`. An unidentified bill gets `other` rather than
  // a guessed utility type.
  const kind = sharedMatch ? 'shared' : unitMatch ? 'private' : null;
  const type = providerExpenseType(effectiveProvider, kind);
  return {
    // A shared meter's own label («Κλιμακοστάσιο») names the expense far better
    // than the bare provider. Otherwise the GREEK brand name — the screens are
    // Greek, and `provider.toUpperCase()` is what put an expense called «DEH» in
    // a live building. Falls back to the raw code only if the provider is unknown,
    // which at least stays truthful about what was read.
    name:
      sharedMatch?.label ||
      providerLabel(effectiveProvider) ||
      (effectiveProvider ? effectiveProvider.toUpperCase() : ''),
    type,
    // Left at 0 DELIBERATELY: on a failed parse the total is a SALVAGED figure and
    // may include a prior balance (BILL_OCR_INBOX_PLAN §17.5.2). It is shown on the
    // card for the operator to read off the document — never pre-committed.
    amount: 0,
    allocationMethod: sharedMatch
      ? sharedThousandthsMethod(type, building)
      : unitMatch
        ? 'single_unit'
        : 'equal',
    customAllocations:
      unitMatch && !sharedMatch
        ? [{ propertyId: unitMatch.propertyId, value: 0 }]
        : [],
    isRecurring: true,
    chargeOwnerWhenVacant: true,
    billingId: billingId || ''
  };
}
