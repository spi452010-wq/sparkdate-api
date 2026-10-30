import { Schema, model } from 'mongoose';
/** Mutual connection after both liked/saved each other on a live date. One per user pair, ever (userA < userB). */
const connectionSchema = new Schema({
  userA: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  userB: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
  dateId: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });
connectionSchema.index({ userA: 1, userB: 1 }, { unique: true });
connectionSchema.index({ userA: 1, createdAt: -1 });
connectionSchema.index({ userB: 1, createdAt: -1 });
export const Connection = model('Connection', connectionSchema);
