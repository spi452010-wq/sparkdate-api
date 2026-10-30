process.env.AUTH_IP_LIMIT_PER_15MIN = process.env.AUTH_IP_LIMIT_PER_15MIN ?? '1000'; process.env.ADMIN_LOGIN_IP_LIMIT_PER_15MIN = process.env.ADMIN_LOGIN_IP_LIMIT_PER_15MIN ?? '1000';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(40); process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
process.env.NODE_ENV = 'test'; process.env.MEDIA_URL_SECRET = 'm'.repeat(40); process.env.MONGO_URI = 'mongodb://placeholder';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app';
import { User } from '../src/modules/users/user.model';
import { hashPassword } from '../src/modules/auth/password';
import { Event } from '../src/modules/events/event.model';
import { reserveSeat } from '../src/modules/events/events.repository';

let mongo: MongoMemoryServer; const app = createApp();
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { await mongoose.connection.db!.dropDatabase(); await mongoose.syncIndexes();
  const pw = await hashPassword('correct-horse-1');
  await User.create([{ email: 'admin@sd.in', role: 'admin', passwordHash: pw }, { email: 'host@sd.in', role: 'host', passwordHash: pw },
    { email: 'user@sd.in', role: 'user', passwordHash: pw }, { email: 'blocked@sd.in', role: 'admin', status: 'blocked', passwordHash: pw }]);
});

async function session(email = 'admin@sd.in') {
  const agent = request.agent(app);
  const r = await agent.post('/api/v1/admin/auth/login').send({ email, password: 'correct-horse-1' }).expect(200);
  const csrf = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('csrf_token='))!.split(';')[0].split('=')[1];
  return { agent, csrf, cookies: r.headers['set-cookie'] as unknown as string[] };
}
const future = () => new Date(Date.now() + 86400_000).toISOString();
const ev = (o: any = {}) => ({ title: 'Friday Sparks', city: 'Indore', startsAt: future(), capacity: { male: 2, female: 2 }, ...o });

describe('admin session', () => {
  it('sets httpOnly cookies and no token in body', async () => {
    const { cookies } = await session();
    expect(cookies.find((c) => c.startsWith('sd_at='))).toMatch(/HttpOnly/);
    expect(cookies.find((c) => c.startsWith('sd_rt='))).toMatch(/HttpOnly/);
  });
  it('rejects wrong password, user role, blocked', async () => {
    await request(app).post('/api/v1/admin/auth/login').send({ email: 'admin@sd.in', password: 'wrong-pass-1' }).expect(401);
    await request(app).post('/api/v1/admin/auth/login').send({ email: 'nobody@sd.in', password: 'wrong-pass-1' }).expect(401);
    await request(app).post('/api/v1/admin/auth/login').send({ email: 'user@sd.in', password: 'correct-horse-1' }).expect(403);
    await request(app).post('/api/v1/admin/auth/login').send({ email: 'blocked@sd.in', password: 'correct-horse-1' }).expect(403);
  });
  it('me works, unsafe request without CSRF fails', async () => {
    const { agent, csrf } = await session();
    expect((await agent.get('/api/v1/admin/auth/me').expect(200)).body.role).toBe('admin');
    await agent.post('/api/v1/admin/events').send(ev()).expect(403);
    await agent.post('/api/v1/admin/events').set('X-CSRF-Token', csrf).send(ev()).expect(201);
  });
  it('me rotates refresh when access cookie missing; logout kills session', async () => {
    const { cookies, csrf } = await session();
    const rt = cookies.find((c) => c.startsWith('sd_rt='))!.split(';')[0];
    await request(app).get('/api/v1/admin/auth/me').set('Cookie', rt).expect(200);
    await request(app).get('/api/v1/admin/auth/me').set('Cookie', rt).expect(401); // old refresh reused
    const s2 = await session();
    await s2.agent.post('/api/v1/admin/auth/logout').set('X-CSRF-Token', s2.csrf).expect(204);
    await s2.agent.get('/api/v1/admin/auth/me').expect(401);
    void csrf;
  });
});

it('locks account after 5 wrong passwords', async () => {
  for (let i = 0; i < 5; i++) await request(app).post('/api/v1/admin/auth/login').send({ email: 'admin@sd.in', password: 'wrong-pass-1' }).expect(401);
  const r = await request(app).post('/api/v1/admin/auth/login').send({ email: 'admin@sd.in', password: 'correct-horse-1' }).expect(429);
  expect(r.body.error.code).toBe('ACCOUNT_LOCKED');
});
it('cookie is not accepted outside /admin', async () => {
  const { agent } = await session();
  await agent.get('/api/v1/profile/me').expect(401);
});

describe('admin events', () => {
  it('validates input', async () => {
    const { agent, csrf } = await session();
    await agent.post('/api/v1/admin/events').set('X-CSRF-Token', csrf).send(ev({ priceInPaise: 19900 })).expect(400);
    await agent.post('/api/v1/admin/events').set('X-CSRF-Token', csrf).send(ev({ capacity: { male: 200, female: 200 } })).expect(400);
    await agent.post('/api/v1/admin/events').set('X-CSRF-Token', csrf).send(ev({ startsAt: '2020-01-01T00:00:00Z' })).expect(400);
    await agent.post('/api/v1/admin/events').set('X-CSRF-Token', csrf).send(ev({ booked: { male: 9, female: 0 } })).expect(400);
    await agent.post('/api/v1/admin/events').set('X-CSRF-Token', csrf).send(ev({ city: undefined })).expect(400);
    await agent.post('/api/v1/admin/events').set('X-CSRF-Token', csrf).send(ev({ city: '   ' })).expect(400);
    await agent.post('/api/v1/admin/events').set('X-CSRF-Token', csrf).send(ev({ city: 'x'.repeat(61) })).expect(400);
    const cid = (await agent.post('/api/v1/admin/events').set('X-CSRF-Token', csrf).send(ev({ city: '  Bhopal  ' })).expect(201)).body;
    expect(cid.city).toBe('Bhopal');
    await agent.patch(`/api/v1/admin/events/${cid.id}`).set('X-CSRF-Token', csrf).send({ city: '  ' }).expect(400);
    await agent.patch(`/api/v1/admin/events/${cid.id}`).set('X-CSRF-Token', csrf).send({ city: null }).expect(400);
    expect((await agent.patch(`/api/v1/admin/events/${cid.id}`).set('X-CSRF-Token', csrf).send({ title: 'Renamed' }).expect(200)).body.city).toBe('Bhopal');
    await agent.post('/api/v1/admin/events').set('X-CSRF-Token', csrf).send(ev({ priceInPaise: 19900, playProductId: 'event_ticket_199' })).expect(201);
  });
  it('seat reservation never overbooks under concurrency', async () => {
    const { agent, csrf } = await session();
    const id = (await agent.post('/api/v1/admin/events').set('X-CSRF-Token', csrf).send(ev({ status: 'published' })).expect(201)).body.id;
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveSeat(id, 'male')));
    expect(results.filter(Boolean).length).toBe(2);
    expect((await Event.findById(id))!.booked!.male).toBe(2);
    const r = await agent.patch(`/api/v1/admin/events/${id}`).set('X-CSRF-Token', csrf).send({ capacity: { male: 1, female: 2 } }).expect(409);
    expect(r.body.error.code).toBe('CAPACITY_BELOW_BOOKED');
    await agent.patch(`/api/v1/admin/events/${id}`).set('X-CSRF-Token', csrf).send({ capacity: { male: 5, female: 2 } }).expect(200);
  });
  it('status transitions guarded', async () => {
    const { agent, csrf } = await session();
    const id = (await agent.post('/api/v1/admin/events').set('X-CSRF-Token', csrf).send(ev()).expect(201)).body.id;
    await agent.patch(`/api/v1/admin/events/${id}`).set('X-CSRF-Token', csrf).send({ status: 'ended' }).expect(409);
    await agent.patch(`/api/v1/admin/events/${id}`).set('X-CSRF-Token', csrf).send({ status: 'cancelled' }).expect(200);
    await agent.patch(`/api/v1/admin/events/${id}`).set('X-CSRF-Token', csrf).send({ status: 'published' }).expect(409);
  });
  it('hosts only see own events; hosts cannot use admin-only APIs', async () => {
    const a = await session(); const h = await session('host@sd.in');
    const id = (await a.agent.post('/api/v1/admin/events').set('X-CSRF-Token', a.csrf).send(ev()).expect(201)).body.id;
    await h.agent.get(`/api/v1/admin/events/${id}`).expect(404);
    expect((await h.agent.get('/api/v1/admin/events').expect(200)).body.total).toBe(0);
    await h.agent.get('/api/v1/admin/users').expect(403);
    await h.agent.get('/api/v1/admin/stats').expect(403);
  });
  it('users q search and stats', async () => {
    const { agent } = await session();
    await User.create({ phone: '+919811112222', profile: { fullName: 'Riya Sharma' } });
    expect((await agent.get('/api/v1/admin/users?q=riya').expect(200)).body.total).toBe(1);
    expect((await agent.get('/api/v1/admin/users?q=(.*').expect(200)).body.total).toBe(0);
    expect((await agent.get('/api/v1/admin/stats').expect(200)).body.totalUsers).toBe(2);
  });
});
