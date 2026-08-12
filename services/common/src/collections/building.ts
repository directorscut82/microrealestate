import { CollectionTypes } from '@microrealestate/types';
import mongoose from 'mongoose';
import Realm from './realm.js';

const UnitOwnerSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['member', 'external'],
      required: true
    },
    // Bounded [0,100] — an ownership share outside that range is
    // misconfiguration; without the guard a negative/>100 value rendered a
    // negative € co-owner slice in the breakdown (adversarial finding, June
    // 2026). Mirrors RepairSchema.tenantSharePercentage's min/max.
    percentage: { type: Number, required: true, min: 0, max: 100 },
    memberId: String,
    name: String,
    taxId: String,
    iban: String,
    phone: String,
    email: String
  },
  { _id: false }
);

const MonthlyChargeSchema = new mongoose.Schema({
  term: { type: Number, required: true },
  // `amount` is the per-unit ALLOCATED SHARE that flows into rent billing.
  // `inputAmount` is the full statement figure the landlord typed for the
  // expense that month (before allocation). Storing it separately lets the
  // monthly-statement form read back the entered figure instead of summing
  // the per-unit shares — that sum under-reports whenever a unit is vacant
  // or a share rounds, which made repeated saves erode the amount toward
  // zero. Nullable for legacy rows written before this field existed.
  amount: { type: Number, required: true },
  inputAmount: { type: Number, default: null },
  description: String,
  expenseId: { type: String, default: null },
  repairId: { type: String, default: null }
});

const BuildingUnitSchema = new mongoose.Schema({
  // Wave-20 F11: persist `name` so POST /buildings :: units[i].name and
  // POST /buildings/:id/units (addUnit) round-trip the user-entered label.
  // Previously the schema lacked this field and Mongoose silently dropped
  // it, leaving the UI blank for every unit. `unitLabel` is the legacy
  // field and is kept for backwards compat with older imports.
  name: String,
  atakNumber: { type: String, required: true },
  altAtakNumbers: [String],
  floor: Number,
  unitLabel: String,
  surface: Number,
  yearBuilt: Number,
  electricitySupplyNumber: String,
  generalThousandths: Number,
  heatingThousandths: Number,
  elevatorThousandths: Number,
  // T2.P1.14: ΕΙΔΟΣ ΔΙΚΑΙΩΜΑΤΟΣ from E9 imports. Defaults to 'full'
  // since every prior import implicitly treated rows as full
  // ownership; bare/usufruct rows now round-trip from the E9 parser.
  rightType: {
    type: String,
    enum: ['full', 'bare', 'usufruct'],
    default: 'full'
  },
  owners: [UnitOwnerSchema],
  propertyId: String,
  isManaged: { type: Boolean, default: false },
  occupancyType: {
    type: String,
    enum: ['rented', 'owner_occupied', 'vacant', 'parking'],
    default: 'vacant'
  },
  parkingAssignedTo: {
    type: [String],
    default: []
  },
  monthlyCharges: [MonthlyChargeSchema]
});

const CustomAllocationSchema = new mongoose.Schema(
  {
    propertyId: { type: String, required: true },
    value: { type: Number, required: true }
  },
  { _id: false }
);

const BuildingExpenseSchema = new mongoose.Schema({
  name: { type: String, required: true },
  type: {
    type: String,
    enum: [
      'heating',
      'elevator',
      'cleaning',
      'water_common',
      'electricity_common',
      // PRIVATE (per-apartment) utilities + telecoms, added 2026-08-12. Not every
      // utility bill is κοινόχρηστο: an apartment's own ΔΕΗ/ΕΥΔΑΠ/gas/telecom bill
      // needs a type that says so, or it gets filed as common-area cost and split
      // across the whole building. Every consumer of this enum must map these:
      // api/validators.ts, propertymanager._classifyExpenseType,
      // pdfgenerator invoicebody.ejs, ExpenseFormDialog (labels + allocation
      // methods) and all six locales. An unmapped type is invisible money.
      'electricity_private',
      'water_private',
      'gas_private',
      'telecom_private',
      'telecom_common',
      'insurance',
      'management_fee',
      'garden',
      'repairs_fund',
      'pest_control',
      'other'
    ],
    required: true
  },
  amount: { type: Number, default: 0 },
  // κυμαινόμενο: the amount genuinely differs every month (electricity, water),
  // so €0 here means "not known yet", NOT "free". Added 2026-08-12 because until
  // then the ONLY way to express this was to leave `amount` at 0 — which made a
  // variable expense indistinguishable from one the landlord had not finished
  // filling in, on every surface. The landlord had been writing «(κυμαινόμενο)»
  // into the expense NAME to work around it.
  //
  // Read it through `Utils.isVariableExpense` (utils/variableexpense.ts) — never
  // re-derive `recurring && amount === 0` inline. That inference existed in three
  // separate places before this flag, which is how a money rule gets three
  // different answers. Absent on every pre-existing row, and the predicate's
  // legacy fallback is what keeps those rows behaving as before.
  isVariable: { type: Boolean, default: false },
  allocationMethod: {
    type: String,
    enum: [
      'general_thousandths',
      'heating_thousandths',
      'elevator_thousandths',
      'equal',
      'by_surface',
      'fixed',
      'custom_ratio',
      'custom_percentage',
      // "single_unit" — the entire expense is billed to one specific
      // unit (e.g. a balcony repair charged to the apartment that
      // benefits). The chosen unit lives in customAllocations[0].
      // Functionally equivalent to custom_percentage with 100% on one
      // unit and 0 on all others, but presented as a one-click choice
      // so the user doesn't have to fill 0 in every other row.
      'single_unit'
    ],
    required: true
  },
  customAllocations: [CustomAllocationSchema],
  isRecurring: { type: Boolean, default: true },
  startTerm: Number,
  endTerm: Number,
  trackOwnerExpense: { type: Boolean, default: false },
  ownerAmount: { type: Number, default: 0 },
  // When TRUE, the share that would have been allocated to a vacant
  // (unrented) unit gets routed to the owner instead of being silently
  // dropped. Used for common-area utilities (electricity, lift, cleaning)
  // where the bill is paid even when units are empty. Default FALSE
  // preserves the historical behavior — only opt in per-expense.
  chargeOwnerWhenVacant: { type: Boolean, default: false },
  notes: String,
  billingId: String
});

const ContractorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  company: String,
  // Includes legacy values 'plumbing'/'electrical' alongside the canonical
  // contractor specialty names so older imports validate without migration.
  specialty: {
    type: String,
    enum: [
      'plumbing',
      'electrical',
      'plumber',
      'electrician',
      'painter',
      'carpenter',
      'mason',
      'gardener',
      'cleaner',
      'elevator',
      'locksmith',
      'hvac',
      'general',
      'other'
    ],
    required: true
  },
  phone: String,
  email: String,
  taxId: String,
  notes: String
});

const RepairSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: String,
  category: {
    type: String,
    enum: [
      'plumbing',
      'electrical',
      'elevator',
      'roof',
      'facade',
      'heating',
      'doors_windows',
      'painting',
      'flooring',
      'general',
      'other'
    ],
    required: true
  },
  status: {
    type: String,
    enum: ['planned', 'in_progress', 'completed', 'cancelled'],
    default: 'planned'
  },
  urgency: {
    type: String,
    enum: ['emergency', 'normal', 'low'],
    default: 'normal'
  },
  reportedDate: Date,
  startDate: Date,
  completionDate: Date,
  estimatedCost: Number,
  actualCost: Number,
  isPaidFromRepairsFund: { type: Boolean, default: false },
  contractorId: String,
  affectedUnitIds: [String],
  affectedArea: String,
  invoiceReference: String,
  // Tier I-3.d: holds the storage key (S3 / MinIO) returned by
  // /documents/upload when the user attaches an invoice scan to a repair.
  invoiceDocumentId: { type: String, default: null },
  // Slice 6 — απόδειξη installments matched to this repair (mirrors
  // BillSchema.receipts). Repair is "fully paid" when Σ(receipts) >= actualCost.
  receipts: [
    {
      amount: Number,
      date: Date,
      proofUrl: String,
      ocrText: String,
      matchedOn: [String],
      createdDate: Date
    }
  ],
  notes: String,
  // Distribution to tenants
  chargeableTo: {
    type: String,
    enum: ['tenants', 'owners', 'split'],
    default: 'owners'
  },
  tenantSharePercentage: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  },
  allocationMethod: {
    type: String,
    enum: [
      'general_thousandths',
      'heating_thousandths',
      'elevator_thousandths',
      'equal',
      'by_surface',
      'fixed',
      'custom_ratio',
      'custom_percentage'
    ],
    default: 'general_thousandths'
  },
  chargeTerm: Number,
  // §2: when a unit is vacant for the charge term, its tenant-share of the
  // repair is routed to the OWNER (source:'repair-vacant') only if this is true
  // — mirroring BuildingExpenseSchema.chargeOwnerWhenVacant. Default false: a
  // vacant unit's share becomes Αχρέωτα (uncollected) instead.
  chargeOwnerWhenVacant: { type: Boolean, default: false }
});

// A single owner payment (καταβολή) slice allocated to one owner charge.
// Mirrors the persisted tenant rent payment shape (tenant.rents[].payments[]):
// date/amount/type/reference/description. The owner-scoped payment dialog
// records ONE payment against an owner and fans an allocated slice onto each
// covered charge's `payments[]` — so per-row settlement (paidAmount = Σ
// payments.amount) stays correct and the building doc remains the single home.
const OwnerExpensePaymentSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    amount: { type: Number, required: true },
    type: {
      type: String,
      enum: ['cash', 'transfer', 'cheque'],
      default: 'transfer'
    },
    reference: { type: String, default: '' },
    description: { type: String, default: '' },
    // WHICH co-owner paid this slice. A building-wide charge (propertyId null)
    // is split across all co-owners on read; without per-payment attribution a
    // single shared payments[] is ambiguous and the read-time re-split credited
    // one owner's καταβολή to a co-owner (audit C2). Set by pay() to the paying
    // owner's ownerKey. Optional: legacy rows (and single-owner charges) have
    // none → the reader falls back to the proportional split for those.
    ownerKey: { type: String, default: null },
    // Client-generated idempotency key for the ONE καταβολή submit this slice
    // belongs to. An owner payment can fan slices across SEVERAL buildings, and
    // mongo 4.4 standalone has no multi-doc transaction — so a failure partway
    // through the save loop leaves some slices committed and 409s the caller. A
    // naive retry would re-record the committed slices (double-count real money).
    // pay() reconciles by txnId: slices already carrying this key are recognised
    // as done and only the REMAINDER is written, making retry safe. Optional —
    // legacy rows and API callers that omit it keep the previous behavior.
    txnId: { type: String, default: null }
  },
  { _id: false }
);

// §5: a VOLUNTARY contribution toward this building's Αχρέωτα (uncollected
// vacant-unit expense money). It is NOT a liability — nobody owes Αχρέωτα — so
// it is recorded ONLY here, never as a settling payment on the payer's rent or
// owner ledger (that would reduce a real debt the payer doesn't have AND
// double-count the euro on the Αχρέωτα tile). The Overview tile + ΧΡΕΩΣΕΙΣ panel
// subtract Σ uncollectedPayments[term] from the gross Αχρέωτα. Append-only,
// no per-row PATCH → _id:false (mirrors OwnerExpensePaymentSchema).
const UncollectedPaymentSchema = new mongoose.Schema(
  {
    term: { type: Number, required: true },
    amount: { type: Number, required: true },
    // OPTIONAL attribution. A building-level voluntary coverage is attributed to
    // no specific payer, so these are absent for that case. If a future flow
    // records a contribution from a specific renter/owner, paidByType is
    // 'renter'|'owner' and payerId is the tenant _id or ownerKey (owners are NOT
    // ObjectIds — they live in units[].owners[]). No read path consumes them
    // today; they exist only as an optional audit trail.
    paidByType: { type: String, enum: ['renter', 'owner'] },
    payerId: { type: String },
    date: { type: Date, required: true },
    reference: { type: String, default: '' },
    // Client idempotency key of the submit these rows belong to. The endpoint
    // is APPEND-ONLY with no DELETE/PATCH, so a duplicate cannot be undone
    // from the UI — a retry after a timeout that actually persisted silently
    // doubled the building's covered figure. addUncollectedPayment skips a
    // submit whose txnId already appears here. Optional: legacy rows and API
    // callers that omit it keep the previous behavior.
    txnId: { type: String, default: null }
  },
  { _id: false }
);

const OwnerMonthlyExpenseSchema = new mongoose.Schema({
  expenseId: { type: String, required: true },
  term: { type: Number, required: true },
  amount: { type: Number, required: true },
  description: String,
  // The vacant unit whose share this owner charge represents (source
  // 'vacant' only). Lets the recompute replace exactly the right entries
  // and the UI attribute the charge to a unit.
  propertyId: { type: String, default: null },
  // Tier I-3.f: distinguishes recurring building-expense allocations from
  // owner-side repair charges so the UI / reporting can show a per-source
  // breakdown without inferring it from description text.
  //   'expense'       = a non-vacant owner-side share of a recurring building
  //                     expense (the fixed ownerAmount path / variable owner
  //                     entries).
  //   'repair'        = the owner-borne portion of a repair (chargeableTo
  //                     'owners' or the owner slice of a 'split'). expenseId
  //                     holds the REPAIR _id.
  //   'vacant'        = a building-EXPENSE share for a unit with no tenant
  //                     this term, routed to the owner because the expense has
  //                     chargeOwnerWhenVacant=true. Re-derived wholesale every
  //                     run by _recomputeVacantOwnerCharges (which strips all
  //                     source:'vacant' rows for the term then rebuilds them
  //                     from building.expenses).
  //   'repair-vacant' = the tenant-portion share of a REPAIR that fell on a
  //                     VACANT unit (no rent term to attach a monthlyCharge
  //                     to), routed to the owner. expenseId holds the REPAIR
  //                     _id. MUST be a distinct source from 'vacant': the
  //                     expense recompute would otherwise strip it (it lives
  //                     outside building.expenses so it'd never be re-added),
  //                     silently re-opening the "repair vanishes" bug on the
  //                     next unrelated tenancy change.
  //   'owner-fixed'   = the fixed owner-only monthly amount (BuildingExpense
  //                     ownerAmount where trackOwnerExpense=true), MATERIALISED
  //                     per active month into a real payable row so it can be
  //                     settled via owner καταβολές like every other owner
  //                     charge (was previously a display-only projection).
  //                     expenseId holds the building expense _id.
  source: {
    type: String,
    // 'owner-resident': the share of a unit whose OWNER lives in it
    // (occupancyType='owner_occupied'). The owner genuinely consumes the
    // expense, so the share is billed to the owner — but it is NOT a 'vacant'
    // unit and must never be shown as uncollected/evaporating. Distinct source
    // so the UI labels it as an owner-resident cost.
    // 'credit': a settled row whose source expense/repair was hard-deleted but
    // which carried recorded καταβολές — kept (amount=0, payments preserved) so
    // the owner's money survives the delete as an overpayment/credit instead of
    // vanishing with the pulled row.
    enum: [
      'expense',
      'repair',
      'vacant',
      'repair-vacant',
      'owner-fixed',
      'owner-resident',
      'credit'
    ],
    default: 'expense'
  },
  // Owner payments (καταβολές) recorded against THIS charge. The owner-scoped
  // payment dialog fans an allocated slice onto each covered charge. Settlement
  // is DERIVED from this array (paidAmount = Σ payments.amount); `paid`/
  // `paidDate` below are recomputed from it on every write — they are a cached
  // convenience for the dashboard tile, NOT an independent source of truth.
  payments: { type: [OwnerExpensePaymentSchema], default: [] },
  // DERIVED from `payments` (paid = outstanding <= 0.005). Kept as a cached
  // flag the dashboard/breakdown read directly. Every recompute that strips +
  // rebuilds an owner row MUST carry `payments` (and hence paid) forward —
  // mirroring the paid carry-forward added in 6e1fae9a, extended to payments.
  paid: { type: Boolean, default: false },
  paidDate: { type: Date, default: null }
});

/**
 * A SHARED (κοινόχρηστος) utility meter belonging to the BUILDING, not to any one
 * apartment — the στάσιμο/κλιμακοστάσιο ΔΕΗ meter, the lift's meter, the common
 * ΕΥΔΑΠ supply.
 *
 * WHY THIS EXISTS: `electricitySupplyNumber` lives only on BuildingUnitSchema, so
 * before this there was NOWHERE to record a shared meter. The bill importer keys
 * on the αριθμός παροχής, so a κοινόχρηστο bill could never match — and the only
 * workaround (putting the shared παροχή on some unit) is actively dangerous: the
 * importer would propose `single_unit` and bill the whole building's shared
 * electricity to that ONE apartment while every other unit paid zero.
 *
 * A LIST, not a pair of strings: a polykatoikia routinely has several shared
 * meters (stairwell + lift + pump), and `provider` per row means a new utility
 * never needs a schema change.
 */
const SharedMeterSchema = new mongoose.Schema(
  {
    // Which utility issues the bill. Drives the proposed expense `type` on import
    // (deh → electricity_common, eydap → water_common, epa → heating). Must stay in
    // step with billmanager's VALID_PROVIDERS and the dialog's PROVIDER_TYPE map —
    // a provider valid for a BILL but not for a shared METER means a real
    // κοινόχρηστο gas supply cannot be recorded at all.
    provider: {
      type: String,
      enum: ['deh', 'eydap', 'epa', 'other'],
      required: true
    },
    // The αριθμός παροχής as PRINTED on the bill, spacing and check-suffix
    // included. Stored verbatim so it can be read back against a paper bill; all
    // comparison is on the normalised digits (billparser normalizeBillingId).
    supplyNumber: { type: String, required: true },
    // Operator-facing name for this meter («Κλιμακοστάσιο», «Ανελκυστήρας»). Two
    // shared ΔΕΗ meters are otherwise indistinguishable in the UI, and this label
    // pre-fills the created expense's name.
    label: String
  },
  { _id: false }
);

const BuildingSchema = new mongoose.Schema<CollectionTypes.Building>(
  {
    realmId: { type: String, ref: Realm },

    name: { type: String, required: true },
    description: String,
    address: {
      _id: false,
      street1: String,
      street2: String,
      zipCode: String,
      city: String,
      state: String,
      country: String
    },
    blockNumber: String,
    blockStreets: [String],

    // Shared (κοινόχρηστοι) utility meters — see SharedMeterSchema.
    sharedMeters: { type: [SharedMeterSchema], default: [] },

    atakPrefix: { type: String, required: true },
    yearBuilt: Number,
    totalFloors: Number,
    hasElevator: { type: Boolean, default: false },
    hasCentralHeating: { type: Boolean, default: false },
    heatingType: {
      type: String,
      enum: ['central_oil', 'central_gas', 'autonomous', 'none', '']
    },

    manager: {
      _id: false,
      name: String,
      phone: String,
      email: String,
      taxId: String,
      company: String
    },
    bankInfo: {
      _id: false,
      name: String,
      iban: String
    },

    units: [BuildingUnitSchema],
    expenses: [BuildingExpenseSchema],
    contractors: [ContractorSchema],
    repairs: [RepairSchema],
    ownerMonthlyExpenses: [OwnerMonthlyExpenseSchema],
    uncollectedPayments: [UncollectedPaymentSchema],

    notes: String,
    createdDate: Date,
    updatedDate: Date
  },
  {
    // Audit B3: Optimistic concurrency. Mongoose now bumps __v on every
    // save() and throws VersionError if the document was modified between
    // findOne and save. buildingmanager wraps every save() in
    // _saveBuildingWithVersionCheck() which surfaces the conflict as a
    // 409 instead of letting one of two concurrent writers silently
    // overwrite the other. Mirrors realm.ts (line 119).
    optimisticConcurrency: true
  }
);

BuildingSchema.index({ realmId: 1 });
BuildingSchema.index({ realmId: 1, atakPrefix: 1 });
BuildingSchema.index({ realmId: 1, name: 1 });

export default mongoose.model<CollectionTypes.Building>(
  'Building',
  BuildingSchema
);
