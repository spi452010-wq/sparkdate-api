import { Schema, model } from 'mongoose';
const s = new Schema({
  source: { type: String, default: 'play' },
  messageId: { type: String, required: true },
  payload: Schema.Types.Mixed,
  status: { type: String, enum: ['received', 'processed', 'ignored', 'failed'], default: 'received' },
  error: String, processedAt: Date,
}, { timestamps: true, collection: 'webhook_events' });
s.index({ source: 1, messageId: 1 }, { unique: true });
s.index({ status: 1, createdAt: 1 });
s.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 });
export const WebhookEvent = model('WebhookEvent', s);
