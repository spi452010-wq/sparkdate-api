import { Schema, model } from 'mongoose';
const bookingSchema = new Schema({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  gender: { type: String, enum: ['male', 'female'], required: true },
  status: { type: String, enum: ['pending', 'confirmed', 'cancelled', 'expired', 'refunded'], default: 'pending' },
  holdExpiresAt: Date, paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
  amountInPaise: { type: Number, default: 0 }, datesCompleted: { type: Number, default: 0 },
  refund: { status: String, requestedAt: Date, playOrderId: String },
}, { timestamps: true });
bookingSchema.index({ eventId: 1, userId: 1 }, { unique: true });
bookingSchema.index({ userId: 1, createdAt: -1 });
bookingSchema.index({ status: 1, holdExpiresAt: 1 });
export const Booking = model('Booking', bookingSchema);
