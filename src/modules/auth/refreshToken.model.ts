import { Schema, model } from 'mongoose';
const rtSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  tokenHash: { type: String, required: true, unique: true },
  family: { type: String, required: true },   // rotation chain id; reuse revokes the whole family
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
  replacedBy: String,
}, { timestamps: true });
rtSchema.index({ user: 1 });
rtSchema.index({ family: 1 });
rtSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const RefreshToken = model('RefreshToken', rtSchema);
