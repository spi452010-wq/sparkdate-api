import { asyncHandler } from '../../utils/errors';
import * as svc from './bookings.service';
import { bookingOut } from './booking.mapper';

export const create = asyncHandler(async (req, res) => {
  const { booking: b, event: ev, created } = await svc.createBooking(req.user.id, req.body.eventId);
  const play = b.status === 'pending' && ev.priceInPaise > 0
    ? { productId: ev.playProductId, obfuscatedAccountId: req.user.id } : undefined;
  res.status(created ? 201 : 200).json({ booking: bookingOut(b, ev, b.gender), ...(play ? { play } : {}) });
});
export const cancel = asyncHandler(async (req, res) => {
  res.json({ booking: bookingOut(await svc.cancelPendingBooking(req.user.id, String(req.params.id))) });
});
export const refundRequest = asyncHandler(async (req, res) => {
  res.json({ booking: bookingOut(await svc.requestRefund(req.user.id, String(req.params.id), req.body.reason)) });
});
export const myBookings = asyncHandler(async (req, res) => { res.json(await svc.myBookings(req.user.id)); });
export const savedEvents = asyncHandler(async (req, res) => { res.json(await svc.savedEvents(req.user.id)); });
