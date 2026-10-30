import { appEvent } from '../events/event.mapper';
// Response mapper (pure, no DB); shared by bookings, events and payments.
export const bookingOut = (b: any, ev?: any, g?: string | null) => ({
  id: String(b._id), eventId: String(b.eventId?._id ?? b.eventId), status: b.status, gender: b.gender, amountInPaise: b.amountInPaise,
  holdExpiresAt: b.status === 'pending' ? b.holdExpiresAt ?? null : null, confirmedAt: b.confirmedAt ?? null, refundEligible: !!b.refundEligible,
  refund: b.refund?.status ? { status: b.refund.status, reason: b.refund.reason, rejectReason: b.refund.rejectReason, requestedAt: b.refund.requestedAt } : null,
  createdAt: b.createdAt, ...(ev ? { event: appEvent(ev, g) } : {}),
});
