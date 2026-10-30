import { AppError } from '../../utils/errors';
import { User } from '../auth/user.model';
import { signedUrl } from '../media/signing';

// Keys must belong to the caller: no attaching someone else's photo.
const ownKeys = (uid: string, keys?: string[]) => {
  if (keys?.some((k) => !k.startsWith(`photos/${uid}/`))) throw new AppError(403, 'MEDIA_NOT_OWNED');
  return keys?.map((k, i) => ({ key: k, order: i }));
};
const profileOut = (p: any) => p && ({ ...(p.toObject?.() ?? p), photos: (p.photos ?? []).map((x: any) => ({ key: x.key, order: x.order, url: signedUrl(x.key) })) });
// Own profile only (always req.user.id); never another user's data.
export const meOut = (u: any) => ({ id: String(u._id), phone: u.phone, email: u.email, role: u.role, profile: profileOut(u.profile), profileCompleted: u.profileCompleted, verification: { status: u.verification?.status ?? 'none', reason: u.verification?.reason } });

export async function getMe(userId: string) { return meOut(await User.findById(userId)); }

export async function completeProfile(userId: string, body: any) {
  // Idempotent: completing twice just overwrites; one user doc, never duplicates.
  const u = await User.findOneAndUpdate({ _id: userId, profileCompleted: false },
    { profile: { ...body, photos: ownKeys(userId, body.photos) }, profileCompleted: true }, { new: true, runValidators: true });
  if (!u) throw new AppError(409, 'PROFILE_ALREADY_COMPLETED', 'Use PATCH /profile/me to edit');
  return meOut(u);
}

export async function updateProfile(userId: string, patch: any) {
  const cur = await User.findById(userId);
  if (!cur?.profileCompleted) throw new AppError(409, 'PROFILE_INCOMPLETE');
  const body = { ...patch }; if (body.photos) body.photos = ownKeys(userId, body.photos);
  const set = Object.fromEntries(Object.entries(body).map(([k, v]) => [`profile.${k}`, v]));
  return meOut(await User.findByIdAndUpdate(userId, { $set: set }, { new: true, runValidators: true }));
}

export async function submitVerification(userId: string, selfieKey: string) {
  if (!selfieKey.startsWith(`selfies/${userId}/`)) throw new AppError(403, 'MEDIA_NOT_OWNED');
  const u = await User.findOneAndUpdate({ _id: userId, profileCompleted: true, 'verification.status': { $in: ['none', 'rejected'] } },
    { verification: { status: 'pending', selfieKey } }, { new: true });
  if (!u) throw new AppError(409, 'VERIFICATION_NOT_ALLOWED', 'Profile incomplete or verification already pending/approved');
  return { status: 'pending' };
}

export async function assertProfileCompleted(userId: string) {
  const u = await User.findById(userId).select('profileCompleted');
  if (!u?.profileCompleted) throw new AppError(403, 'PROFILE_INCOMPLETE');
}
