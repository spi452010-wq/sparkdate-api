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


describe('QA: OTP abuse', () => {
  it('hourly cap: 6th send in an hour is OTP_RATE_LIMITED', async () => {
    for (let i = 0; i < 5; i++) {
      await Otp.updateOne({ phone: P }, { lastSentAt: new Date(Date.now() - 60_000) });
      await request(app).post('/api/v1/auth/otp/request').send({ phone: P }).expect(200);
    }
    await Otp.updateOne({ phone: P }, { lastSentAt: new Date(Date.now() - 60_000) });
    const r = await request(app).post('/api/v1/auth/otp/request').send({ phone: P }).expect(429);
    expect(r.body.error.code).toBe('OTP_RATE_LIMITED');
  });
  it('concurrent verify with same OTP yields exactly one session', async () => {
    await request(app).post('/api/v1/auth/otp/request').send({ phone: P }).expect(200);
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => request(app).post('/api/v1/auth/otp/verify').send({ phone: P, code: sent[P] })));
    expect(rs.filter(r => r.status === 200).length).toBe(1);
    expect(await User.countDocuments({ phone: P })).toBe(1);
  });
});

describe('QA: profile & media', () => {
  it('concurrent complete-profile submits create one profile', async () => {
    const b = await login(); const h = { Authorization: `Bearer ${b.accessToken}` }; const p = await profileFor(b.accessToken);
    const rs = await Promise.all([1, 2, 3].map(() => request(app).put('/api/v1/profile/me').set(h).send(p)));
    expect(rs.filter(r => r.status === 200).length).toBe(1);
    expect(rs.filter(r => r.status !== 200).every(r => r.status === 409)).toBe(true);
  });
  it('rejects files over 8 MB with FILE_TOO_LARGE', async () => {
    const b = await login();
    const r = await request(app).post('/api/v1/media/photos').set('Authorization', `Bearer ${b.accessToken}`).attach('file', Buffer.alloc(8 * 1024 * 1024 + 10, 1), 'big.png').expect(413);
    expect(r.body.error.code).toBe('FILE_TOO_LARGE');
  });
});
