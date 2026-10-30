import { AppError } from '../../utils/errors';
import { signedUrl } from '../media/media.service';
import { userRepository } from '../users/users.repository';
import { eventRepository } from '../events/events.repository';
import { bookingRepository } from '../bookings/bookings.repository';

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function listUsers({ verification, status, page, limit, q: search }: any) {
  const q: any = {};
  if (search) { const rx = new RegExp(escapeRegex(search), 'i'); q.$or = [{ 'profile.fullName': rx }, { phone: rx }, { email: rx }]; }
  if (verification) q['verification.status'] = verification; if (status) q.status = status;
  const [items, total] = await Promise.all([
    userRepository.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('phone email role status profile profileCompleted verification createdAt'),
    userRepository.countDocuments(q)]);
  return { items: items.map((u: any) => ({ ...u.toObject(), id: String(u._id), profile: u.profile && { ...u.profile.toObject(), photos: (u.profile.photos ?? []).map((p: any) => ({ key: p.key, order: p.order, url: signedUrl(p.key) })) }, selfieUrl: u.verification?.selfieKey ? signedUrl(u.verification.selfieKey) : undefined })), page, limit, total };
}

export async function stats() {
  const [totalUsers, pendingVerifications, publishedEvents, liveEvents, pendingRefunds] = await Promise.all([
    userRepository.countDocuments({ role: 'user' }), userRepository.countDocuments({ 'verification.status': 'pending' }),
    eventRepository.countDocuments({ status: 'published' }), eventRepository.countDocuments({ status: 'live' }), bookingRepository.countDocuments({ 'refund.status': { $in: ['requested', 'failed'] } })]);
  // Reports module arrives in a later sprint.
  return { totalUsers, pendingVerifications, publishedEvents, liveEvents, openReports: 0, pendingRefunds };
}

export async function decideVerification(userId: string, reviewerId: string, decision: string, reason?: string) {
  const u = await userRepository.findOneAndUpdate({ _id: userId, 'verification.status': 'pending' },
    { 'verification.status': decision, 'verification.reason': reason, 'verification.reviewedBy': reviewerId, 'verification.reviewedAt': new Date() }, { new: true });
  if (!u) throw new AppError(404, 'NO_PENDING_VERIFICATION');
  return { id: String(u._id), verification: u.verification };
}

export async function setUserStatus(userId: string, actorId: string, status: string) {
  if (userId === actorId) throw new AppError(400, 'CANNOT_CHANGE_SELF');
  const u = await userRepository.findByIdAndUpdate(userId, { status }, { new: true });
  if (!u) throw new AppError(404, 'NOT_FOUND');
  return { id: String(u._id), status: u.status };
}
