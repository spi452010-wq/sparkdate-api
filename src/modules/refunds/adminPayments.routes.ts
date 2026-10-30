import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { validate } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import { asyncHandler } from '../../utils/errors';
import { Booking } from '../events/booking.model';
import { Payment } from '../payments/payment.model';
import { approveRefund, rejectRefund, cancelEvent } from '../bookings/booking.service';

const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');
const paging = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) };
const refundOut = (b: any) => ({ bookingId: String(b._id), status: b.status, refund: b.refund, amountInPaise: b.amountInPaise, playOrderId: b.playOrderId,
  user: b.userId?._id ? { id: String(b.userId._id), fullName: b.userId.profile?.fullName, phone: b.userId.phone } : { id: String(b.userId) },
  event: b.eventId?._id ? { id: String(b.eventId._id), title: b.eventId.title, startsAt: b.eventId.startsAt } : { id: String(b.eventId) } });

// Money operations are admin-only (hosts cannot refund or cancel paid events).
const r = Router();
r.use(requireAuth, requireRole('admin'));
r.get('/refunds', validate(z.object({ status: z.enum(['requested', 'processing', 'processed', 'rejected', 'failed']).optional(), ...paging }), 'query'),
  asyncHandler(async (req, res) => {
    const { status, page, limit } = req.query as any;
    const q = { 'refund.status': status ?? { $exists: true } };
    const [items, total] = await Promise.all([
      Booking.find(q).sort({ 'refund.requestedAt': -1 }).skip((page - 1) * limit).limit(limit).populate('userId', 'profile.fullName phone').populate('eventId', 'title startsAt'),
      Booking.countDocuments(q)]);
    res.json({ items: items.map(refundOut), page, limit, total });
  }));
const bid = validate(z.object({ bookingId: objectId }), 'params');
r.post('/refunds/:bookingId/approve', bid, asyncHandler(async (req, res) => { res.json(refundOut(await approveRefund(req.params.bookingId, req.user.id))); }));
r.post('/refunds/:bookingId/reject', bid, validate(z.object({ reason: z.string().trim().min(3).max(300) }).strict()),
  asyncHandler(async (req, res) => { res.json(refundOut(await rejectRefund(req.params.bookingId, req.user.id, req.body.reason))); }));
r.get('/payments', validate(z.object({ userId: objectId.optional(), status: z.enum(['verified', 'refunded', 'refund_failed', 'voided']).optional(), ...paging }), 'query'),
  asyncHandler(async (req, res) => {
    const { userId, status, page, limit } = req.query as any;
    const q: any = {}; if (userId) q.userId = userId; if (status) q.status = status;
    const [items, total] = await Promise.all([Payment.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), Payment.countDocuments(q)]);
    // purchaseToken is a bearer-like credential for the purchase: never sent to the panel.
    res.json({ items: items.map((p) => ({ id: String(p._id), userId: String(p.userId), bookingId: p.bookingId ? String(p.bookingId) : null, kind: p.kind, productId: p.productId,
      orderId: p.orderId, amountInPaise: p.amountInPaise, status: p.status, acknowledged: p.acknowledged, createdAt: p.createdAt, refundedAt: p.refundedAt })), page, limit, total });
  }));
r.post('/events/:id/cancel', validate(z.object({ id: objectId }), 'params'), asyncHandler(async (req, res) => {
  const { event, summary } = await cancelEvent(req.params.id, req.user.id);
  res.json({ id: String(event._id), status: event.status, summary });
}));
export default r;
