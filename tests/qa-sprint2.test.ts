process.env.AUTH_IP_LIMIT_PER_15MIN = '1000'; process.env.ADMIN_LOGIN_IP_LIMIT_PER_15MIN = '1000';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(40); process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
process.env.NODE_ENV = 'test'; process.env.MEDIA_URL_SECRET = 'm'.repeat(40); process.env.MONGO_URI = 'mongodb://placeholder';
process.env.PLAY_PACKAGE_NAME = 'in.sparkdate.app';
import request from 'supertest';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app';
import { User } from '../src/modules/auth/user.model';
import { hashPassword } from '../src/modules/auth/password';
import { issueTokens } from '../src/modules/auth/tokens';
import { Event } from '../src/modules/events/event.model';
import { Booking } from '../src/modules/events/booking.model';
import { Payment } from '../src/modules/payments/payment.model';
import { Notification } from '../src/modules/notifications/notification.model';
import { WebhookEvent } from '../src/modules/webhooks/webhookEvent.model';
import { setPlayClient, PlayClient, ProductPurchase, SubscriptionPurchase } from '../src/modules/payments/playClient';
import { setPubsubVerifier } from '../src/modules/webhooks/play.routes';
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

describe('QA: sprint 2 extra', () => {
  it('gender capacities are independent: male full, female can still book', async () => {
    const eid = await event({ capacity: { male: 1, female: 1 } });
    const m1 = await appUser(); const m2 = await appUser();
    const f = await appUser({ profile: { fullName: 'F', gender: 'female', interestedIn: 'male' } });
    await book(m1, eid).expect(201);
    expect((await book(m2, eid).expect(409)).body.error.code).toBe('EVENT_FULL');
    await book(f, eid).expect(201);
    const e = await Event.findById(eid);
    expect(e!.booked!.male).toBe(1); expect(e!.booked!.female).toBe(1);
  });
  it('same purchase token sent in parallel for two users confirms only one booking', async () => {
    const eid = await paidEvent(); const u1 = await appUser(); const u2 = await appUser();
    const b1 = (await book(u1, eid).expect(201)).body.booking; const b2 = (await book(u2, eid).expect(201)).body.booking;
    const tok = 'tok-race-' + crypto.randomUUID(); purchase(tok, u1.id, b1.id);
    const rs = await Promise.all([verify(u1, ticket(b1.id, tok)), verify(u2, ticket(b2.id, tok)), verify(u2, ticket(b2.id, tok))]);
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
    expect((await Booking.findById(b2.id))!.status).not.toBe('confirmed');
    expect(await Payment.countDocuments({ purchaseToken: tok })).toBe(1);
  });
  it('parallel verify of same token by owner acknowledges once', async () => {
    const eid = await paidEvent(); const u = await appUser();
    const b = (await book(u, eid).expect(201)).body.booking; const tok = 'tok-dbl-' + crypto.randomUUID(); purchase(tok, u.id, b.id);
    const rs = await Promise.all([1, 2, 3].map(() => verify(u, ticket(b.id, tok))));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(play.acks.filter((t) => t === tok)).toHaveLength(1);
    expect((await Event.findById(eid))!.booked!.male).toBe(1);
  });
});
