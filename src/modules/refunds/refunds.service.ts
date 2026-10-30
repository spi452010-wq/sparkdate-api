import { Page } from './refunds.types';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { getQueue, jobId } from '../../jobs/queue';
import { getPlayClient, mapPlayError, ProductPurchase, SubscriptionPurchase } from '../../integrations/play';
import { notify } from '../notifications/notifications.service';
import { releaseTo, eventEnd, requestRefund } from '../bookings/bookings.service';
import { refundPayment, linkPayment } from '../payments/payments.service';
export { linkPayment };
import { userRepository } from '../users/users.repository';
import { eventRepository } from '../events/events.repository';
import { bookingRepository } from '../bookings/bookings.repository';
import { paymentRepository } from '../payments/payments.repository';

const MIN = 60_000;
export async function approveRefund(bookingId: string, adminId: string | null, auto = false) {
  const b = await bookingRepository.findOneAndUpdate({ _id: bookingId, status: 'refund_requested', 'refund.status': { $in: ['requested', 'failed'] } },
    { $set: { 'refund.status': 'processing', 'refund.decidedBy': adminId ?? undefined, 'refund.decidedAt': new Date(), 'refund.auto': auto } }, { new: true });
  if (!b) throw new AppError(409, 'REFUND_NOT_PENDING');
  const pay = await paymentRepository.findById(b.paymentId);
  try {
    if (!pay?.orderId) throw new AppError(409, 'PAYMENT_NOT_FOUND');
    if (pay.status !== 'refunded') await getPlayClient().refundOrder(pay.orderId);
  } catch (e) {
    await bookingRepository.updateOne({ _id: b._id, 'refund.status': 'processing' }, { $set: { 'refund.status': 'failed' } });
    throw mapPlayError(e);
  }
  await paymentRepository.updateOne({ _id: pay._id }, { status: 'refunded', refundedAt: new Date() });
  const done = await bookingRepository.findOneAndUpdate({ _id: b._id }, { $set: { status: 'refunded', 'refund.status': 'processed', 'refund.playOrderId': pay.orderId } }, { new: true });
  await notify({ userId: String(b.userId), type: 'refund_processed', title: 'Refund processed', body: 'Your ticket amount is on its way back via Google Play', data: { bookingId }, dedupeKey: jobId('refund_processed', bookingId) });
  return done!;
}
export async function rejectRefund(bookingId: string, adminId: string, reason: string) {
  const b = await bookingRepository.findOneAndUpdate({ _id: bookingId, status: 'refund_requested', 'refund.status': { $in: ['requested', 'failed'] } },
    { $set: { status: 'confirmed', 'refund.status': 'rejected', 'refund.rejectReason': reason, 'refund.decidedBy': adminId, 'refund.decidedAt': new Date() } }, { new: true });
  if (!b) throw new AppError(409, 'REFUND_NOT_PENDING');
  await notify({ userId: String(b.userId), type: 'refund_rejected', title: 'Refund request declined', body: reason, data: { bookingId }, dedupeKey: jobId('refund_rejected', bookingId) });
  return b;
}

/** event.finalize job: computes refundEligible at event end. attendedAt is set by the live-session module. */
export async function finalizeEvent(eventId: string) {
  const ev = await eventRepository.findById(eventId);
  if (!ev || ev.status === 'cancelled') return;
  const end = eventEnd(ev);
  if (Date.now() < +end) { await getQueue().add('event.finalize', { eventId }, { jobId: jobId('finalize', eventId, +end), delayMs: +end - Date.now() }); return; }
  const filter = { eventId: ev._id, status: 'confirmed', amountInPaise: { $gt: 0 }, paymentId: { $exists: true }, datesCompleted: 0, attendedAt: { $exists: true }, refundEligible: false };
  const ids = (await bookingRepository.find(filter).select('_id userId')).map((b) => b);
  await bookingRepository.updateMany(filter, { $set: { refundEligible: true } });
  if (env.AUTO_REFUND_NO_MATCH === 'true')
    for (const b of ids) await requestRefund(String(b.userId), String(b._id), 'no_match').catch((err) => logger.warn({ err }, 'auto refund request failed'));
}

/** Admin cancel: pending holds released, free bookings cancelled, paid bookings refunded. Re-runnable. */
export async function cancelEvent(eventId: string, adminId: string) {
  const ev = await eventRepository.findOneAndUpdate({ _id: eventId, status: { $in: ['draft', 'published', 'cancelled'] } }, { $set: { status: 'cancelled' } }, { new: true });
  if (!ev) { if (await eventRepository.exists({ _id: eventId })) throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Live or ended events cannot be cancelled'); throw new AppError(404, 'NOT_FOUND'); }
  const sum = { cancelledPending: 0, cancelledFree: 0, refunded: 0, refundFailed: 0 };
  const list = await bookingRepository.find({ eventId, status: { $in: ['pending', 'confirmed', 'refund_requested'] } });
  const msg = (b: any, body: string) => notify({ userId: String(b.userId), type: 'event_cancelled', title: `${ev.title} was cancelled`, body, data: { eventId, bookingId: String(b._id) }, dedupeKey: jobId('event_cancelled', String(b._id)) });
  for (const b of list) {
    if (b.status === 'pending') { if (await releaseTo(b._id, ['pending'], 'cancelled')) { sum.cancelledPending++; await msg(b, 'Your seat hold was released'); } continue; }
    const paid = b.amountInPaise > 0 && !!b.paymentId;
    const now = new Date();
    const x = await bookingRepository.findOneAndUpdate({ _id: b._id, status: { $in: ['confirmed', 'refund_requested'] } },
      { $set: { status: 'cancelled_by_admin', cancelledAt: now, ...(paid ? { refund: { status: 'processing', reason: 'event_cancelled', requestedAt: now, decidedBy: adminId, decidedAt: now, auto: true } } : {}) } }, { new: true });
    if (!x) continue;
    if (!paid) { sum.cancelledFree++; await msg(x, 'Sorry, this event was cancelled'); continue; }
    const pay = await paymentRepository.findById(b.paymentId);
    const ok = pay ? await refundPayment(pay) : false;
    await bookingRepository.updateOne({ _id: x._id }, { $set: { 'refund.status': ok ? 'processed' : 'failed', 'refund.playOrderId': pay?.orderId } });
    if (ok) sum.refunded++; else sum.refundFailed++;
    await msg(x, ok ? 'Your payment has been refunded via Google Play' : 'Your refund is being processed');
  }
  return { event: ev, summary: sum };
}

// ---------- admin lists ----------
const USER_MATCH_CAP = 200;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Search users by name/phone/email; returns capped id list (null = no q given). */
async function userIdsFor(q?: string): Promise<Types.ObjectId[] | null> {
  if (!q) return null;
  const re = new RegExp(escapeRe(q), 'i');
  const users = await userRepository.find({ $or: [{ 'profile.fullName': re }, { phone: re }, { email: re }] }).select('_id').limit(USER_MATCH_CAP).lean();
  return users.map((u) => u._id as Types.ObjectId);
}
export async function listRefunds({ status, q: search, page, limit }: Page & { status?: string; q?: string }) {
  const q: any = { 'refund.status': status ?? { $exists: true } };
  const ids = await userIdsFor(search); if (ids) q.userId = { $in: ids };
  const [items, total] = await Promise.all([
    bookingRepository.find(q).sort({ 'refund.requestedAt': -1 }).skip((page - 1) * limit).limit(limit).populate('userId', 'profile.fullName phone').populate('eventId', 'title startsAt'),
    bookingRepository.countDocuments(q)]);
  return { items, page, limit, total };
}
export async function listPayments({ userId, eventId, status, q: search, page, limit }: Page & { userId?: string; eventId?: string; status?: string; q?: string }) {
  const q: any = {}; if (status) q.status = status;
  const ids = await userIdsFor(search);
  if (ids) q.userId = { $in: userId ? ids.filter((i) => String(i) === userId) : ids };
  else if (userId) q.userId = new Types.ObjectId(userId);
  if (eventId) q.bookingId = { $in: await bookingRepository.find({ eventId }).distinct('_id') };
  const [items, total] = await Promise.all([
    paymentRepository.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('-purchaseToken').populate('userId', 'profile.fullName phone').lean(),
    paymentRepository.countDocuments(q)]);
  return { items, page, limit, total };
}
