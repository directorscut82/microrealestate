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
  createdDate: { type: Date, default: () => new Date(), required: true }
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
