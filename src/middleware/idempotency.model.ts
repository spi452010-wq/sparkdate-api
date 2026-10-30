import { Schema, model } from 'mongoose';
const s = new Schema({
  userId: { type: String, required: true }, key: { type: String, required: true }, route: { type: String, required: true },
  state: { type: String, enum: ['pending', 'done'], default: 'pending' }, status: Number, body: Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
}, { collection: 'idempotency_keys' });
s.index({ userId: 1, key: 1 }, { unique: true });
s.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 3600 });
export const IdempotencyKey = model('IdempotencyKey', s);
