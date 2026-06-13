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
    percentage: { type: Number, required: true },
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
    enum: ['general_thousandths', 'heating_thousandths', 'elevator_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage'],
    default: 'general_thousandths'
  },
  chargeTerm: Number
});

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
  source: {
    type: String,
    enum: ['expense', 'repair', 'vacant', 'repair-vacant'],
    default: 'expense'
  },
  // Whether the owner has paid this owner-side charge. Drives the building
  // Overview "owner expenses paid vs unpaid" progress tile. Defaults to
  // unpaid; the landlord toggles it. paidDate is stamped when marked paid.
  paid: { type: Boolean, default: false },
  paidDate: { type: Date, default: null }
});

const BuildingSchema = new mongoose.Schema<CollectionTypes.Building>({
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

  notes: String,
  createdDate: Date,
  updatedDate: Date
}, {
  // Audit B3: Optimistic concurrency. Mongoose now bumps __v on every
  // save() and throws VersionError if the document was modified between
  // findOne and save. buildingmanager wraps every save() in
  // _saveBuildingWithVersionCheck() which surfaces the conflict as a
  // 409 instead of letting one of two concurrent writers silently
  // overwrite the other. Mirrors realm.ts (line 119).
  optimisticConcurrency: true
});

BuildingSchema.index({ realmId: 1 });
BuildingSchema.index({ realmId: 1, atakPrefix: 1 });
BuildingSchema.index({ realmId: 1, name: 1 });

export default mongoose.model<CollectionTypes.Building>(
  'Building',
  BuildingSchema
);
