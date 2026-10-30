import { signedUrl } from '../media/media.service';
import { userRepository } from './users.repository';
import { Gender } from './users.types';

/** Public API of the users module for other modules (Sprint 3 live session). */
export interface AuthUser { id: string; role: string; status: string }
export async function getAuthUser(id: string): Promise<AuthUser | null> {
  const u = await userRepository.findById(id).select('role status').lean();
  return u ? { id: String(u._id), role: u.role as string, status: u.status as string } : null;
}

export interface LiveProfile {
  id: string; fullName: string | null; age: number | null; city: string | null; photoUrl: string | null; interests: string[]; bio: string | null;
  gender: Gender | null; interestedCity?: string | null; profession?: string | null;
}
const age = (dob?: Date | null, now = new Date()) => {
  if (!dob) return null;
  let a = now.getFullYear() - dob.getFullYear();
  if (now.getMonth() < dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())) a--;
  return a;
};
/** Partner-card fields only (no phone, email, dob, verification data). Photo URL is short-lived and signed. */
export async function liveProfiles(ids: string[]): Promise<Map<string, LiveProfile>> {
  const rows = await userRepository.find({ _id: { $in: ids }, status: 'active' })
    .select('profile.fullName profile.dob profile.city profile.photos profile.interests profile.gender profile.bio').lean();
  const m = new Map<string, LiveProfile>();
  for (const u of rows) {
    const p: any = u.profile ?? {};
    const photo = [...(p.photos ?? [])].sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))[0];
    m.set(String(u._id), { id: String(u._id), fullName: p.fullName ?? null, age: age(p.dob), city: p.city ?? null,
      photoUrl: photo?.key ? signedUrl(photo.key) : null, interests: p.interests ?? [], bio: p.bio ?? null, gender: p.gender ?? null,
      // Not in the profile schema yet; the matcher scores them once the profile collects them.
      interestedCity: p.interestedCity ?? null, profession: p.profession ?? null });
  }
  return m;
}
