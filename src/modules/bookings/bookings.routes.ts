import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { requireIdempotencyKey } from '../../middleware/idempotency';
import { asyncHandler, AppError } from '../../utils/errors';
import { Booking } from '../events/booking.model';
import { Event } from '../events/event.model';
import { EventReaction } from '../events/reaction.model';
import { User } from '../auth/user.model';
import { Notification } from '../notifications/notification.model';
import { createBooking, releaseTo, requestRefund, eventEnd } from './booking.service';
import { appEvent, VISIBLE } from '../events/events.routes';

export const bookingOut = (b: any, ev?: any, g?: string | null) => ({
  id: String(b._id), eventId: String(b.eventId?._id ?? b.eventId), status: b.status, gender: b.gender, amountInPaise: b.amountInPaise,
  holdExpiresAt: b.status === 'pending' ? b.holdExpiresAt ?? null : null, confirmedAt: b.confirmedAt ?? null, refundEligible: !!b.refundEligible,
  refund: b.refund?.status ? { status: b.refund.status, reason: b.refund.reason, rejectReason: b.refund.rejectReason, requestedAt: b.refund.requestedAt } : null,
  createdAt: b.createdAt, ...(ev ? { event: appEvent(ev, g) } : {}),
});
const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');
const idParam = validate(z.object({ id: objectId }), 'params');

/** /api/v1/bookings */
export const bookings = Router();
bookings.use(requireAuth);
bookings.post('/', requireIdempotencyKey, validate(z.object({ eventId: objectId }).strict()), asyncHandler(async (req, res) => {
  const { booking: b, event: ev, created } = await createBooking(req.user.id, req.body.eventId);
  const play = b.status === 'pending' && ev.priceInPaise > 0
    ? { productId: ev.playProductId, obfuscatedAccountId: req.user.id, obfuscatedProfileId: String(b._id) } : undefined;
  res.status(created ? 201 : 200).json({ booking: bookingOut(b, ev, b.gender), ...(play ? { play } : {}) });
}));
bookings.delete('/:id', idParam, asyncHandler(async (req, res) => {
  const b = await Booking.findOne({ _id: req.params.id, userId: req.user.id });
  if (!b) throw new AppError(404, 'BOOKING_NOT_FOUND');
  const x = await releaseTo(b._id, ['pending'], 'cancelled', { userId: req.user.id });
  if (!x) throw new AppError(409, 'BOOKING_NOT_CANCELLABLE', 'Only unpaid (pending) bookings can be cancelled');
  res.json({ booking: bookingOut(x) });
}));
bookings.post('/:id/refund-request', idParam, requireIdempotencyKey, validate(z.object({ reason: z.string().trim().min(3).max(500) }).strict()),
  asyncHandler(async (req, res) => { res.json({ booking: bookingOut(await requestRefund(req.user.id, req.params.id, req.body.reason)) }); }));

/** /api/v1/me */
export const me = Router();
me.use(requireAuth);
me.get('/bookings', asyncHandler(async (req, res) => {
  const [list, u] = await Promise.all([Booking.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(200).populate('eventId'), User.findById(req.user.id).select('profile.gender')]);
  const g = u?.profile?.gender ?? null; const now = Date.now();
  const upcoming: any[] = []; const past: any[] = [];
  for (const b of list as any[]) {
    const ev = b.eventId; if (!ev) continue;
    const isUp = ['pending', 'confirmed'].includes(b.status) && ['published', 'live'].includes(ev.status) && +eventEnd(ev) > now;
    (isUp ? upcoming : past).push(bookingOut(b, ev, g));
  }
  upcoming.sort((a, b) => +new Date(a.event.startsAt) - +new Date(b.event.startsAt));
  res.json({ upcoming, past });
}));
me.get('/events/saved', asyncHandler(async (req, res) => {
  const [rx, u] = await Promise.all([EventReaction.find({ userId: req.user.id, kind: 'save' }).sort({ createdAt: -1 }).limit(100), User.findById(req.user.id).select('profile.gender')]);
  const evs = await Event.find({ _id: { $in: rx.map((x) => x.eventId) }, status: { $in: VISIBLE } });
  const byId = new Map(evs.map((e) => [String(e._id), e]));
  res.json({ items: rx.map((x) => byId.get(String(x.eventId))).filter(Boolean).map((e) => appEvent(e, u?.profile?.gender)) });
}));

/** /api/v1/notifications (in-app list) */
export const notifications = Router();
notifications.use(requireAuth);
notifications.get('/', validate(z.object({ before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }), 'query'),
  asyncHandler(async (req, res) => {
    const { before, limit } = req.query as any;
    const items = await Notification.find({ userId: req.user.id, ...(before ? { createdAt: { $lt: before } } : {}) }).sort({ createdAt: -1 }).limit(limit);
    res.json({ items: items.map((n) => ({ id: String(n._id), type: n.type, title: n.title, body: n.body, data: n.data, read: !!n.readAt, createdAt: n.createdAt })) });
  }));
notifications.post('/read', validate(z.object({ ids: z.array(objectId).max(100).optional() }).strict()), asyncHandler(async (req, res) => {
  const f: any = { userId: req.user.id, readAt: { $exists: false } }; if (req.body.ids) f._id = { $in: req.body.ids };
  const r = await Notification.updateMany(f, { readAt: new Date() });
  res.json({ updated: r.modifiedCount });
}));
