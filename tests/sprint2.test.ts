process.env.AUTH_IP_LIMIT_PER_15MIN = '1000'; process.env.ADMIN_LOGIN_IP_LIMIT_PER_15MIN = '1000';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(40); process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
process.env.NODE_ENV = 'test'; process.env.MEDIA_URL_SECRET = 'm'.repeat(40); process.env.MONGO_URI = 'mongodb://placeholder';
process.env.PLAY_PACKAGE_NAME = 'in.sparkdate.app';
import request from 'supertest';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app';
import { User } from '../src/modules/users/user.model';
import { hashPassword } from '../src/modules/auth/password';
import { issueTokens } from '../src/modules/auth/tokens';
import { Event } from '../src/modules/events/event.model';
import { Booking } from '../src/modules/bookings/booking.model';
import { Payment } from '../src/modules/payments/payment.model';
import { Notification } from '../src/modules/notifications/notification.model';
import { WebhookEvent } from '../src/modules/webhooks/webhookEvent.model';
import { setPlayClient, PlayClient, ProductPurchase, SubscriptionPurchase } from '../src/integrations/play';
import { setPubsubVerifier } from '../src/integrations/pubsub';
import { getQueue, MemoryQueue } from '../src/jobs/queue';
import { findMissingProdConfig } from '../src/config/env';
import { AppError } from '../src/utils/errors';

class FakePlay implements PlayClient {
  products = new Map<string, ProductPurchase>(); subs = new Map<string, SubscriptionPurchase>();
  acks: string[] = []; refunds: string[] = []; down = false;
  private chk() { if (this.down) throw new AppError(503, 'PLAY_UNAVAILABLE'); }
  async getProduct(_p: string, t: string) { this.chk(); const p = this.products.get(t); if (!p) throw new AppError(400, 'PURCHASE_INVALID'); return p; }
  async acknowledgeProduct(_p: string, t: string) { this.chk(); this.acks.push(t); }
  async getSubscription(t: string) { this.chk(); const s = this.subs.get(t); if (!s) throw new AppError(400, 'PURCHASE_INVALID'); return s; }
  async acknowledgeSubscription(_p: string, t: string) { this.chk(); this.acks.push(t); }
  async refundOrder(o: string) { this.chk(); this.refunds.push(o); }
  async listVoided() { return []; }
}
let play: FakePlay;
const q = () => getQueue() as MemoryQueue;
let mongo: MongoMemoryServer; const app = createApp();
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase(); await mongoose.syncIndexes();
  play = new FakePlay(); setPlayClient(play); await q().close();
  setPubsubVerifier(async (t) => { if (t !== 'good-oidc') throw new Error('bad'); });
});

const idem = () => crypto.randomUUID();
let phoneN = 0;
async function appUser(o: any = {}) {
  const u = await User.create({ phone: `+9190000${String(++phoneN).padStart(5, '0')}`, profileCompleted: true, verification: { status: 'approved' },
    profile: { fullName: 'U' + phoneN, gender: 'male', interestedIn: 'female' }, ...o });
  return { id: String(u._id), token: (await issueTokens(String(u._id), 'user')).accessToken };
}
async function admin(role = 'admin') {
  await User.create({ email: `${role}@sd.in`, role, passwordHash: await hashPassword('correct-horse-1') });
  const agent = request.agent(app);
  const r = await agent.post('/api/v1/admin/auth/login').send({ email: `${role}@sd.in`, password: 'correct-horse-1' }).expect(200);
  const csrf = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('csrf_token='))!.split(';')[0].split('=')[1];
  return { agent, csrf };
}
async function event(o: any = {}) {
  const e = await Event.create({ title: 'Friday Sparks', city: 'Indore', startsAt: new Date(Date.now() + 2 * 86400_000), capacity: { male: 2, female: 2 }, status: 'published',
    createdBy: new mongoose.Types.ObjectId(), ...o });
  return String(e._id);
}
const paidEvent = (o: any = {}) => event({ priceInPaise: 19900, playProductId: 'event_ticket_199', ...o });
const book = (u: { token: string }, eventId: string, key = idem()) =>
  request(app).post('/api/v1/bookings').set('Authorization', `Bearer ${u.token}`).set('Idempotency-Key', key).send({ eventId });
const verify = (u: { token: string }, body: any, key = idem()) =>
  request(app).post('/api/v1/payments/play/verify').set('Authorization', `Bearer ${u.token}`).set('Idempotency-Key', key).send(body);
function purchase(token: string, userId: string, bookingId: string, o: Partial<ProductPurchase> = {}) {
  play.products.set(token, { purchaseState: 0, orderId: 'GPA.' + token, productId: 'event_ticket_199', obfuscatedExternalAccountId: userId, obfuscatedExternalProfileId: bookingId, ...o });
}
const ticket = (bookingId: string, purchaseToken: string) => ({ bookingId, purchaseToken, productId: 'event_ticket_199', kind: 'ticket' });
async function paidConfirmed(u: any, eid: string, tok = 'tok-' + crypto.randomUUID()) {
  const b = (await book(u, eid).expect(201)).body.booking;
  purchase(tok, u.id, b.id);
  await verify(u, ticket(b.id, tok)).expect(200);
  return { bookingId: b.id, token: tok };
}
const push = (msg: any, messageId: string = crypto.randomUUID(), auth = 'good-oidc') => request(app).post('/api/v1/webhooks/play').set('Authorization', `Bearer ${auth}`)
  .send({ message: { messageId, data: Buffer.from(JSON.stringify({ packageName: 'in.sparkdate.app', ...msg })).toString('base64') }, subscription: 'projects/x/subscriptions/y' });

describe('events (app)', () => {
  it('lists upcoming with seatsLeft for caller gender, filters, paginates; detail; like/save idempotent', async () => {
    const m = await appUser(); const f = await appUser({ profile: { fullName: 'F', gender: 'female' } });
    const e1 = await event(); await event({ city: 'Bhopal', title: 'Bhopal Night' }); await event({ status: 'draft' });
    await Event.updateOne({ _id: e1 }, { 'booked.male': 2 });
    const all = (await request(app).get('/api/v1/events?limit=1').set('Authorization', `Bearer ${m.token}`).expect(200)).body;
    expect(all.items).toHaveLength(1); expect(all.nextCursor).toBeTruthy();
    const p2 = (await request(app).get(`/api/v1/events?limit=5&cursor=${all.nextCursor}`).set('Authorization', `Bearer ${m.token}`).expect(200)).body;
    expect(p2.items).toHaveLength(1); expect(p2.nextCursor).toBeNull();
    const indore = (await request(app).get('/api/v1/events?city=Indore').set('Authorization', `Bearer ${m.token}`).expect(200)).body.items;
    expect(indore).toHaveLength(1); expect(indore[0].seatsLeft).toBe(0);
    expect((await request(app).get('/api/v1/events?city=Indore').set('Authorization', `Bearer ${f.token}`)).body.items[0].seatsLeft).toBe(2);
    expect((await request(app).get('/api/v1/events?q=bhopal').set('Authorization', `Bearer ${m.token}`)).body.items).toHaveLength(1);
    await request(app).get('/api/v1/events').expect(401);
    for (let i = 0; i < 2; i++) await request(app).post(`/api/v1/events/${e1}/save`).set('Authorization', `Bearer ${m.token}`).expect(200);
    await request(app).post(`/api/v1/events/${e1}/like`).set('Authorization', `Bearer ${m.token}`).expect(200);
    const d = (await request(app).get(`/api/v1/events/${e1}`).set('Authorization', `Bearer ${m.token}`).expect(200)).body;
    expect(d).toMatchObject({ liked: true, saved: true, myBooking: null });
    expect((await request(app).get('/api/v1/me/events/saved').set('Authorization', `Bearer ${m.token}`)).body.items).toHaveLength(1);
    await request(app).delete(`/api/v1/events/${e1}/save`).set('Authorization', `Bearer ${m.token}`).expect(200);
    expect((await request(app).get('/api/v1/me/events/saved').set('Authorization', `Bearer ${m.token}`)).body.items).toHaveLength(0);
    const draft = await Event.findOne({ status: 'draft' });
    await request(app).get(`/api/v1/events/${draft!._id}`).set('Authorization', `Bearer ${m.token}`).expect(404);
  });
});

describe('bookings', () => {
  it('gates: profile, verification, Idempotency-Key', async () => {
    const eid = await event();
    const noProfile = await appUser({ profileCompleted: false });
    expect((await book(noProfile, eid).expect(403)).body.error.code).toBe('PROFILE_INCOMPLETE');
    const unverified = await appUser({ verification: { status: 'pending' } });
    expect((await book(unverified, eid).expect(403)).body.error.code).toBe('VERIFICATION_REQUIRED');
    const u = await appUser();
    const r = await request(app).post('/api/v1/bookings').set('Authorization', `Bearer ${u.token}`).send({ eventId: eid }).expect(400);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const blocked = await appUser({ status: 'blocked' });
    await book(blocked, eid).expect(403);
  });
  it('free booking confirms immediately; same key replays; second key returns existing', async () => {
    const eid = await event(); const u = await appUser(); const key = idem();
    const a = (await book(u, eid, key).expect(201)).body;
    expect(a.booking.status).toBe('confirmed'); expect(a.play).toBeUndefined();
    const b = await book(u, eid, key).expect(201);
    expect(b.headers['idempotent-replayed']).toBe('true'); expect(b.body.booking.id).toBe(a.booking.id);
    expect((await book(u, eid).expect(200)).body.booking.id).toBe(a.booking.id);
    expect((await Event.findById(eid))!.booked!.male).toBe(1);
    expect(await Notification.countDocuments({ type: 'booking_confirmed' })).toBe(1);
    expect(q().find('notify.reminder').length).toBe(2);
    const mine = (await request(app).get('/api/v1/me/bookings').set('Authorization', `Bearer ${u.token}`).expect(200)).body;
    expect(mine.upcoming).toHaveLength(1); expect(mine.past).toHaveLength(0);
    const other = await appUser();
    await request(app).delete(`/api/v1/bookings/${a.booking.id}`).set('Authorization', `Bearer ${other.token}`).expect(404);
    expect((await request(app).delete(`/api/v1/bookings/${a.booking.id}`).set('Authorization', `Bearer ${u.token}`).expect(409)).body.error.code).toBe('BOOKING_NOT_CANCELLABLE');
  });
  it('last-seat race: N parallel bookings never overbook', async () => {
    const eid = await paidEvent({ capacity: { male: 3, female: 3 } });
    const users = await Promise.all(Array.from({ length: 15 }, () => appUser()));
    const rs = await Promise.all(users.map((u) => book(u, eid)));
    expect(rs.filter((r) => r.status === 201).length).toBe(3);
    expect(rs.filter((r) => r.status === 409).every((r) => r.body.error.code === 'EVENT_FULL')).toBe(true);
    expect(rs.filter((r) => r.status === 409).length).toBe(12);
    expect((await Event.findById(eid))!.booked!.male).toBe(3);
    const ok = rs.find((r) => r.status === 201)!.body;
    expect(ok.booking.status).toBe('pending');
    expect(ok.play).toMatchObject({ productId: 'event_ticket_199' });
    expect(ok.play).not.toHaveProperty('obfuscatedProfileId');
  });
  it('same user parallel double-tap creates one booking and one seat', async () => {
    const eid = await paidEvent(); const u = await appUser();
    await Promise.all(Array.from({ length: 5 }, () => book(u, eid)));
    expect(await Booking.countDocuments({ eventId: eid })).toBe(1);
    expect((await Event.findById(eid))!.booked!.male).toBe(1);
  });
  it('cancel pending releases seat exactly once; expiry job after cancel is a no-op', async () => {
    const eid = await paidEvent(); const u = await appUser();
    const b = (await book(u, eid).expect(201)).body.booking;
    const rs = await Promise.all([1, 2, 3].map(() => request(app).delete(`/api/v1/bookings/${b.id}`).set('Authorization', `Bearer ${u.token}`)));
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
    await q().runDue(Date.now() + 3600_000);
    expect((await Event.findById(eid))!.booked!.male).toBe(0);
    expect((await book(u, eid).expect(201)).body.booking.id).toBe(b.id); // rebook revives the row
  });
});

describe('play verification', () => {
  it('ticket: verifies, confirms, acknowledges; token replay rejected', async () => {
    const eid = await paidEvent(); const u = await appUser();
    const { bookingId, token } = await paidConfirmed(u, eid);
    expect((await Booking.findById(bookingId))!.status).toBe('confirmed');
    const pay = await Payment.findOne({ purchaseToken: token });
    expect(pay).toMatchObject({ status: 'verified', acknowledged: true, orderId: 'GPA.' + token });
    expect(play.acks).toEqual([token]);
    await verify(u, ticket(bookingId, token)).expect(200); // same user retry is idempotent
    const u2 = await appUser(); const b2 = (await book(u2, eid).expect(201)).body.booking;
    expect((await verify(u2, ticket(b2.id, token)).expect(409)).body.error.code).toBe('PURCHASE_ALREADY_USED');
    expect(await Payment.countDocuments()).toBe(1);
  });
  it('rejects mismatched product, foreign booking, cancelled state, unknown token; Play outage is 503', async () => {
    const eid = await paidEvent(); const u = await appUser(); const other = await appUser();
    const b = (await book(u, eid).expect(201)).body.booking;
    expect((await verify(u, { ...ticket(b.id, 'tok-aaaaaaaaaa'), productId: 'event_ticket_499' }).expect(400)).body.error.code).toBe('PURCHASE_INVALID'); // unknown token at Play
    purchase('tok-bbbbbbbbbb', u.id, b.id, { productId: 'event_ticket_499' });
    expect((await verify(u, { ...ticket(b.id, 'tok-bbbbbbbbbb'), productId: 'event_ticket_499' }).expect(400)).body.error.code).toBe('PRODUCT_MISMATCH');
    purchase('tok-cccccccccc', other.id, b.id);
    expect((await verify(u, ticket(b.id, 'tok-cccccccccc')).expect(400)).body.error.code).toBe('PURCHASE_INVALID');
    expect((await verify(other, ticket(b.id, 'tok-cccccccccc')).expect(404)).body.error.code).toBe('BOOKING_NOT_FOUND');
    purchase('tok-dddddddddd', u.id, b.id, { purchaseState: 1 });
    expect((await verify(u, ticket(b.id, 'tok-dddddddddd')).expect(400)).body.error.code).toBe('PURCHASE_INVALID');
    purchase('tok-eeeeeeeeee', u.id, b.id); play.down = true;
    expect((await verify(u, ticket(b.id, 'tok-eeeeeeeeee')).expect(503)).body.error.code).toBe('PLAY_UNAVAILABLE');
    play.down = false;
    await verify(u, ticket(b.id, 'tok-eeeeeeeeee')).expect(200); // retryable with a new key
  });
  describe('Flutter purchases (only obfuscatedExternalAccountId set)', () => {
    const flutter = { obfuscatedExternalProfileId: undefined };
    it('confirms with accountId only, and rejects another user\'s accountId with PURCHASE_INVALID', async () => {
      const eid = await paidEvent(); const u = await appUser(); const other = await appUser();
      const b = (await book(u, eid).expect(201)).body.booking;
      purchase('tok-flutter-other', other.id, b.id, flutter);
      expect((await verify(u, ticket(b.id, 'tok-flutter-other')).expect(400)).body.error.code).toBe('PURCHASE_INVALID');
      purchase('tok-flutter-noacct', u.id, b.id, { ...flutter, obfuscatedExternalAccountId: undefined });
      expect((await verify(u, ticket(b.id, 'tok-flutter-noacct')).expect(400)).body.error.code).toBe('PURCHASE_INVALID');
      purchase('tok-flutter-own', u.id, b.id, flutter);
      expect((await verify(u, ticket(b.id, 'tok-flutter-own')).expect(200)).body.status).toBe('confirmed');
    });
    it('rejects paying for another user\'s booking', async () => {
      const eid = await paidEvent(); const u = await appUser(); const other = await appUser();
      const ob = (await book(other, eid).expect(201)).body.booking;
      purchase('tok-flutter-foreign', u.id, ob.id, flutter);
      expect((await verify(u, ticket(ob.id, 'tok-flutter-foreign')).expect(404)).body.error.code).toBe('BOOKING_NOT_FOUND');
      expect((await Booking.findById(ob.id))!.status).toBe('pending');
    });
    it('one purchase token cannot confirm two bookings', async () => {
      const u = await appUser();
      const b1 = (await book(u, await paidEvent()).expect(201)).body.booking;
      const b2 = (await book(u, await paidEvent()).expect(201)).body.booking;
      purchase('tok-flutter-twice', u.id, b1.id, flutter);
      await verify(u, ticket(b1.id, 'tok-flutter-twice')).expect(200);
      expect((await verify(u, ticket(b2.id, 'tok-flutter-twice')).expect(409)).body.error.code).toBe('PURCHASE_ALREADY_USED');
      expect((await Booking.findById(b2.id))!.status).toBe('pending');
      expect(await Payment.countDocuments({ purchaseToken: 'tok-flutter-twice' })).toBe(1);
    });
  });
  it('RTDN without bookingId never guesses between two pending bookings of the same product; app verify then confirms the right one', async () => {
    const u = await appUser();
    const b1 = (await book(u, await paidEvent()).expect(201)).body.booking;
    const b2 = (await book(u, await paidEvent()).expect(201)).body.booking;
    purchase('tok-ambiguous-1', u.id, b2.id, { obfuscatedExternalProfileId: undefined });
    await push({ oneTimeProductNotification: { notificationType: 1, purchaseToken: 'tok-ambiguous-1', sku: 'event_ticket_199' } }).expect(204);
    await q().runDue(Date.now(), 'webhook.process');
    expect((await Booking.findById(b1.id))!.status).toBe('pending');
    expect((await Booking.findById(b2.id))!.status).toBe('pending');
    expect(await Payment.countDocuments({ purchaseToken: 'tok-ambiguous-1' })).toBe(0);
    expect((await verify(u, ticket(b2.id, 'tok-ambiguous-1')).expect(200)).body.status).toBe('confirmed');
    expect((await Booking.findById(b2.id))!.status).toBe('confirmed');
    expect((await Booking.findById(b1.id))!.status).toBe('pending');
  });
  it('hold expiry vs late purchase: re-holds if seat free, refunds if full', async () => {
    const eid = await paidEvent({ capacity: { male: 1, female: 1 } }); const u = await appUser(); const u2 = await appUser();
    const b = (await book(u, eid).expect(201)).body.booking;
    await Booking.updateOne({ _id: b.id }, { holdExpiresAt: new Date(Date.now() - 1000) });
    await q().runDue(Date.now() + 11 * 60_000, 'booking.expire');
    expect((await Booking.findById(b.id))!.status).toBe('expired');
    expect((await Event.findById(eid))!.booked!.male).toBe(0);
    purchase('tok-late-1111', u.id, b.id);
    expect((await verify(u, ticket(b.id, 'tok-late-1111')).expect(200)).body.booking.status).toBe('confirmed');
    expect((await Event.findById(eid))!.booked!.male).toBe(1);
    // second user: hold expires, seat taken by someone else, then a late purchase arrives
    const eid2 = await paidEvent({ capacity: { male: 1, female: 1 } });
    const b2 = (await book(u2, eid2).expect(201)).body.booking;
    await Booking.updateOne({ _id: b2.id }, { holdExpiresAt: new Date(Date.now() - 1000) });
    await q().runDue(Date.now() + 11 * 60_000, 'booking.expire');
    await book(await appUser(), eid2).expect(201);
    purchase('tok-late-2222', u2.id, b2.id);
    expect((await verify(u2, ticket(b2.id, 'tok-late-2222')).expect(409)).body.error.code).toBe('EVENT_FULL_REFUNDED');
    expect(play.refunds).toEqual(['GPA.tok-late-2222']);
    expect((await Payment.findOne({ purchaseToken: 'tok-late-2222' }))!.status).toBe('refunded');
    expect((await Event.findById(eid2))!.booked!.male).toBe(1);
  });
  it('pending UPI purchase extends the hold and completes via RTDN', async () => {
    const eid = await paidEvent(); const u = await appUser();
    const b = (await book(u, eid).expect(201)).body.booking;
    purchase('tok-upi-12345', u.id, b.id, { purchaseState: 2 });
    const r = await verify(u, ticket(b.id, 'tok-upi-12345')).expect(202);
    expect(r.body.status).toBe('pending');
    const held = (await Booking.findById(b.id))!;
    expect(held.status).toBe('pending'); expect(+held.holdExpiresAt! - Date.now()).toBeGreaterThan(25 * 60_000);
    await q().runDue(Date.now() + 11 * 60_000, 'booking.expire'); // original 10-min job must not expire the extended hold
    expect((await Booking.findById(b.id))!.status).toBe('pending');
    expect(await Payment.countDocuments()).toBe(0);
    purchase('tok-upi-12345', u.id, b.id, { purchaseState: 0 });
    await push({ oneTimeProductNotification: { notificationType: 1, purchaseToken: 'tok-upi-12345', sku: 'event_ticket_199' } }).expect(204);
    await q().runDue(Date.now(), 'webhook.process');
    expect((await Booking.findById(b.id))!.status).toBe('confirmed');
    await verify(u, ticket(b.id, 'tok-upi-12345')).expect(200); // app's later verify is idempotent
  });
  it('acknowledge failure is retried by the job', async () => {
    const eid = await paidEvent(); const u = await appUser();
    const b = (await book(u, eid).expect(201)).body.booking;
    purchase('tok-ack-12345', u.id, b.id);
    const orig = play.acknowledgeProduct.bind(play);
    play.acknowledgeProduct = async () => { throw new AppError(503, 'PLAY_UNAVAILABLE'); };
    await verify(u, ticket(b.id, 'tok-ack-12345')).expect(200);
    expect((await Payment.findOne())!.acknowledged).toBe(false);
    play.acknowledgeProduct = orig;
    await q().runDue(Date.now() + 11 * 60_000, 'payment.ack');
    expect((await Payment.findOne())!.acknowledged).toBe(true);
  });
  it('chat pass: verify sets chatPassUntil; RTDN expiry/revoke updates it', async () => {
    const u = await appUser(); const exp = new Date(Date.now() + 30 * 86400_000).toISOString();
    play.subs.set('sub-tok-12345', { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', latestOrderId: 'GPA.sub', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      externalAccountIdentifiers: { obfuscatedExternalAccountId: u.id }, lineItems: [{ productId: 'chat_pass_monthly', expiryTime: exp, autoRenewingPlan: { autoRenewEnabled: true } }] });
    expect((await verify(u, { purchaseToken: 'sub-tok-12345', productId: 'event_ticket_199', kind: 'chat_pass' }).expect(400)).body.error.code).toBe('PRODUCT_MISMATCH');
    await verify(u, { purchaseToken: 'sub-tok-12345', productId: 'chat_pass_monthly', kind: 'chat_pass' }).expect(200);
    const s = (await request(app).get('/api/v1/subscriptions/me').set('Authorization', `Bearer ${u.token}`).expect(200)).body.chatPass;
    expect(s).toMatchObject({ active: true, expiresAt: exp, autoRenewing: true });
    expect(play.acks).toContain('sub-tok-12345');
    const other = await appUser();
    expect((await verify(other, { purchaseToken: 'sub-tok-12345', productId: 'chat_pass_monthly', kind: 'chat_pass' }).expect(409)).body.error.code).toBe('PURCHASE_ALREADY_USED');
    play.subs.get('sub-tok-12345')!.subscriptionState = 'SUBSCRIPTION_STATE_REVOKED';
    await push({ subscriptionNotification: { notificationType: 12, purchaseToken: 'sub-tok-12345', subscriptionId: 'chat_pass_monthly' } }).expect(204);
    await q().runDue(Date.now(), 'webhook.process');
    expect((await request(app).get('/api/v1/subscriptions/me').set('Authorization', `Bearer ${u.token}`)).body.chatPass.active).toBe(false);
  });
});

describe('webhooks', () => {
  it('rejects missing/invalid OIDC; duplicate delivery processed once; foreign package ignored', async () => {
    await push({ testNotification: {} }, 'm1', 'bad').expect(401);
    await request(app).post('/api/v1/webhooks/play').send({ message: { messageId: 'x', data: '' } }).expect(401);
    const u = await appUser(); const exp = new Date(Date.now() + 30 * 86400_000).toISOString();
    play.subs.set('sub-tok-renew1', { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      externalAccountIdentifiers: { obfuscatedExternalAccountId: u.id }, lineItems: [{ productId: 'chat_pass_monthly', expiryTime: exp }] });
    let calls = 0; const orig = play.getSubscription.bind(play); play.getSubscription = async (t) => { calls++; return orig(t); };
    const msg = { subscriptionNotification: { notificationType: 2, purchaseToken: 'sub-tok-renew1', subscriptionId: 'chat_pass_monthly' } };
    await push(msg, 'dup-1').expect(204); await push(msg, 'dup-1').expect(204);
    await q().runDue();
    expect(calls).toBe(1);
    expect(await WebhookEvent.countDocuments()).toBe(1);
    expect((await WebhookEvent.findOne())!.status).toBe('processed');
    expect(+(await User.findById(u.id))!.chatPassUntil!).toBe(+new Date(exp));
    await request(app).post('/api/v1/webhooks/play').set('Authorization', 'Bearer good-oidc')
      .send({ message: { messageId: 'other-pkg', data: Buffer.from(JSON.stringify({ packageName: 'com.evil', subscriptionNotification: msg.subscriptionNotification })).toString('base64') } }).expect(204);
    await q().runDue(); expect(calls).toBe(1);
  });
  it('voided purchase cancels a future booking and releases the seat', async () => {
    const eid = await paidEvent(); const u = await appUser();
    const { bookingId, token } = await paidConfirmed(u, eid);
    await push({ voidedPurchaseNotification: { purchaseToken: token, orderId: 'GPA.' + token, productType: 2 } }).expect(204);
    await q().runDue();
    expect((await Booking.findById(bookingId))!.status).toBe('cancelled');
    expect((await Payment.findOne({ purchaseToken: token }))!.status).toBe('voided');
    expect((await Event.findById(eid))!.booked!.male).toBe(0);
  });
});

describe('refunds and admin', () => {
  async function eligible() {
    const eid = await paidEvent(); const u = await appUser();
    const { bookingId } = await paidConfirmed(u, eid);
    await Booking.updateOne({ _id: bookingId }, { attendedAt: new Date() });
    await Event.updateOne({ _id: eid }, { startsAt: new Date(Date.now() - 3 * 3600_000), endsAt: new Date(Date.now() - 3600_000), status: 'ended' });
    await q().runDue(Date.now() + 10 * 86400_000, 'event.finalize');
    return { u, bookingId, eid };
  }
  it('not eligible before finalize; double request rejected; admin approves once via orders.refund', async () => {
    const eid = await paidEvent(); const u0 = await appUser();
    const { bookingId: b0 } = await paidConfirmed(u0, eid);
    const rr = (u: any, id: string) => request(app).post(`/api/v1/bookings/${id}/refund-request`).set('Authorization', `Bearer ${u.token}`).set('Idempotency-Key', idem()).send({ reason: 'No match' });
    expect((await rr(u0, b0).expect(409)).body.error.code).toBe('REFUND_NOT_ELIGIBLE');
    const { u, bookingId } = await eligible();
    expect((await request(app).get('/api/v1/me/bookings').set('Authorization', `Bearer ${u.token}`)).body.past[0].refundEligible).toBe(true);
    const both = await Promise.all([rr(u, bookingId), rr(u, bookingId)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await rr(u, bookingId).expect(409)).body.error.code).toBe('REFUND_ALREADY_REQUESTED');
    const a = await admin();
    expect((await a.agent.get('/api/v1/admin/refunds?status=requested').expect(200)).body.total).toBe(1);
    expect((await a.agent.get('/api/v1/admin/stats').expect(200)).body.pendingRefunds).toBe(1);
    await a.agent.post(`/api/v1/admin/refunds/${bookingId}/approve`).expect(403); // CSRF
    const res = await Promise.all([1, 2].map(() => a.agent.post(`/api/v1/admin/refunds/${bookingId}/approve`).set('X-CSRF-Token', a.csrf)));
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(play.refunds).toHaveLength(1);
    expect((await Booking.findById(bookingId))!.status).toBe('refunded');
    expect(await Notification.countDocuments({ type: 'refund_processed' })).toBe(1);
    const pays = (await a.agent.get('/api/v1/admin/payments?status=refunded').expect(200)).body.items;
    expect(pays).toHaveLength(1); expect(pays[0].purchaseToken).toBeUndefined();
  });
  it('reject requires reason and is final', async () => {
    const { u, bookingId } = await eligible(); const a = await admin();
    await request(app).post(`/api/v1/bookings/${bookingId}/refund-request`).set('Authorization', `Bearer ${u.token}`).set('Idempotency-Key', idem()).send({ reason: 'No match' }).expect(200);
    await a.agent.post(`/api/v1/admin/refunds/${bookingId}/reject`).set('X-CSRF-Token', a.csrf).send({}).expect(400);
    await a.agent.post(`/api/v1/admin/refunds/${bookingId}/reject`).set('X-CSRF-Token', a.csrf).send({ reason: 'Matched in round 2' }).expect(200);
    expect((await Booking.findById(bookingId))!.status).toBe('confirmed');
    const r = await request(app).post(`/api/v1/bookings/${bookingId}/refund-request`).set('Authorization', `Bearer ${u.token}`).set('Idempotency-Key', idem()).send({ reason: 'again' });
    expect(r.body.error.code).toBe('REFUND_REJECTED');
  });
  it('admin cancel with mixed free/paid/pending bookings', async () => {
    const eid = await paidEvent({ capacity: { male: 5, female: 5 } });
    const paid = await appUser(); const pend = await appUser(); const free = await appUser();
    const { bookingId: pb } = await paidConfirmed(paid, eid);
    const pendId = (await book(pend, eid).expect(201)).body.booking.id;
    const fb = await Booking.create({ eventId: eid, userId: free.id, gender: 'male', status: 'confirmed', amountInPaise: 0 });
    await Event.updateOne({ _id: eid }, { $inc: { 'booked.male': 1 } });
    const a = await admin();
    expect((await a.agent.patch(`/api/v1/admin/events/${eid}`).set('X-CSRF-Token', a.csrf).send({ status: 'cancelled' }).expect(409)).body.error.code).toBe('USE_CANCEL_ENDPOINT');
    const r = (await a.agent.post(`/api/v1/admin/events/${eid}/cancel`).set('X-CSRF-Token', a.csrf).expect(200)).body;
    expect(r.summary).toEqual({ cancelledPending: 1, cancelledFree: 1, refunded: 1, refundFailed: 0 });
    expect((await Booking.findById(pb))!.toObject()).toMatchObject({ status: 'cancelled_by_admin', refund: { status: 'processed' } });
    expect((await Booking.findById(pendId))!.status).toBe('cancelled');
    expect((await Booking.findById(fb._id))!.status).toBe('cancelled_by_admin');
    expect(play.refunds).toHaveLength(1);
    expect(await Notification.countDocuments({ type: 'event_cancelled' })).toBe(3);
    const again = (await a.agent.post(`/api/v1/admin/events/${eid}/cancel`).set('X-CSRF-Token', a.csrf).expect(200)).body;
    expect(again.summary).toEqual({ cancelledPending: 0, cancelledFree: 0, refunded: 0, refundFailed: 0 });
    expect(play.refunds).toHaveLength(1);
  });
  it('authz: app users and hosts cannot use money admin APIs', async () => {
    const u = await appUser(); const h = await admin('host'); const eid = await event();
    await request(app).get('/api/v1/admin/refunds').set('Authorization', `Bearer ${u.token}`).expect(403);
    await h.agent.get('/api/v1/admin/refunds').expect(403);
    await h.agent.get('/api/v1/admin/payments').expect(403);
    await h.agent.post(`/api/v1/admin/events/${eid}/cancel`).set('X-CSRF-Token', h.csrf).expect(403);
    await request(app).get('/api/v1/admin/payments').expect(401);
    await request(app).get('/api/v1/subscriptions/me').expect(401);
  });
});

describe('production config', () => {
  it('requires Play, Pub/Sub, Redis; SA key must be outside the repo', () => {
    expect(findMissingProdConfig({}, '/srv/app').sort()).toEqual(['GOOGLE_PLAY_SA_JSON_PATH', 'PLAY_PACKAGE_NAME', 'PUBSUB_PUSH_AUDIENCE', 'PUBSUB_SA_EMAIL', 'REDIS_URL']);
    const ok = { PLAY_PACKAGE_NAME: 'in.sparkdate.app', GOOGLE_PLAY_SA_JSON_PATH: '/etc/sparkdate/play.json', PUBSUB_PUSH_AUDIENCE: 'https://api.sparkdate.in/api/v1/webhooks/play',
      PUBSUB_SA_EMAIL: 'push@proj.iam.gserviceaccount.com', REDIS_URL: 'redis://127.0.0.1:6379' };
    expect(findMissingProdConfig(ok, '/srv/app')).toEqual([]);
    expect(findMissingProdConfig({ ...ok, GOOGLE_PLAY_SA_JSON_PATH: './keys/play.json' }, '/srv/app')).toEqual(['GOOGLE_PLAY_SA_JSON_PATH']);
    expect(findMissingProdConfig({ ...ok, PLAY_PACKAGE_NAME: 'com.example.sparkdate' }, '/srv/app')).toEqual(['PLAY_PACKAGE_NAME']);
  });
});

describe('admin payments/refunds search', () => {
  it('filters payments by eventId and q; returns minimal user; no purchaseToken', async () => {
    const e1 = await paidEvent(); const e2 = await paidEvent();
    const asha = await appUser({ profile: { fullName: 'Asha Verma', gender: 'male' }, email: 'asha@x.in' });
    const ravi = await appUser({ profile: { fullName: 'Ravi K', gender: 'male' } });
    await paidConfirmed(asha, e1); await paidConfirmed(ravi, e2); await paidConfirmed(ravi, e1);
    const a = await admin();
    const byEvent = (await a.agent.get(`/api/v1/admin/payments?eventId=${e1}`).expect(200)).body;
    expect(byEvent.total).toBe(2);
    await a.agent.get('/api/v1/admin/payments?eventId=nope').expect(400);
    const s = (await a.agent.get('/api/v1/admin/payments?q=asha').expect(200)).body;
    expect(s.total).toBe(1);
    expect(s.items[0].user).toEqual({ id: asha.id, fullName: 'Asha Verma', phone: expect.stringMatching(/^\+91/) });
    expect(s.items[0].purchaseToken).toBeUndefined(); expect(Object.keys(s.items[0].user).sort()).toEqual(['fullName', 'id', 'phone']);
    expect((await a.agent.get('/api/v1/admin/payments?q=ASHA@X').expect(200)).body.total).toBe(1);
    const phone = s.items[0].user.phone;
    expect((await a.agent.get(`/api/v1/admin/payments?q=${encodeURIComponent(phone)}&eventId=${e2}`).expect(200)).body.total).toBe(0);
    expect((await a.agent.get('/api/v1/admin/payments?q=.*').expect(200)).body.total).toBe(0); // regex escaped
    await a.agent.get(`/api/v1/admin/payments?q=${'a'.repeat(81)}`).expect(400);
    expect((await a.agent.get(`/api/v1/admin/payments?q=ravi&userId=${asha.id}`).expect(200)).body.total).toBe(0);
  });
  it('refunds q search includes user', async () => {
    const eid = await paidEvent(); const u = await appUser({ profile: { fullName: 'Meera S', gender: 'male' } });
    const { bookingId } = await paidConfirmed(u, eid);
    await Booking.updateOne({ _id: bookingId }, { refundEligible: true, status: 'refund_requested', refund: { status: 'requested', reason: 'x', requestedAt: new Date() } });
    const a = await admin();
    const r = (await a.agent.get('/api/v1/admin/refunds?q=meera').expect(200)).body;
    expect(r.total).toBe(1); expect(r.items[0].user).toEqual({ id: u.id, fullName: 'Meera S', phone: expect.any(String) });
    expect((await a.agent.get('/api/v1/admin/refunds?q=nobody').expect(200)).body.total).toBe(0);
  });
});
