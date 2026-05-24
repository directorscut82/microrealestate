import { CollectionTypes } from '@microrealestate/types';
import mongoose from 'mongoose';
import Realm from './realm.js';

const LeaseSchema = new mongoose.Schema<CollectionTypes.Lease>({
  realmId: { type: String, ref: Realm },
  name: String,
  description: String,
  numberOfTerms: { type: Number, required: true, min: 1 },
  timeRange: { type: String, enum: ['days', 'weeks', 'months', 'years'] },
  active: Boolean,

  // ui state
  stepperMode: { type: Boolean, default: false }
});

LeaseSchema.index({ realmId: 1 });
// Within a realm, lease names must be unique so duplicate creates fail with a
// clean conflict instead of corrupting the manager's update-time validation.
LeaseSchema.index({ realmId: 1, name: 1 }, { unique: true });

export default mongoose.model<CollectionTypes.Lease>('Lease', LeaseSchema);
