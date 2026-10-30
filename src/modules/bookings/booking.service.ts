import { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { getQueue, jobId } from '../../jobs/queue';
import { Booking } from '../events/booking.model';
import { Event, reserveSeat, releaseSeat } from '../events/event.model';
import { User } from '../auth/user.model';
import { Payment } from '../payments/payment.model';
import { getPlayClient, mapPlayError, ProductPurchase, SubscriptionPurchase } from '../payments/playClient';
import { notify } from '../notifications/notify';

const MIN = 60_000;
const ACK_LIMIT_MS = 3 * 86400_000; // Google auto-refunds unacknowledged purchases after 3 days
export const eventEnd = (e: any) => new Date(e.endsAt ? +e.endsAt : +e.startsAt + 2 * 3600_000);
const isId = (s: unknown): s is string => typeof s === 'string' && Types.ObjectId.isValid(s) && String(new Types.ObjectId(s)) === s;

// ---------- seat hold / release ----------
/** Expire job id includes the hold time, so an extended hold simply gets a new job; stale jobs are no-ops. */
export async function scheduleExpire(b: any) {
  if (!b.holdExpiresAt) return;
  await getQueue().add('booking.expire', { bookingId: String(b._id) }, { jobId: jobId('expire', String(b._id), +b.holdExpiresAt), delayMs: Math.max(0, +b.holdExpiresAt - Date.now()) });
}
/** Status transition that releases the seat exactly once (only the caller whose update matched releases). */
export async function releaseTo(bookingId: any, from: string[], to: string, filter: any = {}) {
  const b = await Booking.findOneAndUpdate({ _id: bookingId, status: { $in: from }, ...filter }, { $set: { status: to, cancelledAt: new Date() }, $unset: { holdExpiresAt: 1 } }, { new: true });
  if (b) await releaseSeat(b.eventId, b.gender as any);
  return b;
}

export async function createBooking(userId: string, eventId: string) {
  const user = await User.findById(userId).select('profileCompleted verification profile.gender');
  if (!user?.profileCompleted || !user.profile?.gender) throw new AppError(403, 'PROFILE_INCOMPLETE');
  if (user.verification?.status !== 'approved') throw new AppError(403, 'VERIFICATION_REQUIRED', 'Selfie verification must be approved before booking');
  const ev = await Event.findOne({ _id: eventId, status: { $ne: 'draft' } });
  if (!ev) throw new AppError(404, 'NOT_FOUND');
  const g = user.profile.gender as 'male' | 'female';
  const active = ['pending', 'confirmed', 'refund_requested', 'refunded', 'cancelled_by_admin'];
  const existing = await Booking.findOne({ eventId, userId });
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
  try { b = await Booking.create({ eventId, userId, ...fields }); }
  catch (e: any) {
    if (e?.code !== 11000) { await releaseSeat(eventId, g); throw e; }
    // Rebooking after expiry/cancel reuses the row (unique {eventId,userId}); concurrent duplicates roll back their $inc.
    const unset: any = { paymentId: 1, playOrderId: 1, refund: 1, cancelledAt: 1 }; if (!paid) unset.holdExpiresAt = 1;
    b = await Booking.findOneAndUpdate({ eventId, userId, status: { $in: ['expired', 'cancelled'] } }, { $set: { ...fields, refundEligible: false }, $unset: unset }, { new: true });
    if (!b) { await releaseSeat(eventId, g); return { booking: await Booking.findOne({ eventId, userId }), event: ev, created: false }; }
  }
  if (paid) await scheduleExpire(b); else await onConfirmed(b, ev);
  return { booking: b, event: ev, created: true };
}

export async function expireBooking(bookingId: string) {
  const b = await Booking.findById(bookingId);
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
  const [b, ev] = await Promise.all([Booking.findOne({ eventId: d.eventId, userId: d.userId, status: 'confirmed' }), Event.findById(d.eventId)]);
  if (!b || !ev || !['published', 'live'].includes(ev.status)) return;
  await notify({ userId: d.userId, type: 'event_reminder', title: d.tag === '24h' ? 'Tomorrow: ' + ev.title : ev.title + ' starts in 10 minutes',
    body: d.tag === '24h' ? 'Your speed-dating event is in 24 hours' : 'Join the waiting room now', data: { eventId: d.eventId }, dedupeKey: jobId('remind', d.eventId, d.userId, d.tag) });
}

// ---------- Play: tickets ----------
async function ackProduct(pay: any) {
  try { await getPlayClient().acknowledgeProduct(pay.productId, pay.purchaseToken); await Payment.updateOne({ _id: pay._id }, { acknowledged: true }); }
  catch (err) { logger.warn({ err, paymentId: String(pay._id) }, 'acknowledge failed; retry job will handle it'); }
}
export async function retryAck(paymentId: string) {
  const pay = await Payment.findById(paymentId);
  if (!pay || pay.acknowledged || pay.status !== 'verified') return;
  if (pay.purchaseTime && Date.now() - +pay.purchaseTime > ACK_LIMIT_MS) { logger.error({ paymentId }, 'acknowledge window passed'); return; }
  const play = getPlayClient();
  if (pay.kind === 'ticket') await play.acknowledgeProduct(pay.productId, pay.purchaseToken); else await play.acknowledgeSubscription(pay.productId, pay.purchaseToken);
  await Payment.updateOne({ _id: pay._id }, { acknowledged: true }); // a throw above makes BullMQ retry with backoff
}

/** Refund a payment through Play; on failure mark refund_failed and schedule a retry. */
export async function refundPayment(pay: any): Promise<boolean> {
  if (pay.status === 'refunded') return true;
  try {
    if (!pay.orderId) throw new AppError(409, 'ORDER_ID_MISSING');
    await getPlayClient().refundOrder(pay.orderId);
    await Payment.updateOne({ _id: pay._id }, { status: 'refunded', refundedAt: new Date() });
    return true;
  } catch (err) {
    logger.error({ err, paymentId: String(pay._id) }, 'refund failed');
    await Payment.updateOne({ _id: pay._id }, { status: 'refund_failed' });
    await getQueue().add('refund.retry', { paymentId: String(pay._id) }, { jobId: jobId('refund', String(pay._id)), delayMs: 5 * MIN });
    return false;
  }
}
export async function retryRefund(paymentId: string) {
  const pay = await Payment.findById(paymentId);
  if (!pay || pay.status !== 'refund_failed' || !pay.orderId) return;
  await getPlayClient().refundOrder(pay.orderId);
  await Payment.updateOne({ _id: pay._id }, { status: 'refunded', refundedAt: new Date() });
  await Booking.updateOne({ paymentId: pay._id, 'refund.status': 'failed', status: 'cancelled_by_admin' }, { $set: { 'refund.status': 'processed' } });
}

export type TicketResult = { status: 'confirmed' | 'pending'; booking: any };
/** Applies a Play product purchase to a booking (used by /payments/play/verify and RTDN). Implements section 4 ordering. */
export async function finalizeTicket(userId: string, bookingId: string, productId: string, token: string, p: ProductPurchase): Promise<TicketResult> {
  const b = await Booking.findOne({ _id: bookingId, userId });
  if (!b) throw new AppError(404, 'BOOKING_NOT_FOUND');
  const ev = await Event.findById(b.eventId);
  if (!ev?.playProductId || ev.playProductId !== productId || (p.productId && p.productId !== productId)) throw new AppError(400, 'PRODUCT_MISMATCH');
  if (p.obfuscatedExternalAccountId !== userId || p.obfuscatedExternalProfileId !== bookingId) throw new AppError(400, 'PURCHASE_INVALID', 'Purchase does not belong to this booking');
  if (p.purchaseState === 2) { // pending (e.g. UPI): keep the seat a bit longer and wait for RTDN
    const until = new Date(Date.now() + env.PENDING_PURCHASE_HOLD_MIN * MIN);
    const ext = await Booking.findOneAndUpdate({ _id: bookingId, status: 'pending', holdExpiresAt: { $lt: until } }, { $set: { holdExpiresAt: until } }, { new: true });
    if (ext) await scheduleExpire(ext);
    return { status: 'pending', booking: ext ?? b };
  }
  if (p.purchaseState !== 0) throw new AppError(400, 'PURCHASE_INVALID', 'Purchase is not completed');
  let pay: any;
  try {
    pay = await Payment.create({ userId, bookingId, kind: 'ticket', productId, purchaseToken: token, orderId: p.orderId, amountInPaise: b.amountInPaise || ev.priceInPaise,
      purchaseTime: p.purchaseTimeMillis ? new Date(Number(p.purchaseTimeMillis)) : new Date(), acknowledged: p.acknowledgementState === 1 });
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
    const prev = await Payment.findOne({ purchaseToken: token });
    if (prev && String(prev.userId) === userId && String(prev.bookingId) === bookingId)
      return { status: 'confirmed', booking: await Booking.findById(bookingId) }; // retry of an already-applied purchase
    throw new AppError(409, 'PURCHASE_ALREADY_USED');
  }
  if (!pay.acknowledged) await getQueue().add('payment.ack', { paymentId: String(pay._id) }, { jobId: jobId('ack', String(pay._id)), delayMs: 10 * MIN });
  const set = { status: 'confirmed', paymentId: pay._id, playOrderId: p.orderId, confirmedAt: new Date() };
  let conf = await Booking.findOneAndUpdate({ _id: bookingId, status: 'pending' }, { $set: set, $unset: { holdExpiresAt: 1 } }, { new: true });
  if (!conf) {
    const cur = await Booking.findById(bookingId);
    if (cur && ['expired', 'cancelled'].includes(cur.status) && (await reserveSeat(cur.eventId, cur.gender as any))) {
      conf = await Booking.findOneAndUpdate({ _id: bookingId, status: { $in: ['expired', 'cancelled'] } }, { $set: set, $unset: { cancelledAt: 1 } }, { new: true });
      if (!conf) await releaseSeat(cur.eventId, cur.gender as any);
    }
    if (!conf) {
      const refunded = await refundPayment(pay);
      throw new AppError(409, 'EVENT_FULL_REFUNDED', refunded ? 'Seat no longer available; payment refunded' : 'Seat no longer available; refund is being processed');
    }
  }
  if (!pay.acknowledged) await ackProduct(pay);
  await onConfirmed(conf, ev);
  return { status: 'confirmed', booking: conf };
}

// ---------- Play: chat pass ----------
const ACTIVE_SUB = ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'];
export async function applySubscription(userId: string, token: string, sub: SubscriptionPurchase) {
  const li = sub.lineItems?.[0];
  const revoked = sub.subscriptionState === 'SUBSCRIPTION_STATE_REVOKED' || sub.subscriptionState === 'SUBSCRIPTION_STATE_ON_HOLD';
  const until = revoked || !li?.expiryTime ? new Date() : new Date(li.expiryTime);
  await User.updateOne({ _id: userId }, { $set: { chatPassUntil: until, chatPass: { productId: li?.productId, purchaseToken: token, state: sub.subscriptionState, autoRenewing: !!li?.autoRenewingPlan?.autoRenewEnabled, updatedAt: new Date() } } });
  if (until > new Date()) {
    const at = +until - 3 * 86400_000;
    if (at > Date.now()) await getQueue().add('notify.chatPassExpiring', { userId, until: +until }, { jobId: jobId('passexp', userId, +until), delayMs: at - Date.now() });
  }
  return until;
}
export async function verifyChatPass(userId: string, productId: string, token: string) {
  if (productId !== env.CHAT_PASS_PRODUCT_ID) throw new AppError(400, 'PRODUCT_MISMATCH');
  const sub = await getPlayClient().getSubscription(token).catch((e) => { throw mapPlayError(e); });
  if (!sub.lineItems?.some((l) => l.productId === productId)) throw new AppError(400, 'PRODUCT_MISMATCH');
  if (sub.externalAccountIdentifiers?.obfuscatedExternalAccountId !== userId) throw new AppError(400, 'PURCHASE_INVALID', 'Purchase does not belong to this user');
  if (sub.subscriptionState === 'SUBSCRIPTION_STATE_PENDING') return { status: 'pending' as const };
  if (!ACTIVE_SUB.includes(sub.subscriptionState)) throw new AppError(400, 'PURCHASE_INVALID', 'Subscription is not active');
  let pay: any;
  try { pay = await Payment.create({ userId, kind: 'chat_pass', productId, purchaseToken: token, orderId: sub.latestOrderId, purchaseTime: sub.startTime ? new Date(sub.startTime) : new Date(), acknowledged: sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' }); }
  catch (e: any) {
    if (e?.code !== 11000) throw e;
    pay = await Payment.findOne({ purchaseToken: token });
    if (!pay || String(pay.userId) !== userId || pay.kind !== 'chat_pass') throw new AppError(409, 'PURCHASE_ALREADY_USED');
  }
  const until = await applySubscription(userId, token, sub);
  if (!pay.acknowledged) {
    await getQueue().add('payment.ack', { paymentId: String(pay._id) }, { jobId: jobId('ack', String(pay._id)), delayMs: 10 * MIN });
    try { await getPlayClient().acknowledgeSubscription(productId, token); await Payment.updateOne({ _id: pay._id }, { acknowledged: true }); }
    catch (err) { logger.warn({ err }, 'subscription acknowledge failed; retry job will handle it'); }
  }
  return { status: 'confirmed' as const, chatPassUntil: until };
}
export async function passExpiring(d: { userId: string; until: number }) {
  const u = await User.findById(d.userId).select('chatPassUntil chatPass');
  if (!u?.chatPassUntil || +u.chatPassUntil !== d.until || u.chatPass?.autoRenewing) return;
  await notify({ userId: d.userId, type: 'chat_pass_expiring', title: 'Chat Pass expires in 3 days', body: 'Renew to keep chatting with your matches', dedupeKey: jobId('passexp', d.userId, d.until) });
}

// ---------- RTDN ----------
export async function onSubscriptionRtdn(token: string) {
  const sub = await getPlayClient().getSubscription(token); // never trust the notification body, re-read from Google
  let pay = await Payment.findOne({ purchaseToken: token });
  let userId = pay ? String(pay.userId) : sub.externalAccountIdentifiers?.obfuscatedExternalAccountId;
  if (!isId(userId) || !(await User.exists({ _id: userId }))) { logger.warn('RTDN subscription for unknown user'); return 'ignored'; }
  const productId = sub.lineItems?.[0]?.productId;
  if (productId !== env.CHAT_PASS_PRODUCT_ID) return 'ignored';
  if (!pay) {
    try { pay = await Payment.create({ userId, kind: 'chat_pass', productId, purchaseToken: token, orderId: sub.latestOrderId, purchaseTime: new Date() }); }
    catch (e: any) { if (e?.code !== 11000) throw e; pay = await Payment.findOne({ purchaseToken: token }); }
  } else if (sub.latestOrderId && sub.latestOrderId !== pay.orderId) await Payment.updateOne({ _id: pay._id }, { orderId: sub.latestOrderId });
  await applySubscription(userId!, token, sub);
  if (pay && !pay.acknowledged && sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING' && ACTIVE_SUB.includes(sub.subscriptionState))
    await getQueue().add('payment.ack', { paymentId: String(pay._id) }, { jobId: jobId('ack', String(pay._id)) });
  return 'processed';
}
export async function onOneTimeRtdn(n: { notificationType: number; purchaseToken: string; sku: string }) {
  if (n.notificationType !== 1) return 'ignored'; // 2 = pending purchase cancelled: the hold just expires
  const p = await getPlayClient().getProduct(n.sku, n.purchaseToken);
  if (p.purchaseState !== 0) return 'ignored';
  const userId = p.obfuscatedExternalAccountId; const bookingId = p.obfuscatedExternalProfileId;
  if (!isId(userId) || !isId(bookingId)) return 'ignored';
  if (await Payment.exists({ purchaseToken: n.purchaseToken })) return 'ignored';
  try { await finalizeTicket(userId, bookingId, n.sku, n.purchaseToken, p); }
  catch (e) { if (e instanceof AppError && e.status < 500) { logger.warn({ code: e.code }, 'RTDN purchase not applied'); return 'ignored'; } throw e; }
  return 'processed';
}
export async function onVoided(token: string) {
  const pay = await Payment.findOneAndUpdate({ purchaseToken: token, status: { $ne: 'voided' } }, { status: 'voided', voidedAt: new Date() }, { new: true });
  if (!pay) return 'ignored';
  if (pay.kind === 'chat_pass') {
    await User.updateOne({ _id: pay.userId, 'chatPass.purchaseToken': token }, { $set: { chatPassUntil: new Date(), 'chatPass.state': 'VOIDED' } });
  } else if (pay.bookingId) {
    const b = await Booking.findById(pay.bookingId); const ev = b && (await Event.findById(b.eventId));
    if (b && ev && ev.startsAt > new Date()) await releaseTo(b._id, ['pending', 'confirmed', 'refund_requested'], 'cancelled', { paymentId: pay._id });
    else if (b) await Booking.updateOne({ _id: b._id, paymentId: pay._id, status: { $in: ['confirmed', 'refund_requested'] } }, { status: 'refunded' });
  }
  return 'processed';
}
export async function syncVoided() {
  const list = await getPlayClient().listVoided(Date.now() - 3 * 86400_000);
  for (const v of list) await onVoided(v.purchaseToken);
}

// ---------- refunds ----------
export async function requestRefund(userId: string, bookingId: string, reason: string) {
  const b = await Booking.findOne({ _id: bookingId, userId });
  if (!b) throw new AppError(404, 'BOOKING_NOT_FOUND');
  if (b.refund?.status) throw new AppError(409, b.refund.status === 'rejected' ? 'REFUND_REJECTED' : 'REFUND_ALREADY_REQUESTED');
  if (b.status !== 'confirmed' || !b.refundEligible || !(b.amountInPaise > 0)) throw new AppError(409, 'REFUND_NOT_ELIGIBLE');
  const u = await Booking.findOneAndUpdate({ _id: bookingId, userId, status: 'confirmed', refundEligible: true, 'refund.status': { $exists: false } },
    { $set: { status: 'refund_requested', refund: { status: 'requested', reason, requestedAt: new Date() } } }, { new: true });
  if (!u) throw new AppError(409, 'REFUND_ALREADY_REQUESTED');
  await notify({ userId, type: 'refund_requested', title: 'Refund requested', body: 'We will review your refund shortly', data: { bookingId }, dedupeKey: jobId('refund_requested', bookingId) });
  if (env.AUTO_REFUND_NO_MATCH === 'true') {
    try { return await approveRefund(bookingId, null, true); } catch (err) { logger.warn({ err }, 'auto refund failed; left for admin'); }
  }
  return (await Booking.findById(bookingId))!;
}
export async function approveRefund(bookingId: string, adminId: string | null, auto = false) {
  const b = await Booking.findOneAndUpdate({ _id: bookingId, status: 'refund_requested', 'refund.status': { $in: ['requested', 'failed'] } },
    { $set: { 'refund.status': 'processing', 'refund.decidedBy': adminId ?? undefined, 'refund.decidedAt': new Date(), 'refund.auto': auto } }, { new: true });
  if (!b) throw new AppError(409, 'REFUND_NOT_PENDING');
  const pay = await Payment.findById(b.paymentId);
  try {
    if (!pay?.orderId) throw new AppError(409, 'PAYMENT_NOT_FOUND');
    if (pay.status !== 'refunded') await getPlayClient().refundOrder(pay.orderId);
  } catch (e) {
    await Booking.updateOne({ _id: b._id, 'refund.status': 'processing' }, { $set: { 'refund.status': 'failed' } });
    throw mapPlayError(e);
  }
  await Payment.updateOne({ _id: pay._id }, { status: 'refunded', refundedAt: new Date() });
  const done = await Booking.findOneAndUpdate({ _id: b._id }, { $set: { status: 'refunded', 'refund.status': 'processed', 'refund.playOrderId': pay.orderId } }, { new: true });
  await notify({ userId: String(b.userId), type: 'refund_processed', title: 'Refund processed', body: 'Your ticket amount is on its way back via Google Play', data: { bookingId }, dedupeKey: jobId('refund_processed', bookingId) });
  return done!;
}
export async function rejectRefund(bookingId: string, adminId: string, reason: string) {
  const b = await Booking.findOneAndUpdate({ _id: bookingId, status: 'refund_requested', 'refund.status': { $in: ['requested', 'failed'] } },
    { $set: { status: 'confirmed', 'refund.status': 'rejected', 'refund.rejectReason': reason, 'refund.decidedBy': adminId, 'refund.decidedAt': new Date() } }, { new: true });
  if (!b) throw new AppError(409, 'REFUND_NOT_PENDING');
  await notify({ userId: String(b.userId), type: 'refund_rejected', title: 'Refund request declined', body: reason, data: { bookingId }, dedupeKey: jobId('refund_rejected', bookingId) });
  return b;
}

/** event.finalize job: computes refundEligible at event end. attendedAt is set by the live-session module. */
export async function finalizeEvent(eventId: string) {
  const ev = await Event.findById(eventId);
  if (!ev || ev.status === 'cancelled') return;
  const end = eventEnd(ev);
  if (Date.now() < +end) { await getQueue().add('event.finalize', { eventId }, { jobId: jobId('finalize', eventId, +end), delayMs: +end - Date.now() }); return; }
  const filter = { eventId: ev._id, status: 'confirmed', amountInPaise: { $gt: 0 }, paymentId: { $exists: true }, datesCompleted: 0, attendedAt: { $exists: true }, refundEligible: false };
  const ids = (await Booking.find(filter).select('_id userId')).map((b) => b);
  await Booking.updateMany(filter, { $set: { refundEligible: true } });
  if (env.AUTO_REFUND_NO_MATCH === 'true')
    for (const b of ids) await requestRefund(String(b.userId), String(b._id), 'no_match').catch((err) => logger.warn({ err }, 'auto refund request failed'));
}

/** Admin cancel: pending holds released, free bookings cancelled, paid bookings refunded. Re-runnable. */
export async function cancelEvent(eventId: string, adminId: string) {
  const ev = await Event.findOneAndUpdate({ _id: eventId, status: { $in: ['draft', 'published', 'cancelled'] } }, { $set: { status: 'cancelled' } }, { new: true });
  if (!ev) { if (await Event.exists({ _id: eventId })) throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Live or ended events cannot be cancelled'); throw new AppError(404, 'NOT_FOUND'); }
  const sum = { cancelledPending: 0, cancelledFree: 0, refunded: 0, refundFailed: 0 };
  const list = await Booking.find({ eventId, status: { $in: ['pending', 'confirmed', 'refund_requested'] } });
  const msg = (b: any, body: string) => notify({ userId: String(b.userId), type: 'event_cancelled', title: `${ev.title} was cancelled`, body, data: { eventId, bookingId: String(b._id) }, dedupeKey: jobId('event_cancelled', String(b._id)) });
  for (const b of list) {
    if (b.status === 'pending') { if (await releaseTo(b._id, ['pending'], 'cancelled')) { sum.cancelledPending++; await msg(b, 'Your seat hold was released'); } continue; }
    const paid = b.amountInPaise > 0 && !!b.paymentId;
    const now = new Date();
    const x = await Booking.findOneAndUpdate({ _id: b._id, status: { $in: ['confirmed', 'refund_requested'] } },
      { $set: { status: 'cancelled_by_admin', cancelledAt: now, ...(paid ? { refund: { status: 'processing', reason: 'event_cancelled', requestedAt: now, decidedBy: adminId, decidedAt: now, auto: true } } : {}) } }, { new: true });
    if (!x) continue;
    if (!paid) { sum.cancelledFree++; await msg(x, 'Sorry, this event was cancelled'); continue; }
    const pay = await Payment.findById(b.paymentId);
    const ok = pay ? await refundPayment(pay) : false;
    await Booking.updateOne({ _id: x._id }, { $set: { 'refund.status': ok ? 'processed' : 'failed', 'refund.playOrderId': pay?.orderId } });
    if (ok) sum.refunded++; else sum.refundFailed++;
    await msg(x, ok ? 'Your payment has been refunded via Google Play' : 'Your refund is being processed');
  }
  return { event: ev, summary: sum };
}
