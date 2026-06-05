import { CollectionTypes } from '@microrealestate/types';
import Lease from './lease.js';
import mongoose from 'mongoose';
import Property from './property.js';
import Realm from './realm.js';

const TenantSchema = new mongoose.Schema<CollectionTypes.Tenant>({
  // Organization
  realmId: { type: String, ref: Realm },

  // individual details
  name: String,
  firstName: String,
  lastName: String,
  taxId: String,
  phone: String,
  email: String,

  // company details
  isCompany: Boolean,
  company: String,
  manager: String,
  legalForm: String,
  siret: String,
  rcs: String,
  capital: Number,

  // address
  street1: String,
  street2: String,
  zipCode: String,
  city: String,
  country: String,

  // contacts
  contacts: [
    {
      contact: String,
      phone: String,
      phone1: String,
      phone2: String,
      email: String,
      // E12: free-form per-contact notes ("ask for John when calling",
      // "secondary speaks French", etc.). The landlord UI's contact
      // form already binds this field; without a schema entry every
      // PATCH silently dropped it on save and the user assumed the
      // backend was lying about persisting their input.
      notes: String
    }
  ],

  // contract
  reference: String,
  contract: String,
  leaseId: { type: String, ref: Lease },
  beginDate: Date,
  endDate: Date,
  terminationDate: Date,
  // Rent term frequency for the contract math. Without this field, payloads
  // setting frequency = 'weeks'/'days'/etc. were silently lost on save and
  // every reload computed terms as months.
  frequency: {
    type: String,
    enum: ['days', 'weeks', 'months', 'years', 'hours'],
    default: 'months'
  },
  properties: [
    {
      _id: false,
      propertyId: { type: String, ref: Property },
      property: Property.schema,
      rent: Number,
      expenses: [
        {
          _id: false,
          title: String,
          amount: Number,
          beginDate: Date,
          endDate: Date
        }
      ],
      entryDate: Date,
      exitDate: Date
    }
  ],
  // rents: [
  //   {
  //     term: Number,
  //     preTaxAmounts: [
  //       {
  //         amount: Number,
  //         description: String
  //       }
  //     ],
  //     charges: [
  //       {
  //         amount: Number,
  //         description: String
  //       }
  //     ],
  //     debts: [
  //       {
  //         amount: Number,
  //         description: String
  //       }
  //     ],
  //     discounts: [
  //       {
  //         origin: String,
  //         amount: Number,
  //         description: String
  //       }
  //     ],
  //     vats: [
  //       {
  //         origin: String,
  //         amount: Number,
  //         description: String,
  //         rate: Number
  //       }
  //     ],
  //     payments: [
  //       {
  //         date: Date,
  //         type: String,
  //         reference: String,
  //         amount: Number
  //       }
  //     ],
  //     total: {
  //       preTaxAmount: Number,
  //       charges: Number,
  //       vat: Number,
  //       discount: Number,
  //       debts: Number,
  //       balance: Number,
  //       grandTotal: Number,
  //       payment: Number
  //     }
  //   }
  // ],
  rents: [mongoose.Schema.Types.Mixed],

  // billing
  isVat: Boolean,
  vatRatio: Number,
  discount: Number,
  guaranty: Number,
  guarantyPayback: Number,

  // Greek lease import fields
  declarationNumber: String,
  amendsDeclaration: String,
  originalLeaseStartDate: Date,
  leaseNotes: String,
  coTenants: [
    {
      _id: false,
      name: String,
      taxId: String,
      acceptanceDate: Date
    }
  ],

  // ui state
  stepperMode: { type: Boolean, default: false },
  archived: { type: Boolean, default: false }
});

TenantSchema.index({ realmId: 1 });
TenantSchema.index({ realmId: 1, name: 1 });
TenantSchema.index({ leaseId: 1 });
TenantSchema.index({ 'properties.propertyId': 1 });

// Embedding `Property.schema` inside `properties[].property` causes Mongoose
// to inherit Property's unique compound index on (realmId, atakNumber). On
// the embedded path that becomes
// `properties.property.realmId_1_properties.property.atakNumber_1` and
// without a partialFilterExpression it throws E11000 the moment two tenants
// have null atakNumbers (any two tenants with no Greek property data).
// Re-declare the index here with the same partial filter as Property so the
// uniqueness constraint only applies to real ATAK strings.
//
// NOTE: drop the broken index manually before this file's index definition
// can take effect:
//   finch exec microrealestate-mongo-1 mongo mredb --quiet --eval \
//     'db.occupants.dropIndex("properties.property.realmId_1_properties.property.atakNumber_1")'
TenantSchema.index(
  {
    'properties.property.realmId': 1,
    'properties.property.atakNumber': 1
  },
  {
    unique: true,
    partialFilterExpression: {
      'properties.property.atakNumber': {
        $exists: true,
        $type: 'string',
        $gt: ''
      }
    }
  }
);

export default mongoose.model<CollectionTypes.Tenant>('Occupant', TenantSchema);
