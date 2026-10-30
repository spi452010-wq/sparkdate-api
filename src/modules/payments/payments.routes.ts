import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { requireIdempotencyKey } from '../../middleware/idempotency';
import { asyncHandler, AppError } from '../../utils/errors';
import { User } from '../auth/user.model';
import { Payment } from './payment.model';
import { getPlayClient, mapPlayError } from './playClient';
import { finalizeTicket, verifyChatPass } from '../bookings/booking.service';
import { bookingOut } from '../bookings/bookings.routes';

export const payments = Router();
payments.use(requireAuth);
payments.post('/play/verify', requireIdempotencyKey, validate(z.object({
  bookingId: z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id').optional(),
  purchaseToken: z.string().min(10).max(4096), productId: z.string().regex(/^[a-z0-9_.]{1,100}$/), kind: z.enum(['ticket', 'chat_pass']),
}).strict().refine((b) => b.kind !== 'ticket' || !!b.bookingId, { path: ['bookingId'], message: 'bookingId required for tickets' })),
asyncHandler(async (req, res) => {
  const { bookingId, purchaseToken, productId, kind } = req.body; const uid = req.user.id;
  const prev = await Payment.findOne({ purchaseToken }).select('userId bookingId kind');
  if (prev && (String(prev.userId) !== uid || prev.kind !== kind || (kind === 'ticket' && String(prev.bookingId) !== bookingId)))
    throw new AppError(409, 'PURCHASE_ALREADY_USED');
  if (kind === 'chat_pass') {
    const r = await verifyChatPass(uid, productId, purchaseToken);
    return res.status(r.status === 'pending' ? 202 : 200).json(r);
  }
  const p = await getPlayClient().getProduct(productId, purchaseToken).catch((e) => { throw mapPlayError(e); });
  const r = await finalizeTicket(uid, bookingId, productId, purchaseToken, p);
  res.status(r.status === 'pending' ? 202 : 200).json({ status: r.status, booking: bookingOut(r.booking) });
}));

export const subscriptions = Router();
subscriptions.use(requireAuth);
subscriptions.get('/me', asyncHandler(async (req, res) => {
  const u = await User.findById(req.user.id).select('chatPassUntil chatPass');
  const until = u?.chatPassUntil ?? null;
  res.json({ chatPass: { active: !!until && +until > Date.now(), expiresAt: until, productId: u?.chatPass?.productId ?? null,
    autoRenewing: !!u?.chatPass?.autoRenewing, state: u?.chatPass?.state ?? null } });
}));
