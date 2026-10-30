import { Schema, model } from 'mongoose';
const seats = { male: { type: Number, required: true, min: 0 }, female: { type: Number, required: true, min: 0 } };
const eventSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 80 },
  city: { type: String, trim: true, maxlength: 60 },
  description: { type: String, maxlength: 1000, default: '' },
  startsAt: { type: Date, required: true },
  endsAt: Date,
  roundMinutes: { type: Number, default: 3, min: 1, max: 30 },
  priceInPaise: { type: Number, default: 0, min: 0 },
  playProductId: { type: String, default: null },
  status: { type: String, enum: ['draft', 'published', 'live', 'ended', 'cancelled'], default: 'draft' },
  capacity: seats,
  booked: { male: { type: Number, default: 0, min: 0 }, female: { type: Number, default: 0, min: 0 } },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
eventSchema.index({ status: 1, startsAt: 1 });
eventSchema.index({ createdBy: 1, startsAt: -1 });
eventSchema.index({ status: 1, city: 1, startsAt: 1 });
export const Event = model('Event', eventSchema);

