import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { validate } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import { asyncHandler } from '../../utils/errors';
import { Booking } from '../events/booking.model';
import { Payment } from '../payments/payment.model';
import { User } from '../auth/user.model';
import { approveRefund, rejectRefund, cancelEvent } from '../bookings/booking.service';

const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');
const qParam = z.string().trim().min(1).max(80).optional();
const USER_MATCH_CAP = 200;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Search users by name/phone/email; returns capped id list (null = no q given).
async function userIdsFor(q?: string): Promise<Types.ObjectId[] | null> {
  if (!q) return null;
  const re = new RegExp(escapeRe(q), 'i');
  const users = await User.find({ $or: [{ 'profile.fullName': re }, { phone: re }, { email: re }] }).select('_id').limit(USER_MATCH_CAP).lean();
  return users.map((u) => u._id as Types.ObjectId);
}
const userOut = (u: any, id: any) => (u?._id ? { id: String(u._id), fullName: u.profile?.fullName ?? null, phone: u.phone ?? null } : { id: String(id), fullName: null, phone: null });
const paging = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) };
const refundOut = (b: any) => ({ bookingId: String(b._id), status: b.status, refund: b.refund, amountInPaise: b.amountInPaise, playOrderId: b.playOrderId,
  user: userOut(b.userId, b.userId),
  event: b.eventId?._id ? { id: String(b.eventId._id), title: b.eventId.title, startsAt: b.eventId.startsAt } : { id: String(b.eventId) } });

// Money operations are admin-only (hosts cannot refund or cancel paid events).
const r = Router();
r.use(requireAuth, requireRole('admin'));
r.get('/refunds', validate(z.object({ status: z.enum(['requested', 'processing', 'processed', 'rejected', 'failed']).optional(), q: qParam, ...paging }), 'query'),
  asyncHandler(async (req, res) => {
    const { status, page, limit } = req.query as any;
    const q: any = { 'refund.status': status ?? { $exists: true } };
    const ids = await userIdsFor((req.query as any).q); if (ids) q.userId = { $in: ids };
    const [items, total] = await Promise.all([
      Booking.find(q).sort({ 'refund.requestedAt': -1 }).skip((page - 1) * limit).limit(limit).populate('userId', 'profile.fullName phone').populate('eventId', 'title startsAt'),
      Booking.countDocuments(q)]);
    res.json({ items: items.map(refundOut), page, limit, total });
  }));
const bid = validate(z.object({ bookingId: objectId }), 'params');
r.post('/refunds/:bookingId/approve', bid, asyncHandler(async (req, res) => { res.json(refundOut(await approveRefund(req.params.bookingId, req.user.id))); }));
r.post('/refunds/:bookingId/reject', bid, validate(z.object({ reason: z.string().trim().min(3).max(300) }).strict()),
  asyncHandler(async (req, res) => { res.json(refundOut(await rejectRefund(req.params.bookingId, req.user.id, req.body.reason))); }));
r.get('/payments', validate(z.object({ userId: objectId.optional(), status: z.enum(['verified', 'refunded', 'refund_failed', 'voided']).optional(), eventId: objectId.optional(), q: qParam, ...paging }), 'query'),
  asyncHandler(async (req, res) => {
    const { userId, eventId, status, page, limit } = req.query as any;
    const q: any = {}; if (status) q.status = status;
    const ids = await userIdsFor((req.query as any).q);
    if (ids) q.userId = { $in: userId ? ids.filter((i) => String(i) === userId) : ids };
    else if (userId) q.userId = new Types.ObjectId(userId);
    if (eventId) q.bookingId = { $in: await Booking.find({ eventId }).distinct('_id') };
    const [items, total] = await Promise.all([
      Payment.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('-purchaseToken').populate('userId', 'profile.fullName phone').lean(),
      Payment.countDocuments(q)]);
    // purchaseToken is a bearer-like credential for the purchase: never sent to the panel.
    res.json({ items: items.map((p: any) => ({ id: String(p._id), userId: String(p.userId?._id ?? p.userId), user: userOut(p.userId, p.userId), bookingId: p.bookingId ? String(p.bookingId) : null, kind: p.kind, productId: p.productId,
      orderId: p.orderId, amountInPaise: p.amountInPaise, status: p.status, acknowledged: p.acknowledged, createdAt: p.createdAt, refundedAt: p.refundedAt })), page, limit, total });
  }));
r.post('/events/:id/cancel', validate(z.object({ id: objectId }), 'params'), asyncHandler(async (req, res) => {
  const { event, summary } = await cancelEvent(req.params.id, req.user.id);
  res.json({ id: String(event._id), status: event.status, summary });
}));
export default r;
