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
  amount: { type: Number, required: true },
  description: String,
  expenseId: String
});

const BuildingUnitSchema = new mongoose.Schema({
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
      'custom_percentage'
    ],
    required: true
  },
  customAllocations: [CustomAllocationSchema],
  isRecurring: { type: Boolean, default: true },
  startTerm: Number,
  endTerm: Number,
  trackOwnerExpense: { type: Boolean, default: false },
  ownerAmount: { type: Number, default: 0 },
  notes: String
});

const ContractorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  company: String,
  specialty: {
    type: String,
    enum: [
      'plumber',
      'electrician',
      'elevator',
      'painter',
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
    enum: ['scheduled', 'in_progress', 'completed', 'cancelled'],
    default: 'scheduled'
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
  description: String
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
});

BuildingSchema.index({ realmId: 1 });
BuildingSchema.index({ realmId: 1, atakPrefix: 1 });
BuildingSchema.index({ realmId: 1, name: 1 });

export default mongoose.model<CollectionTypes.Building>(
  'Building',
  BuildingSchema
);
