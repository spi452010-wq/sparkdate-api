import { Schema, model } from 'mongoose';
/** One live video date (a pair in one round). The unique (eventId, pairKey) index guarantees no pair meets twice per event. */
const decision = { type: String, enum: ['like', 'pass', 'save'] };
const dateSchema = new Schema({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
  round: { type: Number, required: true, min: 1 },
  userA: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // userA < userB
  userB: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  pairKey: { type: String, required: true },
  room: { type: String, required: true },
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  decisionDeadline: { type: Date, required: true },
  endedAt: Date,
  endReason: { type: String, enum: ['completed', 'early_disconnect', 'early_end'] },
  leftBy: { type: Schema.Types.ObjectId, ref: 'User' },
  leftReason: { type: String, enum: ['disconnect', 'left'] },
  callSec: Number,
  counted: { type: Boolean, default: false }, // datesCompleted already incremented
  decisionA: decision, decisionB: decision,
  decidedAt: Date, // round.decide processed this date
}, { timestamps: true });
dateSchema.index({ eventId: 1, pairKey: 1 }, { unique: true });
dateSchema.index({ eventId: 1, round: 1 });
dateSchema.index({ eventId: 1, userA: 1, endedAt: 1 });
dateSchema.index({ eventId: 1, userB: 1, endedAt: 1 });
export const LiveDate = model('LiveDate', dateSchema);
