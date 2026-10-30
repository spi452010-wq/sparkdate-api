import { Schema, model } from 'mongoose';
/** One user blocking another. Matching excludes the pair in both directions. */
const blockSchema = new Schema({
  blockerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  blockedId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
blockSchema.index({ blockedId: 1 });
export const Block = model('Block', blockSchema);
