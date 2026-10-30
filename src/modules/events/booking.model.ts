import { Schema, model } from 'mongoose';
export const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'expired', 'refund_requested', 'refunded', 'cancelled_by_admin'] as const;
const bookingSchema = new Schema({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  gender: { type: String, enum: ['male', 'female'], required: true },
  status: { type: String, enum: BOOKING_STATUSES, default: 'pending' },
  holdExpiresAt: Date, paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' }, playOrderId: String,
  amountInPaise: { type: Number, default: 0 }, datesCompleted: { type: Number, default: 0 },
  attendedAt: Date, // set by the live-session module when the user joins the waiting room
  refundEligible: { type: Boolean, default: false },
  confirmedAt: Date, cancelledAt: Date,
  refund: {
    status: { type: String, enum: ['requested', 'processing', 'processed', 'rejected', 'failed'] },
    reason: String, requestedAt: Date, decidedBy: { type: Schema.Types.ObjectId, ref: 'User' }, decidedAt: Date,
    rejectReason: String, playOrderId: String, auto: Boolean,
  },
}, { timestamps: true });
bookingSchema.index({ eventId: 1, userId: 1 }, { unique: true });
bookingSchema.index({ userId: 1, createdAt: -1 });
bookingSchema.index({ status: 1, holdExpiresAt: 1 });
bookingSchema.index({ eventId: 1, status: 1 });
bookingSchema.index({ 'refund.status': 1, 'refund.requestedAt': -1 });
export const Booking = model('Booking', bookingSchema);
