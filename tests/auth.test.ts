process.env.AUTH_IP_LIMIT_PER_15MIN = process.env.AUTH_IP_LIMIT_PER_15MIN ?? '1000'; process.env.ADMIN_LOGIN_IP_LIMIT_PER_15MIN = process.env.ADMIN_LOGIN_IP_LIMIT_PER_15MIN ?? '1000';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(40); process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
process.env.NODE_ENV = 'test'; process.env.MEDIA_URL_SECRET = 'm'.repeat(40); process.env.UPLOAD_DIR = require('os').tmpdir() + '/sd-test-' + process.pid; process.env.MONGO_URI = 'mongodb://placeholder';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app';
import { setOtpSender } from '../src/integrations/whatsapp';
import { setGoogleVerifier } from '../src/integrations/google';
import { Otp } from '../src/modules/auth/otp.model';
import { User } from '../src/modules/users/user.model';
import { AppError } from '../src/utils/errors';

let mongo: MongoMemoryServer; const app = createApp(); const sent: Record<string, string> = {};
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await mongoose.syncIndexes();
  setOtpSender({ send: async (p, c) => { sent[p] = c; } }); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { await mongoose.connection.db!.dropDatabase(); await mongoose.syncIndexes(); });

const P = '+919876543210';
async function login(phone = P) {
  await request(app).post('/api/v1/auth/otp/request').send({ phone }).expect(200);
  return (await request(app).post('/api/v1/auth/otp/verify').send({ phone, code: sent[phone] }).expect(200)).body;
}
import sharp from 'sharp';
let png: Buffer;
beforeAll(async () => { png = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#f00' } }).png().toBuffer(); });
async function photoKey(token: string) {
  return (await request(app).post('/api/v1/media/photos').set('Authorization', `Bearer ${token}`).attach('file', png, 'a.png').expect(201)).body.key as string;
}
const profileFor = async (token: string) => ({ fullName: 'Riya', gender: 'female', interestedIn: 'male', dob: '1998-05-01', photos: [await photoKey(token)] });

describe('OTP', () => {
  it('rejects bad phone', () => request(app).post('/api/v1/auth/otp/request').send({ phone: '98765' }).expect(400));
  it('logs in with correct OTP, single use', async () => {
    const b = await login(); expect(b.accessToken).toBeTruthy();
    await request(app).post('/api/v1/auth/otp/verify').send({ phone: P, code: sent[P] }).expect(400);
  });
  it('enforces resend cooldown', async () => {
    await request(app).post('/api/v1/auth/otp/request').send({ phone: P }).expect(200);
    const r = await request(app).post('/api/v1/auth/otp/request').send({ phone: P }).expect(429);
    expect(r.body.error.code).toBe('OTP_RATE_LIMITED');
  });
  it('new OTP invalidates old one', async () => {
    await request(app).post('/api/v1/auth/otp/request').send({ phone: P }); const old = sent[P];
    await Otp.updateOne({ phone: P }, { lastSentAt: new Date(Date.now() - 60_000) });
    await request(app).post('/api/v1/auth/otp/request').send({ phone: P }).expect(200);
    if (old !== sent[P]) await request(app).post('/api/v1/auth/otp/verify').send({ phone: P, code: old }).expect(400);
  });
  it('expired OTP fails', async () => {
    await request(app).post('/api/v1/auth/otp/request').send({ phone: P });
    await Otp.updateOne({ phone: P }, { expiresAt: new Date(Date.now() - 1000) });
    const r = await request(app).post('/api/v1/auth/otp/verify').send({ phone: P, code: sent[P] }).expect(400);
    expect(r.body.error.code).toBe('OTP_EXPIRED');
  });
  it('locks after 5 wrong attempts', async () => {
    await request(app).post('/api/v1/auth/otp/request').send({ phone: P });
    const wrong = sent[P] === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) await request(app).post('/api/v1/auth/otp/verify').send({ phone: P, code: wrong }).expect(400);
    const r = await request(app).post('/api/v1/auth/otp/verify').send({ phone: P, code: wrong }).expect(429);
    expect(r.body.error.code).toBe('OTP_LOCKED');
    await request(app).post('/api/v1/auth/otp/verify').send({ phone: P, code: sent[P] }).expect(429);
  });
  it('provider failure creates nothing', async () => {
    setOtpSender({ send: async () => { throw new AppError(503, 'PROVIDER_UNAVAILABLE'); } });
    await request(app).post('/api/v1/auth/otp/request').send({ phone: P }).expect(503);
    expect(await Otp.countDocuments()).toBe(0); expect(await User.countDocuments()).toBe(0);
    setOtpSender({ send: async (p, c) => { sent[p] = c; } });
  });
});

describe('Google', () => {
  it('links to existing account by email instead of duplicating', async () => {
    const b = await login(); await User.updateOne({ _id: b.user.id }, { email: 'riya@example.com' });
    setGoogleVerifier(async () => ({ sub: 'g-1', email: 'riya@example.com' }));
    const r = await request(app).post('/api/v1/auth/google').send({ idToken: 'x'.repeat(20) }).expect(200);
    expect(r.body.user.id).toBe(b.user.id); expect(await User.countDocuments()).toBe(1);
  });
  it('rejects invalid token', async () => {
    setGoogleVerifier(async () => { throw new AppError(401, 'GOOGLE_TOKEN_INVALID'); });
    await request(app).post('/api/v1/auth/google').send({ idToken: 'x'.repeat(20) }).expect(401);
  });
});

describe('Sessions', () => {
  it('401 without/with tampered token', async () => {
    await request(app).get('/api/v1/profile/me').expect(401);
    await request(app).get('/api/v1/profile/me').set('Authorization', 'Bearer abc.def.ghi').expect(401);
  });
  it('rotates refresh and detects reuse', async () => {
    const b = await login();
    const r1 = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: b.refreshToken }).expect(200);
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: b.refreshToken }).expect(401);
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401); // family revoked
  });
  it('logout revokes refresh', async () => {
    const b = await login();
    await request(app).post('/api/v1/auth/logout').send({ refreshToken: b.refreshToken }).expect(204);
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: b.refreshToken }).expect(401);
  });
});

describe('Profile', () => {
  it('validates 18+', async () => {
    const b = await login();
    await request(app).put('/api/v1/profile/me').set('Authorization', `Bearer ${b.accessToken}`).send({ ...(await profileFor(b.accessToken)), dob: '2015-01-01' }).expect(400);
  });
  it('completes once, then PATCH edits', async () => {
    const b = await login(); const h = { Authorization: `Bearer ${b.accessToken}` }; const profile = await profileFor(b.accessToken);
    const r0 = await request(app).put('/api/v1/profile/me').set(h).send(profile).expect(200);
    await request(app).get(new URL(r0.body.profile.photos[0].url).pathname + new URL(r0.body.profile.photos[0].url).search).expect(200);
    await request(app).put('/api/v1/profile/me').set(h).send(profile).expect(409);
    const r = await request(app).patch('/api/v1/profile/me').set(h).send({ bio: 'hi' }).expect(200);
    expect(r.body.profile.bio).toBe('hi');
    await request(app).patch('/api/v1/profile/me').set(h).send({ gender: 'male' }).expect(400);
  });
  it('rejects unknown fields (no role escalation)', async () => {
    const b = await login();
    await request(app).put('/api/v1/profile/me').set('Authorization', `Bearer ${b.accessToken}`).send({ ...(await profileFor(b.accessToken)), role: 'admin' }).expect(400);
  });
});

describe('Admin', () => {
  it('403 for normal user, works for admin', async () => {
    const u = await login(); await request(app).get('/api/v1/admin/users').set('Authorization', `Bearer ${u.accessToken}`).expect(403);
    const a = await login('+919000000001'); await User.updateOne({ _id: a.user.id }, { role: 'admin' });
    const h = { Authorization: `Bearer ${a.accessToken}` };
    await request(app).put('/api/v1/profile/me').set('Authorization', `Bearer ${u.accessToken}`).send(await profileFor(u.accessToken)).expect(200);
    const sk = (await request(app).post('/api/v1/media/selfie').set('Authorization', `Bearer ${u.accessToken}`).attach('file', png, 's.png').expect(201)).body.key;
    await request(app).post('/api/v1/profile/me/verification').set('Authorization', `Bearer ${u.accessToken}`).send({ selfieKey: sk }).expect(202);
    const other = await login('+919000000002');
    await request(app).get(`/api/v1/media/${sk}`).set('Authorization', `Bearer ${other.accessToken}`).expect(403); // unsigned never works
    const own = (await request(app).get('/api/v1/media/selfies/me').set('Authorization', `Bearer ${u.accessToken}`).expect(200)).body.url;
    await request(app).get(new URL(own).pathname + new URL(own).search).expect(200);
    const list = await request(app).get('/api/v1/admin/users?verification=pending').set(h).expect(200);
    expect(list.body.total).toBe(1);
    const su = new URL(list.body.items[0].selfieUrl); await request(app).get(su.pathname + su.search).expect(200);
    await request(app).post(`/api/v1/admin/users/${u.user.id}/verification`).set(h).send({ decision: 'approved' }).expect(200);
    await request(app).post(`/api/v1/admin/users/${u.user.id}/status`).set(h).send({ status: 'blocked' }).expect(200);
    await request(app).get('/api/v1/profile/me').set('Authorization', `Bearer ${u.accessToken}`).expect(403);
  });
});

describe('Media', () => {
  it('rejects non-images disguised as images', async () => {
    const b = await login();
    await request(app).post('/api/v1/media/photos').set('Authorization', `Bearer ${b.accessToken}`).attach('file', Buffer.from('<?php echo 1; ?>'), 'x.jpg').expect(415);
  });
  it('rejects unsigned / tampered photo URL and path traversal', async () => {
    const b = await login(); const k = await photoKey(b.accessToken);
    await request(app).get(`/api/v1/media/${k}`).expect(403);
    await request(app).get(`/api/v1/media/${k}?exp=9999999999&sig=abc`).expect(403);
    await request(app).get('/api/v1/media/photos/..%2F..%2Fetc/passwd').expect(403);
  });
  it('cannot attach another user\'s photo', async () => {
    const a = await login(); const b = await login('+919000000003');
    const k = await photoKey(b.accessToken);
    await request(app).put('/api/v1/profile/me').set('Authorization', `Bearer ${a.accessToken}`).send({ ...(await profileFor(a.accessToken)), photos: [k] }).expect(403);
  });
  it('strips EXIF', async () => {
    const b = await login();
    const withExif = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#0f0' } }).jpeg().withMetadata({ exif: { IFD0: { Copyright: 'secret' } } }).toBuffer();
    const k = (await request(app).post('/api/v1/media/photos').set('Authorization', `Bearer ${b.accessToken}`).attach('file', withExif, 'e.jpg').expect(201)).body.key;
    const { storage } = require('../src/integrations/storage');
    expect((await sharp(storage.absolutePath(k)).metadata()).exif).toBeUndefined();
  });
});
