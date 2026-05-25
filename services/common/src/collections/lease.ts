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
// Within a realm, lease names should be unique. The previous `unique: true`
// constraint crash-looped pdfgenerator when existing data already contained
// duplicate (realmId, name) pairs (E11000 on index build → process exit).
// Relaxed to a non-unique compound index for now; uniqueness is enforced at
// the manager layer (leasemanager.add/update). To reinstate the DB-level
// unique constraint, a one-shot migration must dedupe existing rows first.
LeaseSchema.index({ realmId: 1, name: 1 });

export default mongoose.model<CollectionTypes.Lease>('Lease', LeaseSchema);
