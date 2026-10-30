import { asyncHandler } from '../../utils/errors';
import * as svc from './refunds.service';
import { paymentOut, refundOut } from './refund.mapper';

export const listRefunds = asyncHandler(async (req, res) => {
  const r = await svc.listRefunds(req.query as any);
  res.json({ ...r, items: r.items.map(refundOut) });
});
export const approve = asyncHandler(async (req, res) => { res.json(refundOut(await svc.approveRefund(String(req.params.bookingId), req.user.id))); });
export const reject = asyncHandler(async (req, res) => {
  res.json(refundOut(await svc.rejectRefund(String(req.params.bookingId), req.user.id, req.body.reason)));
});
export const listPayments = asyncHandler(async (req, res) => {
  const r = await svc.listPayments(req.query as any);
  res.json({ ...r, items: r.items.map(paymentOut) });
});
export const cancelEvent = asyncHandler(async (req, res) => {
  const { event, summary } = await svc.cancelEvent(String(req.params.id), req.user.id);
  res.json({ id: String(event._id), status: event.status, summary });
});
export const linkPayment = asyncHandler(async (req, res) => { res.json(await svc.linkPayment(String(req.params.id), req.body.bookingId)); });
