import { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { getQueue, jobId } from '../../jobs/queue';
import { getPlayClient, mapPlayError, ProductPurchase, SubscriptionPurchase } from '../../integrations/play';
import { notify } from '../notifications/notifications.service';
import { approveRefund } from '../refunds/refunds.service';
import { appEvent, VISIBLE } from '../events/events.service';
import { bookingOut } from './booking.mapper';
import { userRepository } from '../users/users.repository';
import { eventRepository, reactionRepository, releaseSeat, reserveSeat } from '../events/events.repository';
import { bookingRepository } from './bookings.repository';

const MIN = 60_000;
export const eventEnd = (e: any) => new Date(e.endsAt ? +e.endsAt : +e.startsAt + 2 * 3600_000);

// ---------- seat hold / release ----------
/** Expire job id includes the hold time, so an extended hold simply gets a new job; stale jobs are no-ops. */
export async function scheduleExpire(b: any) {
  if (!b.holdExpiresAt) return;
  await getQueue().add('booking.expire', { bookingId: String(b._id) }, { jobId: jobId('expire', String(b._id), +b.holdExpiresAt), delayMs: Math.max(0, +b.holdExpiresAt - Date.now()) });
}
/** Status transition that releases the seat exactly once (only the caller whose update matched releases). */
export async function releaseTo(bookingId: any, from: string[], to: string, filter: any = {}) {
  const b = await bookingRepository.findOneAndUpdate({ _id: bookingId, status: { $in: from }, ...filter }, { $set: { status: to, cancelledAt: new Date() }, $unset: { holdExpiresAt: 1 } }, { new: true });
  if (b) await releaseSeat(b.eventId, b.gender as any);
  return b;
}

export async function createBooking(userId: string, eventId: string) {
  const user = await userRepository.findById(userId).select('profileCompleted verification profile.gender');
  if (!user?.profileCompleted || !user.profile?.gender) throw new AppError(403, 'PROFILE_INCOMPLETE');
  if (user.verification?.status !== 'approved') throw new AppError(403, 'VERIFICATION_REQUIRED', 'Selfie verification must be approved before booking');
  const ev = await eventRepository.findOne({ _id: eventId, status: { $ne: 'draft' } });
  if (!ev) throw new AppError(404, 'NOT_FOUND');
  const g = user.profile.gender as 'male' | 'female';
  const active = ['pending', 'confirmed', 'refund_requested', 'refunded', 'cancelled_by_admin'];
  const existing = await bookingRepository.findOne({ eventId, userId });
  if (existing && active.includes(existing.status)) return { booking: existing, event: ev, created: false };
  if (!(await reserveSeat(eventId, g))) {
    const bookable = ev.status === 'published' && ev.startsAt > new Date();
    throw bookable ? new AppError(409, 'EVENT_FULL', 'No seats left') : new AppError(409, 'EVENT_NOT_BOOKABLE');
  }
  const paid = ev.priceInPaise > 0; const now = new Date();
  const fields: any = paid
    ? { gender: g, status: 'pending', amountInPaise: ev.priceInPaise, holdExpiresAt: new Date(+now + env.BOOKING_HOLD_MIN * MIN) }
    : { gender: g, status: 'confirmed', amountInPaise: 0, confirmedAt: now };
  let b: any;
  try { b = await bookingRepository.create({ eventId, userId, ...fields }); }
  catch (e: any) {
    if (e?.code !== 11000) { await releaseSeat(eventId, g); throw e; }
    // Rebooking after expiry/cancel reuses the row (unique {eventId,userId}); concurrent duplicates roll back their $inc.
    const unset: any = { paymentId: 1, playOrderId: 1, refund: 1, cancelledAt: 1 }; if (!paid) unset.holdExpiresAt = 1;
    b = await bookingRepository.findOneAndUpdate({ eventId, userId, status: { $in: ['expired', 'cancelled'] } }, { $set: { ...fields, refundEligible: false }, $unset: unset }, { new: true });
    if (!b) { await releaseSeat(eventId, g); return { booking: await bookingRepository.findOne({ eventId, userId }), event: ev, created: false }; }
  }
  if (paid) await scheduleExpire(b); else await onConfirmed(b, ev);
  return { booking: b, event: ev, created: true };
}

export async function expireBooking(bookingId: string) {
  const b = await bookingRepository.findById(bookingId);
  if (!b || b.status !== 'pending' || !b.holdExpiresAt) return;
  if (+b.holdExpiresAt > Date.now()) return scheduleExpire(b); // hold was extended
  await releaseTo(bookingId, ['pending'], 'expired', { holdExpiresAt: { $lte: new Date() } });
}

export async function onConfirmed(b: any, ev: any) {
  const uid = String(b.userId); const eid = String(ev._id);
  await notify({ userId: uid, type: 'booking_confirmed', title: 'Booking confirmed', body: `You're in for ${ev.title}`, data: { bookingId: String(b._id), eventId: eid },
    dedupeKey: jobId('booking_confirmed', String(b._id), +(b.confirmedAt ?? 0)) });
  const q = getQueue();
  for (const [tag, before] of [['24h', 24 * 60 * MIN], ['10m', 10 * MIN]] as const) {
    const at = +ev.startsAt - before;
    if (at > Date.now()) await q.add('notify.reminder', { eventId: eid, userId: uid, tag }, { jobId: jobId('remind', eid, uid, tag), delayMs: at - Date.now() });
  }
  if (b.amountInPaise > 0) {
    const end = eventEnd(ev);
    await q.add('event.finalize', { eventId: eid }, { jobId: jobId('finalize', eid, +end), delayMs: Math.max(0, +end - Date.now()) });
  }
}

export async function sendReminder(d: { eventId: string; userId: string; tag: string }) {
  const [b, ev] = await Promise.all([bookingRepository.findOne({ eventId: d.eventId, userId: d.userId, status: 'confirmed' }), eventRepository.findById(d.eventId)]);
  if (!b || !ev || !['published', 'live'].includes(ev.status)) return;
  await notify({ userId: d.userId, type: 'event_reminder', title: d.tag === '24h' ? 'Tomorrow: ' + ev.title : ev.title + ' starts in 10 minutes',
    body: d.tag === '24h' ? 'Your speed-dating event is in 24 hours' : 'Join the waiting room now', data: { eventId: d.eventId }, dedupeKey: jobId('remind', d.eventId, d.userId, d.tag) });
}

// ---------- refunds ----------
export async function requestRefund(userId: string, bookingId: string, reason: string) {
  const b = await bookingRepository.findOne({ _id: bookingId, userId });
  if (!b) throw new AppError(404, 'BOOKING_NOT_FOUND');
  if (b.refund?.status) throw new AppError(409, b.refund.status === 'rejected' ? 'REFUND_REJECTED' : 'REFUND_ALREADY_REQUESTED');
  if (b.status !== 'confirmed' || !b.refundEligible || !(b.amountInPaise > 0)) throw new AppError(409, 'REFUND_NOT_ELIGIBLE');
  const u = await bookingRepository.findOneAndUpdate({ _id: bookingId, userId, status: 'confirmed', refundEligible: true, 'refund.status': { $exists: false } },
    { $set: { status: 'refund_requested', refund: { status: 'requested', reason, requestedAt: new Date() } } }, { new: true });
  if (!u) throw new AppError(409, 'REFUND_ALREADY_REQUESTED');
  await notify({ userId, type: 'refund_requested', title: 'Refund requested', body: 'We will review your refund shortly', data: { bookingId }, dedupeKey: jobId('refund_requested', bookingId) });
  if (env.AUTO_REFUND_NO_MATCH === 'true') {
    try { return await approveRefund(bookingId, null, true); } catch (err) { logger.warn({ err }, 'auto refund failed; left for admin'); }
  }
  return (await bookingRepository.findById(bookingId))!;
}

// ---------- app reads / cancel ----------
export async function cancelPendingBooking(userId: string, bookingId: string) {
  const b = await bookingRepository.findOne({ _id: bookingId, userId });
  if (!b) throw new AppError(404, 'BOOKING_NOT_FOUND');
  const x = await releaseTo(b._id, ['pending'], 'cancelled', { userId });
  if (!x) throw new AppError(409, 'BOOKING_NOT_CANCELLABLE', 'Only unpaid (pending) bookings can be cancelled');
  return x;
}

export async function myBookings(userId: string) {
  const [list, u] = await Promise.all([bookingRepository.find({ userId }).sort({ createdAt: -1 }).limit(200).populate('eventId'), userRepository.findById(userId).select('profile.gender')]);
  const g = u?.profile?.gender ?? null; const now = Date.now();
  const upcoming: any[] = []; const past: any[] = [];
  for (const b of list as any[]) {
    const ev = b.eventId; if (!ev) continue;
    const isUp = ['pending', 'confirmed'].includes(b.status) && ['published', 'live'].includes(ev.status) && +eventEnd(ev) > now;
    (isUp ? upcoming : past).push(bookingOut(b, ev, g));
  }
  upcoming.sort((a, b) => +new Date(a.event.startsAt) - +new Date(b.event.startsAt));
  return { upcoming, past };
}

export async function savedEvents(userId: string) {
  const [rx, u] = await Promise.all([reactionRepository.find({ userId, kind: 'save' }).sort({ createdAt: -1 }).limit(100), userRepository.findById(userId).select('profile.gender')]);
  const evs = await eventRepository.find({ _id: { $in: rx.map((x) => x.eventId) }, status: { $in: VISIBLE } });
  const byId = new Map(evs.map((e) => [String(e._id), e]));
  return { items: rx.map((x) => byId.get(String(x.eventId))).filter(Boolean).map((e) => appEvent(e, u?.profile?.gender)) };
}
export { bookingOut } from './booking.mapper';

/** Admin: one user's bookings, newest first (index userId+createdAt). Read-only. */
export async function adminUserBookings(userId: string, { status, page, limit }: { status?: string; page: number; limit: number }) {
  const filter: any = { userId }; if (status) filter.status = status;
  const [rows, total] = await Promise.all([
    bookingRepository.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('eventId', 'title startsAt endsAt city playProductId').lean(),
    bookingRepository.countDocuments(filter),
  ]);
  const items = rows.map((b: any) => ({ id: String(b._id), status: b.status, gender: b.gender, amountInPaise: b.amountInPaise, datesCompleted: b.datesCompleted ?? 0,
    attendedAt: b.attendedAt ?? null, confirmedAt: b.confirmedAt ?? null, createdAt: b.createdAt, refund: b.refund?.status ? b.refund : undefined,
    event: b.eventId?._id ? { id: String(b.eventId._id), title: b.eventId.title, startsAt: b.eventId.startsAt, endsAt: b.eventId.endsAt ?? null, city: b.eventId.city ?? null, playProductId: b.eventId.playProductId ?? null }
      : { id: String(b.eventId), title: null, startsAt: null, endsAt: null, city: null, playProductId: null } }));
  return { items, total, page, limit };
}

// ---------- live session (Sprint 3) ----------
/** The caller's confirmed booking for an event, or null. */
export async function findConfirmedBooking(eventId: string, userId: string) {
  const b = await bookingRepository.findOne({ eventId, userId, status: 'confirmed' }).select('_id gender attendedAt').lean();
  return b ? { id: String(b._id), gender: b.gender as 'male' | 'female', attendedAt: b.attendedAt ?? null } : null;
}
/** Sets attendedAt on the first join only (atomic, re-joins keep the original time). */
export async function markAttended(eventId: string, userId: string, at = new Date()) {
  await bookingRepository.updateOne({ eventId, userId, status: 'confirmed', attendedAt: { $exists: false } }, { $set: { attendedAt: at } });
}
/** +1 datesCompleted for each user (called once per completed date, guarded by the date's `counted` flag). */
export async function addDateCompleted(eventId: string, userIds: string[]) {
  await bookingRepository.updateMany({ eventId, userId: { $in: userIds }, status: { $in: ['confirmed', 'refund_requested'] } }, { $inc: { datesCompleted: 1 } });
}
export async function datesCompletedByUser(eventId: string) {
  const rows = await bookingRepository.find({ eventId, status: 'confirmed', attendedAt: { $exists: true } }).select('userId datesCompleted').lean();
  return new Map(rows.map((b) => [String(b.userId), b.datesCompleted ?? 0]));
}
