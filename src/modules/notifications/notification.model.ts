import { Schema, model } from 'mongoose';
const s = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, required: true },
  title: { type: String, required: true }, body: { type: String, default: '' },
  data: { type: Schema.Types.Mixed, default: {} },
  dedupeKey: String, readAt: Date,
}, { timestamps: true });
s.index({ userId: 1, createdAt: -1 });
// Same logical notification (e.g. a reminder job retried) is stored once.
s.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
s.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 86400 });
export const Notification = model('Notification', s);
