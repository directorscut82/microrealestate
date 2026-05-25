import * as bcrypt from 'bcrypt';
import { CollectionTypes } from '@microrealestate/types';
import mongoose from 'mongoose';

// Valid roles for realm members and applications. Mongoose String fields
// without an enum accept anything (including arbitrary strings from a
// payload manipulation), which can silently bypass the role checks in
// middlewares.ts. Pin to the canonical set documented in CLAUDE.md.
const REALM_ROLES = ['administrator', 'renter', 'tenant'] as const;

const RealmSchema = new mongoose.Schema<CollectionTypes.Realm>({
  name: String,
  members: [
    {
      name: String,
      email: String,
      role: {
        type: String,
        enum: REALM_ROLES,
        required: true,
        default: 'renter'
      },
      registered: Boolean
    }
  ],
  applications: [
    {
      name: String,
      role: {
        type: String,
        enum: REALM_ROLES,
        required: true,
        default: 'renter'
      },
      clientId: String,
      clientSecret: String,
      createdDate: Date,
      expiryDate: Date
    }
  ],
  addresses: [
    {
      street1: String,
      street2: String,
      zipCode: String,
      city: String,
      state: String,
      country: String
    }
  ],
  bankInfo: {
    name: String,
    iban: String
  },
  contacts: [
    {
      name: String,
      email: String,
      phone1: String,
      phone2: String
    }
  ],
  isCompany: Boolean,
  companyInfo: {
    name: String,
    legalStructure: String,
    legalRepresentative: String,
    capital: Number,
    ein: String,
    dos: String,
    vatNumber: String
  },
  thirdParties: {
    gmail: {
      selected: Boolean,
      email: String,
      appPassword: String,
      fromEmail: String,
      replyToEmail: String
    },
    smtp: {
      selected: Boolean,
      server: String,
      port: Number,
      secure: Boolean,
      authentication: Boolean,
      username: String,
      password: String,
      fromEmail: String,
      replyToEmail: String
    },
    mailgun: {
      selected: Boolean,
      apiKey: String,
      domain: String,
      fromEmail: String,
      replyToEmail: String
    },
    b2: {
      keyId: String,
      applicationKey: String,
      endpoint: String,
      bucket: String
    },
    smsGateway: {
      selected: Boolean,
      url: String,
      username: String,
      password: String,
      countryCode: String // e.g., '+30', '+1'
    }
  },
  locale: String,
  currency: String
});

RealmSchema.index({ name: 1 });
RealmSchema.index({ 'members.email': 1 });

//
// hash application secrets before saving into database
RealmSchema.pre('save', function (next) {
  for (const app of this.applications) {
    // chick if first save to hash secret
    if (!app.createdDate) {
      app.createdDate = new Date();
      app.clientSecret = bcrypt.hashSync(app.clientSecret, 10);
    }
  }
  next();
});

export default mongoose.model<CollectionTypes.Realm>('Realm', RealmSchema);
