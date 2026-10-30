import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { asyncHandler, AppError } from '../../utils/errors';
import { User } from '../auth/user.model';
import { isValidKey } from '../media/storage';
import { signedUrl } from '../media/signing';

const r = Router();
r.use(requireAuth);

const age = (dob: Date) => { const n = new Date(); let a = n.getFullYear() - dob.getFullYear(); const m = n.getMonth() - dob.getMonth(); if (m < 0 || (m === 0 && n.getDate() < dob.getDate())) a--; return a; };
const key = z.string().refine(isValidKey, 'Invalid media key');
const base = {
  fullName: z.string().trim().min(2).max(50),
  gender: z.enum(['male', 'female']),
  interestedIn: z.enum(['male', 'female']),
  dob: z.coerce.date().refine((d) => age(d) >= 18 && age(d) <= 100, 'Must be 18 or older'),
  bio: z.string().trim().max(300).optional(),
  city: z.string().trim().max(60).optional(),
  interests: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  photos: z.array(key).min(1).max(6),
};
const completeSchema = z.object(base).strict();
// Gender and DOB are locked after completion (matching depends on them); admin can fix.
const updateSchema = z.object({ fullName: base.fullName, interestedIn: base.interestedIn, bio: base.bio, city: base.city, interests: base.interests, photos: base.photos }).partial().strict();

// Public-safe view of own profile (never leaks other users' data: always req.user.id)
// Keys must belong to the caller: no attaching someone else's photo.
const ownKeys = (uid: string, keys?: string[]) => {
  if (keys?.some((k) => !k.startsWith(`photos/${uid}/`))) throw new AppError(403, 'MEDIA_NOT_OWNED');
  return keys?.map((k, i) => ({ key: k, order: i }));
};
const profileOut = (p: any) => p && ({ ...(p.toObject?.() ?? p), photos: (p.photos ?? []).map((x: any) => ({ key: x.key, order: x.order, url: signedUrl(x.key) })) });
const me = (u: any) => ({ id: String(u._id), phone: u.phone, email: u.email, role: u.role, profile: profileOut(u.profile), profileCompleted: u.profileCompleted, verification: { status: u.verification?.status ?? 'none', reason: u.verification?.reason } });

r.get('/me', asyncHandler(async (req, res) => res.json(me(await User.findById(req.user.id)))));

r.put('/me', validate(completeSchema), asyncHandler(async (req, res) => {
  // Idempotent: completing twice just overwrites; one user doc, never duplicates.
  const u = await User.findOneAndUpdate({ _id: req.user.id, profileCompleted: false },
    { profile: { ...req.body, photos: ownKeys(req.user.id, req.body.photos) }, profileCompleted: true }, { new: true, runValidators: true });
  if (!u) throw new AppError(409, 'PROFILE_ALREADY_COMPLETED', 'Use PATCH /profile/me to edit');
  res.json(me(u));
}));

r.patch('/me', validate(updateSchema), asyncHandler(async (req, res) => {
  const cur = await User.findById(req.user.id);
  if (!cur?.profileCompleted) throw new AppError(409, 'PROFILE_INCOMPLETE');
  const body = { ...req.body }; if (body.photos) body.photos = ownKeys(req.user.id, body.photos);
  const set = Object.fromEntries(Object.entries(body).map(([k, v]) => [`profile.${k}`, v]));
  res.json(me(await User.findByIdAndUpdate(req.user.id, { $set: set }, { new: true, runValidators: true })));
}));

r.post('/me/verification', validate(z.object({ selfieKey: key }).strict()), asyncHandler(async (req, res) => {
  if (!req.body.selfieKey.startsWith(`selfies/${req.user.id}/`)) throw new AppError(403, 'MEDIA_NOT_OWNED');
  const u = await User.findOneAndUpdate({ _id: req.user.id, profileCompleted: true, 'verification.status': { $in: ['none', 'rejected'] } },
    { verification: { status: 'pending', selfieKey: req.body.selfieKey } }, { new: true });
  if (!u) throw new AppError(409, 'VERIFICATION_NOT_ALLOWED', 'Profile incomplete or verification already pending/approved');
  res.status(202).json({ status: 'pending' });
}));

// Gate for later modules (events, booking): profile complete required.
export const requireCompletedProfile = asyncHandler(async (req: any, _res: any, next: any) => {
  const u = await User.findById(req.user.id).select('profileCompleted');
  if (!u?.profileCompleted) throw new AppError(403, 'PROFILE_INCOMPLETE');
  next();
});
export default r;
