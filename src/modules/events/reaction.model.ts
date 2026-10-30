import { Schema, model } from 'mongoose';
const s = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
  kind: { type: String, enum: ['like', 'save'], required: true },
}, { timestamps: true, collection: 'event_reactions' });
s.index({ userId: 1, eventId: 1, kind: 1 }, { unique: true });
s.index({ userId: 1, kind: 1, createdAt: -1 });
export const EventReaction = model('EventReaction', s);
