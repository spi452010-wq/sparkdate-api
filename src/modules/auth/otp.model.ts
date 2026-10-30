import { Schema, model } from 'mongoose';
// One active OTP per phone. A new request overwrites (invalidates) the old one.
const otpSchema = new Schema({
  phone: { type: String, required: true, unique: true },
  codeHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  lastSentAt: { type: Date, required: true },
  sendLog: { type: [Date], default: [] },   // sends in the last hour
  lockedUntil: Date,
});
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 }); // cleanup an hour after expiry
export const Otp = model('Otp', otpSchema);
