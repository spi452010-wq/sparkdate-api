import { Schema, model, InferSchemaType } from 'mongoose';

const userSchema = new Schema({
  phone: { type: String },            // E.164, e.g. +919876543210
  email: { type: String, lowercase: true, trim: true },
  googleSub: { type: String },
  passwordHash: { type: String, select: false }, // admin/host web login only
  failedLogins: { type: Number, default: 0, select: false },
  lockedUntil: { type: Date, select: false },
  role: { type: String, enum: ['user', 'host', 'admin'], default: 'user' },
  status: { type: String, enum: ['active', 'blocked'], default: 'active' },
  profile: {
    fullName: { type: String, trim: true, maxlength: 50 },
    gender: { type: String, enum: ['male', 'female'] },
    interestedIn: { type: String, enum: ['male', 'female'] },
    dob: Date,
    bio: { type: String, maxlength: 300 },
    city: { type: String, maxlength: 60 },
    interests: { type: [String], default: [] },
    photos: { type: [{ key: String, order: Number, _id: false }], default: [] },
  },
  profileCompleted: { type: Boolean, default: false },
  verification: {
    status: { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },
    selfieKey: String,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reason: String,
  },
}, { timestamps: true });

userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ googleSub: 1 }, { unique: true, partialFilterExpression: { googleSub: { $type: 'string' } } });
userSchema.index({ 'verification.status': 1, createdAt: -1 });
userSchema.index({ status: 1 });
userSchema.index({ 'profile.fullName': 1 });

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = model('User', userSchema);
