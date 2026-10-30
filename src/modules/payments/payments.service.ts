import { TicketResult } from './payments.types';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { getQueue, jobId } from '../../jobs/queue';
import { getPlayClient, mapPlayError, ProductPurchase, SubscriptionPurchase } from '../../integrations/play';
import { notify } from '../notifications/notifications.service';
import { scheduleExpire, onConfirmed, releaseTo } from '../bookings/bookings.service';
import { bookingOut } from '../bookings/bookings.service';
import { userRepository } from '../users/users.repository';
import { eventRepository, releaseSeat, reserveSeat } from '../events/events.repository';
import { bookingRepository } from '../bookings/bookings.repository';
import { paymentRepository } from './payments.repository';

const MIN = 60_000;
const ACK_LIMIT_MS = 3 * 86400_000; // Google auto-refunds unacknowledged purchases after 3 days
const isId = (s: unknown): s is string => typeof s === 'string' && Types.ObjectId.isValid(s) && String(new Types.ObjectId(s)) === s;

// ---------- Play: tickets ----------
async function ackProduct(pay: any) {
  try { await getPlayClient().acknowledgeProduct(pay.productId, pay.purchaseToken); await paymentRepository.updateOne({ _id: pay._id }, { acknowledged: true }); }
  catch (err) { logger.warn({ err, paymentId: String(pay._id) }, 'acknowledge failed; retry job will handle it'); }
}
export async function retryAck(paymentId: string) {
  const pay = await paymentRepository.findById(paymentId);
  if (!pay || pay.acknowledged || pay.status !== 'verified') return;
  if (pay.purchaseTime && Date.now() - +pay.purchaseTime > ACK_LIMIT_MS) { logger.error({ paymentId }, 'acknowledge window passed'); return; }
  const play = getPlayClient();
  if (pay.kind === 'ticket') await play.acknowledgeProduct(pay.productId, pay.purchaseToken); else await play.acknowledgeSubscription(pay.productId, pay.purchaseToken);
  await paymentRepository.updateOne({ _id: pay._id }, { acknowledged: true }); // a throw above makes BullMQ retry with backoff
}

/** Refund a payment through Play; on failure mark refund_failed and schedule a retry. */
export async function refundPayment(pay: any): Promise<boolean> {
  if (pay.status === 'refunded') return true;
  try {
    if (!pay.orderId) throw new AppError(409, 'ORDER_ID_MISSING');
    await getPlayClient().refundOrder(pay.orderId);
    await paymentRepository.updateOne({ _id: pay._id }, { status: 'refunded', refundedAt: new Date() });
    return true;
  } catch (err) {
    logger.error({ err, paymentId: String(pay._id) }, 'refund failed');
    await paymentRepository.updateOne({ _id: pay._id }, { status: 'refund_failed' });
    await getQueue().add('refund.retry', { paymentId: String(pay._id) }, { jobId: jobId('refund', String(pay._id)), delayMs: 5 * MIN });
    return false;
  }
}
export async function retryRefund(paymentId: string) {
  const pay = await paymentRepository.findById(paymentId);
  if (!pay || pay.status !== 'refund_failed' || !pay.orderId) return;
  await getPlayClient().refundOrder(pay.orderId);
  await paymentRepository.updateOne({ _id: pay._id }, { status: 'refunded', refundedAt: new Date() });
  await bookingRepository.updateOne({ paymentId: pay._id, 'refund.status': 'failed', status: 'cancelled_by_admin' }, { $set: { 'refund.status': 'processed' } });
}

/** Applies a Play product purchase to a booking (used by /payments/play/verify and RTDN). Implements section 4 ordering. */
export async function finalizeTicket(userId: string, bookingId: string, productId: string, token: string, p: ProductPurchase): Promise<TicketResult> {
  const b = await bookingRepository.findOne({ _id: bookingId, userId });
  if (!b) throw new AppError(404, 'BOOKING_NOT_FOUND');
  const ev = await eventRepository.findById(b.eventId);
  if (!ev?.playProductId || ev.playProductId !== productId || (p.productId && p.productId !== productId)) throw new AppError(400, 'PRODUCT_MISMATCH');
  // Flutter in_app_purchase can only set obfuscatedExternalAccountId (= userId); it is mandatory. The profile id is optional but, if present, must be this booking.
  if (!p.obfuscatedExternalAccountId || p.obfuscatedExternalAccountId !== userId) throw new AppError(400, 'PURCHASE_INVALID', 'Purchase does not belong to this user');
  if (p.obfuscatedExternalProfileId && p.obfuscatedExternalProfileId !== bookingId) throw new AppError(400, 'PURCHASE_INVALID', 'Purchase does not belong to this booking');
  if (!['pending', 'expired', 'cancelled'].includes(b.status)) { // only a pending booking (or the expired-retry path) can be paid; same-token retries stay idempotent
    const prev = await paymentRepository.findOne({ purchaseToken: token }).select('userId bookingId');
    if (!prev || String(prev.userId) !== userId || String(prev.bookingId) !== bookingId) throw new AppError(409, 'BOOKING_NOT_PENDING');
  }
  if (p.purchaseState === 2) { // pending (e.g. UPI): keep the seat a bit longer and wait for RTDN
    const until = new Date(Date.now() + env.PENDING_PURCHASE_HOLD_MIN * MIN);
    const ext = await bookingRepository.findOneAndUpdate({ _id: bookingId, status: 'pending', holdExpiresAt: { $lt: until } }, { $set: { holdExpiresAt: until } }, { new: true });
    if (ext) await scheduleExpire(ext);
    return { status: 'pending', booking: ext ?? b };
  }
  if (p.purchaseState !== 0) throw new AppError(400, 'PURCHASE_INVALID', 'Purchase is not completed');
  let pay: any;
  try {
    pay = await paymentRepository.create({ userId, bookingId, kind: 'ticket', productId, purchaseToken: token, orderId: p.orderId, amountInPaise: b.amountInPaise || ev.priceInPaise,
      purchaseTime: p.purchaseTimeMillis ? new Date(Number(p.purchaseTimeMillis)) : new Date(), acknowledged: p.acknowledgementState === 1 });
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
    const prev = await paymentRepository.findOne({ purchaseToken: token });
    if (prev && String(prev.userId) === userId && String(prev.bookingId) === bookingId)
      return { status: 'confirmed', booking: await bookingRepository.findById(bookingId) }; // retry of an already-applied purchase
    throw new AppError(409, 'PURCHASE_ALREADY_USED');
  }
  if (!pay.acknowledged) await getQueue().add('payment.ack', { paymentId: String(pay._id) }, { jobId: jobId('ack', String(pay._id)), delayMs: 10 * MIN });
  const set = { status: 'confirmed', paymentId: pay._id, playOrderId: p.orderId, confirmedAt: new Date() };
  let conf = await bookingRepository.findOneAndUpdate({ _id: bookingId, status: 'pending' }, { $set: set, $unset: { holdExpiresAt: 1 } }, { new: true });
  if (!conf) {
    const cur = await bookingRepository.findById(bookingId);
    if (cur && ['expired', 'cancelled'].includes(cur.status) && (await reserveSeat(cur.eventId, cur.gender as any))) {
      conf = await bookingRepository.findOneAndUpdate({ _id: bookingId, status: { $in: ['expired', 'cancelled'] } }, { $set: set, $unset: { cancelledAt: 1 } }, { new: true });
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
  await userRepository.updateOne({ _id: userId }, { $set: { chatPassUntil: until, chatPass: { productId: li?.productId, purchaseToken: token, state: sub.subscriptionState, autoRenewing: !!li?.autoRenewingPlan?.autoRenewEnabled, updatedAt: new Date() } } });
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
  try { pay = await paymentRepository.create({ userId, kind: 'chat_pass', productId, purchaseToken: token, orderId: sub.latestOrderId, purchaseTime: sub.startTime ? new Date(sub.startTime) : new Date(), acknowledged: sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' }); }
  catch (e: any) {
    if (e?.code !== 11000) throw e;
    pay = await paymentRepository.findOne({ purchaseToken: token });
    if (!pay || String(pay.userId) !== userId || pay.kind !== 'chat_pass') throw new AppError(409, 'PURCHASE_ALREADY_USED');
  }
  const until = await applySubscription(userId, token, sub);
  if (!pay.acknowledged) {
    await getQueue().add('payment.ack', { paymentId: String(pay._id) }, { jobId: jobId('ack', String(pay._id)), delayMs: 10 * MIN });
    try { await getPlayClient().acknowledgeSubscription(productId, token); await paymentRepository.updateOne({ _id: pay._id }, { acknowledged: true }); }
    catch (err) { logger.warn({ err }, 'subscription acknowledge failed; retry job will handle it'); }
  }
  return { status: 'confirmed' as const, chatPassUntil: until };
}
export async function passExpiring(d: { userId: string; until: number }) {
  const u = await userRepository.findById(d.userId).select('chatPassUntil chatPass');
  if (!u?.chatPassUntil || +u.chatPassUntil !== d.until || u.chatPass?.autoRenewing) return;
  await notify({ userId: d.userId, type: 'chat_pass_expiring', title: 'Chat Pass expires in 3 days', body: 'Renew to keep chatting with your matches', dedupeKey: jobId('passexp', d.userId, d.until) });
}

// ---------- RTDN ----------
export async function onSubscriptionRtdn(token: string) {
  const sub = await getPlayClient().getSubscription(token); // never trust the notification body, re-read from Google
  let pay = await paymentRepository.findOne({ purchaseToken: token });
  let userId = pay ? String(pay.userId) : sub.externalAccountIdentifiers?.obfuscatedExternalAccountId;
  if (!isId(userId) || !(await userRepository.exists({ _id: userId }))) { logger.warn('RTDN subscription for unknown user'); return 'ignored'; }
  const productId = sub.lineItems?.[0]?.productId;
  if (productId !== env.CHAT_PASS_PRODUCT_ID) return 'ignored';
  if (!pay) {
    try { pay = await paymentRepository.create({ userId, kind: 'chat_pass', productId, purchaseToken: token, orderId: sub.latestOrderId, purchaseTime: new Date() }); }
    catch (e: any) { if (e?.code !== 11000) throw e; pay = await paymentRepository.findOne({ purchaseToken: token }); }
  } else if (sub.latestOrderId && sub.latestOrderId !== pay.orderId) await paymentRepository.updateOne({ _id: pay._id }, { orderId: sub.latestOrderId });
  await applySubscription(userId!, token, sub);
  if (pay && !pay.acknowledged && sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING' && ACTIVE_SUB.includes(sub.subscriptionState))
    await getQueue().add('payment.ack', { paymentId: String(pay._id) }, { jobId: jobId('ack', String(pay._id)) });
  return 'processed';
}
export async function onOneTimeRtdn(n: { notificationType: number; purchaseToken: string; sku: string }) {
  if (n.notificationType !== 1) return 'ignored'; // 2 = pending purchase cancelled: the hold just expires
  const p = await getPlayClient().getProduct(n.sku, n.purchaseToken);
  if (p.purchaseState !== 0) return 'ignored';
  const userId = p.obfuscatedExternalAccountId;
  if (!isId(userId)) return 'ignored';
  // Flutter clients cannot set the profile id, so fall back to the user's latest pending booking for an event sold under this SKU.
  let bookingId = p.obfuscatedExternalProfileId;
  if (!bookingId) {
    const eventIds = await eventRepository.distinct('_id', { playProductId: n.sku });
    const pending = await bookingRepository.find({ userId, eventId: { $in: eventIds }, status: 'pending' }).select('_id').limit(2);
    // Never guess: only an unambiguous single pending booking is auto-confirmed. Otherwise the app's verify call (with bookingId) applies it.
    if (pending.length !== 1) { logger.warn({ sku: n.sku, matches: pending.length }, 'RTDN purchase without bookingId left for app verify'); return 'ignored'; }
    bookingId = String(pending[0]._id);
  }
  if (!isId(bookingId)) return 'ignored';
  if (await paymentRepository.exists({ purchaseToken: n.purchaseToken })) return 'ignored';
  try { await finalizeTicket(userId, bookingId, n.sku, n.purchaseToken, p); }
  catch (e) { if (e instanceof AppError && e.status < 500) { logger.warn({ code: e.code }, 'RTDN purchase not applied'); return 'ignored'; } throw e; }
  return 'processed';
}
export async function onVoided(token: string) {
  const pay = await paymentRepository.findOneAndUpdate({ purchaseToken: token, status: { $ne: 'voided' } }, { status: 'voided', voidedAt: new Date() }, { new: true });
  if (!pay) return 'ignored';
  if (pay.kind === 'chat_pass') {
    await userRepository.updateOne({ _id: pay.userId, 'chatPass.purchaseToken': token }, { $set: { chatPassUntil: new Date(), 'chatPass.state': 'VOIDED' } });
  } else if (pay.bookingId) {
    const b = await bookingRepository.findById(pay.bookingId); const ev = b && (await eventRepository.findById(b.eventId));
    if (b && ev && ev.startsAt > new Date()) await releaseTo(b._id, ['pending', 'confirmed', 'refund_requested'], 'cancelled', { paymentId: pay._id });
    else if (b) await bookingRepository.updateOne({ _id: b._id, paymentId: pay._id, status: { $in: ['confirmed', 'refund_requested'] } }, { status: 'refunded' });
  }
  return 'processed';
}
export async function syncVoided() {
  const list = await getPlayClient().listVoided(Date.now() - 3 * 86400_000);
  for (const v of list) await onVoided(v.purchaseToken);
}

// ---------- app endpoints ----------
/** POST /payments/play/verify. Returns HTTP-agnostic result; controller maps pending -> 202. */
export async function verifyPurchase(uid: string, { bookingId, purchaseToken, productId, kind }: { bookingId?: string; purchaseToken: string; productId: string; kind: 'ticket' | 'chat_pass' }) {
  const prev = await paymentRepository.findOne({ purchaseToken }).select('userId bookingId kind');
  if (prev && (String(prev.userId) !== uid || prev.kind !== kind || (kind === 'ticket' && String(prev.bookingId) !== bookingId)))
    throw new AppError(409, 'PURCHASE_ALREADY_USED');
  if (kind === 'chat_pass') return verifyChatPass(uid, productId, purchaseToken);
  const p = await getPlayClient().getProduct(productId, purchaseToken).catch((e) => { throw mapPlayError(e); });
  const r = await finalizeTicket(uid, bookingId!, productId, purchaseToken, p);
  return { status: r.status, booking: bookingOut(r.booking) };
}

export async function chatPassStatus(userId: string) {
  const u = await userRepository.findById(userId).select('chatPassUntil chatPass');
  const until = u?.chatPassUntil ?? null;
  return { chatPass: { active: !!until && +until > Date.now(), expiresAt: until, productId: u?.chatPass?.productId ?? null,
    autoRenewing: !!u?.chatPass?.autoRenewing, state: u?.chatPass?.state ?? null } };
}
