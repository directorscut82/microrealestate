import { CollectionTypes } from '@microrealestate/types';
import mongoose from 'mongoose';
import Realm from './realm.js';

const PropertySchema = new mongoose.Schema<CollectionTypes.Property>({
  realmId: { type: String, ref: Realm },

  type: String,
  name: String,
  description: String,
  surface: Number,
  landSurface: Number,
  phone: String,
  digicode: String,
  address: {
    _id: false,
    street1: String,
    street2: String,
    zipCode: String,
    city: String,
    state: String,
    country: String
  },

  price: Number,
  atakNumber: String,
  altAtakNumbers: [String],
  // L9: cadastral code (Κ.Α.Ε.Κ.) emitted by the National Cadastre.
  // Optional and untyped beyond String — different vintages of E9 use
  // 12-25 digit identifiers. Stored alongside ATAK so both identifiers
  // are queryable without re-parsing the PDF.
  kaek: String,
  dehNumber: String,
  buildingId: String,
  electricitySupplyNumber: String,
  energyCertificate: {
    _id: false,
    number: String,
    issueDate: Date,
    energyClass: String,
    inspectorNumber: String
  }
});

PropertySchema.index({ realmId: 1 });
PropertySchema.index({ realmId: 1, name: 1 });
// Within a realm, the cadastral ATAK number identifies a property uniquely.
// Partial index so legacy/null atakNumbers are excluded from the uniqueness
// constraint (sparse alone treats compound-null as a value in Mongo 4.4).
PropertySchema.index(
  { realmId: 1, atakNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      atakNumber: { $exists: true, $type: 'string', $gt: '' }
    }
  }
);

export default mongoose.model<CollectionTypes.Property>(
  'Property',
  PropertySchema
);
