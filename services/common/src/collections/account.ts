import * as bcrypt from 'bcrypt';
import mongoose, { CallbackError } from 'mongoose';
import { CollectionTypes } from '@microrealestate/types';
import logger from '../utils/logger.js';
import RealmModel from './realm.js';

const AccountSchema = new mongoose.Schema<CollectionTypes.Account>({
  firstname: {
    type: String,
    trim: true,
    required: true
  },
  lastname: {
    type: String,
    trim: true,
    required: true
  },
  email: {
    type: String,
    trim: true,
    required: true
  },
  password: {
    type: String,
    trim: true,
    required: true
  },
  createdDate: { type: Date, default: () => new Date(), required: true },
  // Stamped whenever the password changes. A refresh token carries the account in its
  // JWT payload and Redis keys it BY THE TOKEN VALUE, so there is no way to enumerate
  // (and therefore revoke) an account's live sessions. Comparing this timestamp against
  // the token's issued-at in the refresh path is what makes a password reset actually
  // end other sessions — previously a stolen refresh token kept minting fresh access
  // tokens indefinitely after the victim reset their password.
  passwordChangedAt: { type: Date }
});

AccountSchema.index({ email: 1 }, { unique: true });

AccountSchema.pre('save', function (next) {
  if (!this.createdDate) {
    this.createdDate = new Date();
  }
  this.email = this.email.toLowerCase();
  // Only hash the password when it is being set (create) or modified
  // (password reset). Re-hashing an already-hashed value on unrelated
  // saves (e.g. profile updates) would silently invalidate the user's
  // credentials — bcrypt.hash of a bcrypt hash is a different hash.
  // This is the same root cause referenced in the May-2026 double-hash
  // incident captured in CLAUDE.md.
  if (this.isModified('password')) {
    this.password = bcrypt.hashSync(this.password, 10);
    // Only stamp on a REAL change, and never on the initial create (there are no
    // sessions to revoke yet, and stamping would invalidate the token issued moments
    // later by signup).
    if (!this.isNew) {
      this.passwordChangedAt = new Date();
    }
  }
  next();
});

AccountSchema.post('save', function (account) {
  const name = `${account.firstname} ${account.lastname}`;
  RealmModel.updateMany(
    {
      members: {
        $elemMatch: { email: account.email }
      }
    },
    {
      $set: {
        'members.$.registered': true,
        'members.$.name': name
      }
    },
    (error: CallbackError) => {
      if (error) {
        logger.error(String(error));
      }
    }
  );
});

export default mongoose.model<CollectionTypes.Account>(
  'Account',
  AccountSchema
);
