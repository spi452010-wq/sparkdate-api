import { Schema, model } from 'mongoose';
const paymentSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking' },
  kind: { type: String, enum: ['ticket', 'chat_pass'], required: true },
  productId: { type: String, required: true },
  purchaseToken: { type: String, required: true },
  orderId: String,
  amountInPaise: { type: Number, default: 0 },
  status: { type: String, enum: ['verified', 'unlinked', 'refunded', 'refund_failed', 'voided'], default: 'verified' },
  acknowledged: { type: Boolean, default: false },
  purchaseTime: Date,
  refundedAt: Date, voidedAt: Date,
  /** Set by payment.reconcile when an unlinked purchase still has no booking: needs admin attention. */
  flaggedAt: Date,
}, { timestamps: true });
// A purchase token can be redeemed exactly once.
paymentSchema.index({ purchaseToken: 1 }, { unique: true });
paymentSchema.index({ userId: 1, createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 }); // also serves the admin 'unlinked' alert list
paymentSchema.index({ bookingId: 1 });
paymentSchema.index({ orderId: 1 }, { partialFilterExpression: { orderId: { $type: 'string' } } });
paymentSchema.index({ acknowledged: 1, createdAt: 1 });
export const Payment = model('Payment', paymentSchema);
