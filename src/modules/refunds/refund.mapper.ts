const ACK_WINDOW_MS = 3 * 86400_000; // Play auto-refunds unacknowledged purchases 3 days after purchase
const ackDeadlineIso = (p: any) => { const t = p.purchaseTime ?? p.createdAt; return t ? new Date(+new Date(t) + ACK_WINDOW_MS).toISOString() : null; };
// Pure response shapers for the admin money panel (no DB).
export const userOut = (u: any, id: any) => (u?._id ? { id: String(u._id), fullName: u.profile?.fullName ?? null, phone: u.phone ?? null } : { id: String(id), fullName: null, phone: null });
export const refundOut = (b: any) => ({ bookingId: String(b._id), status: b.status, refund: b.refund, amountInPaise: b.amountInPaise, playOrderId: b.playOrderId,
  user: userOut(b.userId, b.userId),
  event: b.eventId?._id ? { id: String(b.eventId._id), title: b.eventId.title, startsAt: b.eventId.startsAt } : { id: String(b.eventId) } });
// purchaseToken is a bearer-like credential for the purchase: never sent to the panel.
export const paymentOut = (p: any) => ({ id: String(p._id), userId: String(p.userId?._id ?? p.userId), user: userOut(p.userId, p.userId), bookingId: p.bookingId ? String(p.bookingId) : null, kind: p.kind, productId: p.productId,
  orderId: p.orderId, amountInPaise: p.amountInPaise, status: p.status, acknowledged: p.acknowledged, createdAt: p.createdAt, refundedAt: p.refundedAt, flaggedAt: p.flaggedAt,
  ackDeadline: p.status === 'unlinked' ? ackDeadlineIso(p) : undefined });
