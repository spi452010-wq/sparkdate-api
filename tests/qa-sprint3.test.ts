process.env.AUTH_IP_LIMIT_PER_15MIN = '1000'; process.env.ADMIN_LOGIN_IP_LIMIT_PER_15MIN = '1000';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(40); process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
process.env.NODE_ENV = 'test'; process.env.MEDIA_URL_SECRET = 'm'.repeat(40); process.env.MONGO_URI = 'mongodb://placeholder';
import http from 'http';
import { AddressInfo } from 'net';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { io as ioClient, Socket } from 'socket.io-client';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app';
import { attachLive } from '../src/modules/live/live.gateway';
import { pairKey } from '../src/modules/blocks/blocks.service';
import { User } from '../src/modules/users/user.model';
import { issueTokens } from '../src/modules/auth/tokens';
import { Event } from '../src/modules/events/event.model';
import { Booking } from '../src/modules/bookings/booking.model';
import { LiveDate } from '../src/modules/live/date.model';
import { Connection } from '../src/modules/connections/connection.model';
import { Block } from '../src/modules/blocks/block.model';
import { setLiveKit, LiveKitTokenClient } from '../src/integrations/livekit';
import { FakeLiveKit } from '../src/integrations/livekit/fake';
import { setLiveStore } from '../src/integrations/livestore';
import { MemoryLiveStore } from '../src/integrations/livestore/fake';
import { getQueue, MemoryQueue, jobId } from '../src/jobs/queue';

const q = () => getQueue() as MemoryQueue;
const app = createApp();
let mongo: MongoMemoryServer; let server: http.Server; let live: ReturnType<typeof attachLive>; let url: string;
let lk: FakeLiveKit; let store: MemoryLiveStore; const sockets: Socket[] = [];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  server = http.createServer(app); live = attachLive(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/live`;
});
afterAll(async () => { await live.close(); await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase(); await mongoose.syncIndexes();
  lk = new FakeLiveKit(); setLiveKit(lk); store = new MemoryLiveStore(); setLiveStore(store); await q().close();
});
afterEach(async () => { for (const s of sockets.splice(0)) s.disconnect(); await sleep(30); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 3000) {
  const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timeout waiting for condition'); await sleep(10); }
}
let n = 0;
async function mkUser(gender: 'male' | 'female', profile: any = {}, extra: any = {}) {
  const u = await User.create({ phone: `+9191000${String(++n).padStart(5, '0')}`, profileCompleted: true, verification: { status: 'approved' },
    profile: { fullName: `${gender[0]}${n}`, gender, interestedIn: gender === 'male' ? 'female' : 'male', dob: new Date('1995-01-01'), city: 'Pune', interests: [], ...profile }, ...extra });
  return { id: String(u._id), gender, token: (await issueTokens(String(u._id), 'user')).accessToken };
}
async function mkEvent(o: any = {}) {
  const e = await Event.create({ title: 'Live', startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 2 * 3600_000), roundMinutes: 1,
    status: 'live', capacity: { male: 50, female: 50 }, createdBy: new mongoose.Types.ObjectId(), ...o });
  return String(e._id);
}
const book = (eventId: string, u: { id: string; gender: string }, o: any = {}) => Booking.create({ eventId, userId: u.id, gender: u.gender, status: 'confirmed', ...o });

type Client = Socket & { got: { ev: string; data: any }[] };
async function connect(token?: string): Promise<Client> {
  const s = ioClient(url, { auth: token ? { token } : {}, transports: ['websocket'], forceNew: true, reconnection: false }) as Client;
  s.got = []; s.onAny((ev, data) => s.got.push({ ev, data })); sockets.push(s);
  await new Promise<void>((res, rej) => { s.once('connect', () => res()); s.once('connect_error', (e) => rej(e)); });
  return s;
}
const connectError = (token?: string) => connect(token).then(() => 'connected', (e: any) => e.message as string);
const emit = (s: Socket, ev: string, p: any = {}) => s.timeout(3000).emitWithAck(ev, p);
const got = (s: Client, ev: string) => s.got.filter((g) => g.ev === ev).map((g) => g.data);
async function joined(eventId: string, ...users: { id: string; gender: string; token: string }[]) {
  const out: Client[] = [];
  for (const u of users) { await book(eventId, u); const s = await connect(u.token); expect(await emit(s, 'event:join', { eventId })).toMatchObject({ ok: true }); out.push(s); }
  return out;
}
async function tick(eventId: string, round: number) {
  await q().add('round.tick', { eventId, round }, { jobId: jobId('tick', eventId, round) });
  await q().runDue(Date.now() + 31_000, 'round.tick');
}
const endRound = () => q().runDue(Date.now() + 61_000, 'round.end');
const decideRound = () => q().runDue(Date.now() + 200_000, 'round.decide');


const pairsOf = (ds: any[]) => ds.map((d) => pairKey(String(d.userA), String(d.userB)));

describe('QA S3-1: no rematch of the same pair across rounds (e2e)', () => {
  it('3x3 over 3 rounds -> 9 distinct pairs, round 4 everyone no:match', async () => {
    const e = await mkEvent();
    const ms = [await mkUser('male'), await mkUser('male'), await mkUser('male')];
    const fs = [await mkUser('female'), await mkUser('female'), await mkUser('female')];
    const socks = await joined(e, ...ms, ...fs);
    for (let r = 1; r <= 3; r++) {
      await tick(e, r);
      await until(() => socks.every((s) => got(s, 'match:found').length === r));
      await endRound();
    }
    const dates = await LiveDate.find({ eventId: e });
    expect(dates).toHaveLength(9); expect(new Set(pairsOf(dates)).size).toBe(9);
    await tick(e, 4);
    await until(() => socks.every((s) => got(s, 'no:match').length === 1));
    expect(await LiveDate.countDocuments({ eventId: e, round: 4 })).toBe(0);
  });
  it('no rematch after both users reconnect with new sockets, nor after a live-store (Redis) reset', async () => {
    const e = await mkEvent(); const [m, f] = [await mkUser('male'), await mkUser('female')];
    const [sm, sf] = await joined(e, m, f);
    await tick(e, 1); await until(() => got(sm, 'match:found').length === 1); await endRound();
    sm.disconnect(); sf.disconnect(); await sleep(50);
    store = new MemoryLiveStore(); setLiveStore(store); // simulate Redis restart: met set lost
    const s2 = await connect(m.token); const s3 = await connect(f.token);
    expect(await emit(s2, 'event:join', { eventId: e })).toMatchObject({ ok: true });
    expect(await emit(s3, 'event:join', { eventId: e })).toMatchObject({ ok: true });
    await tick(e, 2);
    await until(() => got(s2, 'no:match').length === 1 && got(s3, 'no:match').length === 1);
    expect(got(s2, 'match:found')).toHaveLength(0);
    expect(await LiveDate.countDocuments({ eventId: e })).toBe(1);
  });
});

describe('QA S3-2: blocked users never matched (e2e)', () => {
  it('block in either direction, including a block created mid-event, prevents pairing', async () => {
    const e = await mkEvent();
    const [m1, m2, f1, f2] = [await mkUser('male'), await mkUser('male'), await mkUser('female'), await mkUser('female')];
    await Block.create({ blockerId: m1.id, blockedId: f1.id }); // male blocks female
    const [s1, s2, s3, s4] = await joined(e, m1, m2, f1, f2);
    await tick(e, 1); await until(() => [s1, s2, s3, s4].every((s) => got(s, 'match:found').length === 1));
    expect(got(s1, 'match:found')[0].partner.id).toBe(f2.id);
    expect(got(s2, 'match:found')[0].partner.id).toBe(f1.id);
    await Block.create({ blockerId: f1.id, blockedId: m2.id }); // mid-event, already met anyway
    await endRound();
    // round 2: m1-f1 blocked, m2-f2 the only legal new pair
    await tick(e, 2);
    await until(() => got(s2, 'match:found').length === 2 && got(s1, 'no:match').length === 1 && got(s3, 'no:match').length === 1);
    expect(got(s2, 'match:found')[1].partner.id).toBe(f2.id);
    expect(await LiveDate.countDocuments({ pairKey: pairKey(m1.id, f1.id) })).toBe(0);
  });
  it('block created after join (before tick) is honoured', async () => {
    const e = await mkEvent(); const [m, f] = [await mkUser('male'), await mkUser('female')];
    const [sm, sf] = await joined(e, m, f);
    await Block.create({ blockerId: f.id, blockedId: m.id });
    await tick(e, 1);
    await until(() => got(sm, 'no:match').length === 1 && got(sf, 'no:match').length === 1);
    expect(await LiveDate.countDocuments({ eventId: e })).toBe(0);
  });
});

describe('QA S3-3: 20 s reconnect grace expiry', () => {
  it('grace runs only after ~20 s; partner:left(disconnect) sent exactly once even if the job is re-run', async () => {
    const e = await mkEvent(); const [m, f] = [await mkUser('male'), await mkUser('female')];
    const [sm, sf] = await joined(e, m, f); await tick(e, 1);
    await until(() => got(sf, 'match:found').length === 1);
    const dateId = got(sf, 'match:found')[0].dateId;
    sm.disconnect();
    await until(() => q().find('live.grace').length === 1);
    const runAt = q().find('live.grace')[0].runAt;
    expect(runAt - Date.now()).toBeGreaterThan(19_000); expect(runAt - Date.now()).toBeLessThanOrEqual(20_500);
    await q().runDue(Date.now() + 19_000, 'live.grace'); await sleep(50);
    expect(got(sf, 'partner:left')).toHaveLength(0);
    await q().runDue(Date.now() + 21_000, 'live.grace');
    await until(() => got(sf, 'partner:left').length === 1);
    expect(got(sf, 'partner:left')[0]).toEqual({ dateId, reason: 'disconnect' });
    await q().add('live.grace', q().find('live.grace')[0]?.data ?? { eventId: e, userId: m.id }, { jobId: 'dup-grace' } as any);
    await q().runDue(Date.now() + 60_000, 'live.grace'); await sleep(80);
    expect(got(sf, 'partner:left')).toHaveLength(1);
  });
  it('grace expiry for a user not in a date notifies nobody and removes them from presence', async () => {
    const e = await mkEvent(); const [m, m2] = [await mkUser('male'), await mkUser('male')];
    const [sm, sm2] = await joined(e, m, m2);
    sm.disconnect();
    await until(() => q().find('live.grace').length === 1);
    await q().runDue(Date.now() + 21_000, 'live.grace'); await sleep(80);
    expect(got(sm2, 'partner:left')).toHaveLength(0);
    expect((await store.present(e, 0)).map((p) => p.userId)).toEqual([m2.id]);
  });
});

describe('QA S3-4: simultaneous date:decision', () => {
  async function ended() {
    const e = await mkEvent(); const [m, f] = [await mkUser('male'), await mkUser('female')];
    const [sm, sf] = await joined(e, m, f); await tick(e, 1);
    await until(() => got(sm, 'match:found').length === 1);
    const dateId = got(sm, 'match:found')[0].dateId as string;
    await endRound(); await until(() => got(sm, 'round:ended').length === 1 && got(sf, 'round:ended').length === 1);
    return { sm, sf, dateId };
  }
  it('like+like burst (5 emits per side, concurrent) -> one Connection, one connection:mutual per side', async () => {
    const { sm, sf, dateId } = await ended();
    const acks = await Promise.all([...Array(5)].flatMap(() => [emit(sm, 'date:decision', { dateId, decision: 'like' }), emit(sf, 'date:decision', { dateId, decision: 'like' })]));
    expect(acks.filter((a: any) => a.ok)).toHaveLength(2);
    expect(acks.filter((a: any) => !a.ok).every((a: any) => a.error === 'ALREADY_DECIDED')).toBe(true);
    await until(() => got(sm, 'connection:mutual').length >= 1 && got(sf, 'connection:mutual').length >= 1);
    await decideRound(); await sleep(100);
    expect(await Connection.countDocuments()).toBe(1);
    expect(got(sm, 'connection:mutual')).toHaveLength(1); expect(got(sf, 'connection:mutual')).toHaveLength(1);
    expect(got(sm, 'connection:mutual')[0].connectionId).toBe(got(sf, 'connection:mutual')[0].connectionId);
  });
  it('like+pass simultaneously -> no connection, no mutual', async () => {
    const { sm, sf, dateId } = await ended();
    expect(await Promise.all([emit(sm, 'date:decision', { dateId, decision: 'like' }), emit(sf, 'date:decision', { dateId, decision: 'pass' })])).toEqual([{ ok: true }, { ok: true }]);
    await decideRound(); await sleep(100);
    expect(await Connection.countDocuments()).toBe(0);
    expect(got(sm, 'connection:mutual')).toHaveLength(0); expect(got(sf, 'connection:mutual')).toHaveLength(0);
  });
});

describe('QA S3-5: LiveKit token scoped to its own room (real signer, e2e)', () => {
  it('each user token from match:found grants only that date room; identity = user; no admin grants', async () => {
    const secret = 'k'.repeat(40); setLiveKit(new LiveKitTokenClient('wss://lk.test', 'APIqa', secret));
    const e = await mkEvent();
    const users = [await mkUser('male'), await mkUser('male'), await mkUser('female'), await mkUser('female')];
    const socks = await joined(e, ...users);
    await tick(e, 1); await until(() => socks.every((s) => got(s, 'match:found').length === 1));
    const rooms = new Set<string>();
    socks.forEach((s, i) => {
      const mf = got(s, 'match:found')[0];
      const p: any = jwt.verify(mf.livekit.token, secret, { algorithms: ['HS256'] });
      expect(p.sub).toBe(users[i].id);
      expect(p.video.room).toBe(mf.livekit.room); expect(mf.livekit.room).toBe(`evt_${e}_r1_${mf.dateId}`);
      expect(p.video.roomJoin).toBe(true);
      for (const k of ['roomAdmin', 'roomCreate', 'roomList', 'roomRecord']) expect(p.video[k]).toBeFalsy();
      expect(p.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(121);
      rooms.add(p.video.room);
    });
    expect(rooms.size).toBe(2); // two dates, two distinct rooms; partners share one
    const [a, b] = [got(socks[0], 'match:found')[0], got(socks[1], 'match:found')[0]];
    const pa: any = jwt.decode(a.livekit.token); expect(pa.video.room).not.toBe(b.livekit.room);
  });
});

describe('QA S3-6 [LOAD]: 300 sockets in one event', () => {
  jest.setTimeout(90_000);
  it('150M+150F join, tick -> 150 dates, every socket gets exactly one match:found, no errors', async () => {
    const t0 = Date.now();
    const e = await mkEvent({ capacity: { male: 200, female: 200 } });
    const us = await Promise.all(Array.from({ length: 300 }, (_, i) => mkUser(i % 2 ? 'female' : 'male', { interests: [`t${i % 7}`] })));
    await Booking.insertMany(us.map((u) => ({ eventId: e, userId: u.id, gender: u.gender, status: 'confirmed' })));
    const socks = await Promise.all(us.map((u) => connect(u.token)));
    const tConn = Date.now();
    const acks = await Promise.all(socks.map((s) => s.timeout(15000).emitWithAck('event:join', { eventId: e })));
    expect(acks.filter((a: any) => !a.ok)).toEqual([]);
    const tJoin = Date.now();
    await tick(e, 1);
    await until(() => socks.every((s) => got(s, 'match:found').length === 1), 30_000);
    const tMatch = Date.now();
    const dates = await LiveDate.find({ eventId: e, round: 1 });
    expect(dates).toHaveLength(150);
    const ids = dates.flatMap((d) => [String(d.userA), String(d.userB)]); expect(new Set(ids).size).toBe(300);
    expect(socks.some((s) => s.got.some((g) => g.ev === 'error' || g.ev === 'no:match'))).toBe(false);
    // eslint-disable-next-line no-console
    console.log(`[LOAD] setup+connect ${tConn - t0}ms, 300 joins ${tJoin - tConn}ms, tick->all matched ${tMatch - tJoin}ms, total ${tMatch - t0}ms`);
    expect(tMatch - t0).toBeLessThan(60_000);
  });
});
