process.env.AUTH_IP_LIMIT_PER_15MIN = '1000'; process.env.ADMIN_LOGIN_IP_LIMIT_PER_15MIN = '1000';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(40); process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
process.env.NODE_ENV = 'test'; process.env.MEDIA_URL_SECRET = 'm'.repeat(40); process.env.MONGO_URI = 'mongodb://placeholder';
import http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { io as ioClient, Socket } from 'socket.io-client';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app';
import { attachLive } from '../src/modules/live/live.gateway';
import { matchRound, score } from '../src/modules/live/live.matching';
import { Candidate } from '../src/modules/live/live.types';
import { pairKey } from '../src/modules/blocks/blocks.service';
import { User } from '../src/modules/users/user.model';
import { issueTokens } from '../src/modules/auth/tokens';
import { Event } from '../src/modules/events/event.model';
import { Booking } from '../src/modules/bookings/booking.model';
import { Notification } from '../src/modules/notifications/notification.model';
import { LiveDate } from '../src/modules/live/date.model';
import { Connection } from '../src/modules/connections/connection.model';
import { Block } from '../src/modules/blocks/block.model';
import { setLiveKit, LiveKitTokenClient } from '../src/integrations/livekit';
import { FakeLiveKit } from '../src/integrations/livekit/fake';
import { setLiveStore } from '../src/integrations/livestore';
import { MemoryLiveStore } from '../src/integrations/livestore/fake';
import { getQueue, MemoryQueue, jobId } from '../src/jobs/queue';
import { findMissingLiveConfig } from '../src/config/env';

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

describe('matching (pure)', () => {
  const c = (id: string, gender: 'male' | 'female', interests: string[] = [], city = 'Pune', o: Partial<Candidate> = {}): Candidate => ({ id, gender, interests, city, ...o });
  const empty = () => ({ met: new Set<string>(), blocked: new Set<string>(), priority: new Set<string>() });

  it('scores shared interests + interestedCity (or city) + profession', () => {
    expect(score(c('a', 'male', ['Music', 'travel']), c('b', 'female', ['music', 'Travel', 'art']))).toBe(3);
    expect(score(c('a', 'male', [], 'Pune', { interestedCity: 'Mumbai' }), c('b', 'female', [], 'Mumbai'))).toBe(1);
    expect(score(c('a', 'male', [], 'Pune', { profession: 'Engineer' }), c('b', 'female', [], 'Delhi', { profession: 'engineer' }))).toBe(1);
  });
  it('pairs best-first and never repeats a pair across rounds (5x5 -> 5 rounds, then nothing)', () => {
    const users = [...[0, 1, 2, 3, 4].map((i) => c(`m${i}`, 'male', [`i${i}`])), ...[0, 1, 2, 3, 4].map((i) => c(`f${i}`, 'female', [`i${i}`]))];
    const met = new Set<string>(); const seen: string[] = [];
    for (let r = 0; r < 5; r++) {
      const res = matchRound({ ...empty(), users, met });
      expect(res.pairs).toHaveLength(5); expect(res.unmatched).toEqual([]);
      if (r === 0) expect(res.pairs.map((p) => p.join('-')).sort()).toEqual(['m0-f0', 'm1-f1', 'm2-f2', 'm3-f3', 'm4-f4']);
      for (const [a, b] of res.pairs) { const k = pairKey(a, b); expect(met.has(k)).toBe(false); met.add(k); seen.push(k); }
    }
    expect(new Set(seen).size).toBe(25);
    expect(matchRound({ ...empty(), users, met })).toEqual({ pairs: [], unmatched: users.map((u) => u.id) });
  });
  it('excludes blocked pairs (either direction) and same-gender pairs', () => {
    const users = [c('m1', 'male'), c('f1', 'female'), c('m2', 'male')];
    const res = matchRound({ ...empty(), users, blocked: new Set([pairKey('f1', 'm1')]) });
    expect(res.pairs).toEqual([['m2', 'f1']]); expect(res.unmatched).toEqual(['m1']);
  });
  it('odd counts: leftover users unmatched; priority users are paired first next round', () => {
    const users = [c('m1', 'male', ['x']), c('m2', 'male'), c('m3', 'male'), c('f1', 'female', ['x']), c('f2', 'female')];
    const r1 = matchRound({ ...empty(), users });
    expect(r1.pairs).toHaveLength(2); expect(r1.unmatched).toHaveLength(1);
    const r2 = matchRound({ ...empty(), users, met: new Set(r1.pairs.map(([a, b]) => pairKey(a, b))), priority: new Set(r1.unmatched) });
    expect(r2.pairs.flat()).toContain(r1.unmatched[0]);
  });
  it('ignores duplicate users and pairs 150x150 fast', () => {
    const users = Array.from({ length: 300 }, (_, i) => c(`u${String(i).padStart(3, '0')}`, i % 2 ? 'female' : 'male', [`t${i % 7}`, `t${i % 5}`]));
    const t = Date.now(); const r = matchRound({ ...empty(), users: [...users, users[0]] });
    expect(Date.now() - t).toBeLessThan(1000); expect(r.pairs).toHaveLength(150); expect(new Set(r.pairs.flat()).size).toBe(300);
  });
});

describe('socket auth and authz', () => {
  it('rejects missing, invalid and blocked-account tokens at the handshake', async () => {
    expect(await connectError()).toBe('UNAUTHORIZED');
    expect(await connectError('nope')).toBe('TOKEN_INVALID');
    expect(await connectError(jwt.sign({ sub: new mongoose.Types.ObjectId().toString() }, 'x'.repeat(40)))).toBe('TOKEN_INVALID');
    const blocked = await mkUser('male', {}, { status: 'blocked' });
    expect(await connectError(blocked.token)).toBe('ACCOUNT_BLOCKED');
  });
  it('event:join needs a confirmed booking; sets attendedAt once; validates payloads', async () => {
    const e = await mkEvent(); const u = await mkUser('male'); const s = await connect(u.token);
    expect(await emit(s, 'event:join', { eventId: e })).toEqual({ ok: false, error: 'NOT_BOOKED' });
    await book(e, u, { status: 'pending' });
    expect(await emit(s, 'event:join', { eventId: e })).toEqual({ ok: false, error: 'NOT_BOOKED' });
    expect(await emit(s, 'event:join', { eventId: 'x' })).toEqual({ ok: false, error: 'VALIDATION_ERROR' });
    expect(await emit(s, 'event:join', { eventId: e, extra: 1 })).toEqual({ ok: false, error: 'VALIDATION_ERROR' });
    await Booking.updateOne({ eventId: e, userId: u.id }, { status: 'confirmed' });
    const r = await emit(s, 'event:join', { eventId: e });
    expect(r).toMatchObject({ ok: true, lobby: { eventId: e, waiting: 1 } }); expect(typeof r.serverTime).toBe('number');
    const first = (await Booking.findOne({ eventId: e, userId: u.id }))!.attendedAt!;
    expect(first).toBeInstanceOf(Date);
    await sleep(5); await emit(s, 'event:join', { eventId: e });
    expect(+(await Booking.findOne({ eventId: e, userId: u.id }))!.attendedAt!).toBe(+first);
    // Not a member of another event's room: leave without join is refused.
    expect(await emit(s, 'event:leave', { eventId: await mkEvent() })).toEqual({ ok: false, error: 'NOT_JOINED' });
  });
  it('lobby not open before startsAt-15m; ended events refused', async () => {
    const u = await mkUser('male'); const s = await connect(u.token);
    const early = await mkEvent({ status: 'published', startsAt: new Date(Date.now() + 3600_000), endsAt: new Date(Date.now() + 7200_000) }); await book(early, u);
    expect(await emit(s, 'event:join', { eventId: early })).toEqual({ ok: false, error: 'LOBBY_NOT_OPEN' });
    const soon = await mkEvent({ status: 'published', startsAt: new Date(Date.now() + 10 * 60_000) }); await book(soon, u);
    expect(await emit(s, 'event:join', { eventId: soon })).toMatchObject({ ok: true });
    const ended = await mkEvent({ status: 'ended' }); await book(ended, u);
    expect(await emit(s, 'event:join', { eventId: ended })).toEqual({ ok: false, error: 'EVENT_ENDED' });
  });
  it('GET /api/v1/live/time returns server time', async () => {
    const r = await request(app).get('/api/v1/live/time').expect(200);
    expect(Math.abs(r.body.serverTime - Date.now())).toBeLessThan(5000); expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('rounds', () => {
  it('match:found carries partner card, LiveKit room/token and server times; no re-pairing across rounds', async () => {
    const e = await mkEvent();
    const [m1, m2, f1, f2] = [await mkUser('male', { interests: ['music'] }), await mkUser('male'), await mkUser('female', { interests: ['music'] }), await mkUser('female')];
    const [sm1, sm2, sf1, sf2] = await joined(e, m1, m2, f1, f2);
    await tick(e, 1);
    await until(() => [sm1, sm2, sf1, sf2].every((s) => got(s, 'match:found').length === 1));
    const mf = got(sm1, 'match:found')[0];
    expect(mf.partner).toEqual({ id: f1.id, fullName: expect.any(String), age: expect.any(Number), city: 'Pune', photoUrl: null, interests: ['music'] });
    expect(mf.partner.phone).toBeUndefined();
    expect(mf.livekit.room).toBe(`evt_${e}_r1_${mf.dateId}`); expect(mf.livekit.url).toBe('wss://livekit.test');
    expect(mf.livekit.token).toBe(`fake.${mf.livekit.room}.${m1.id}.${lk.minted.find((x) => x.identity === m1.id)!.ttlSec}`);
    expect(new Date(mf.endsAt).getTime() - new Date(mf.startsAt).getTime()).toBe(60_000);
    // token TTL = round end + 60 s
    expect(lk.minted[0].ttlSec).toBeGreaterThan(115); expect(lk.minted[0].ttlSec).toBeLessThanOrEqual(120);
    await until(() => got(sm1, 'round:started').length === 1);
    expect(got(sm1, 'round:started')[0]).toEqual({ dateId: mf.dateId, endsAt: mf.endsAt });

    await endRound();
    await until(() => got(sf2, 'round:ended').length === 1);
    expect(got(sf2, 'round:ended')[0].decisionDeadline).toBeDefined();
    expect(q().find('round.tick').map((j) => j.data.round)).toEqual([2]);
    expect((await Booking.findOne({ eventId: e, userId: m1.id }))!.datesCompleted).toBe(1);

    await tick(e, 2); await endRound(); await tick(e, 3);
    const dates = await LiveDate.find({ eventId: e });
    expect(dates).toHaveLength(4); expect(new Set(dates.map((d) => d.pairKey)).size).toBe(4);
    await until(() => [sm1, sm2, sf1, sf2].every((s) => got(s, 'no:match').length === 1));
    expect(got(sm1, 'no:match')[0]).toEqual({ round: 3 });
    await expect(LiveDate.create({ ...dates[0].toObject(), _id: undefined, round: 9 })).rejects.toMatchObject({ code: 11000 });
  });

  it('blocked users are never paired; odd counts sit out and get priority', async () => {
    const e = await mkEvent();
    const [m1, m2, m3, f1] = [await mkUser('male'), await mkUser('male'), await mkUser('male'), await mkUser('female')];
    await Block.create({ blockerId: f1.id, blockedId: m1.id });
    const [s1, s2, s3, sf] = await joined(e, m1, m2, m3, f1);
    await tick(e, 1);
    await until(() => got(sf, 'match:found').length === 1);
    const partner = got(sf, 'match:found')[0].partner.id; expect(partner).not.toBe(m1.id);
    const satOut = [m1, m2, m3].filter((m) => m.id !== partner);
    await until(() => [s1, s2, s3].filter((s) => got(s, 'no:match').length === 1).length === 2);
    expect((await store.priority(e)).sort()).toEqual(satOut.map((m) => m.id).sort());
    await endRound(); await tick(e, 2);
    await until(() => got(sf, 'match:found').length === 2);
    expect(got(sf, 'match:found')[1].partner.id).not.toBe(m1.id); // blocked even with priority
    expect(await LiveDate.countDocuments({ eventId: e, pairKey: pairKey(m1.id, f1.id) })).toBe(0);
  });

  it('LiveKit mint retries 2x, then both users get no:match and no date is created', async () => {
    const e = await mkEvent(); const [m, f] = [await mkUser('male'), await mkUser('female')];
    const [sm, sf] = await joined(e, m, f);
    lk.failures = 3; await tick(e, 1);
    await until(() => got(sm, 'no:match').length === 1 && got(sf, 'no:match').length === 1);
    expect(await LiveDate.countDocuments({ eventId: e })).toBe(0);
    await endRound(); lk.failures = 2; await tick(e, 2);
    await until(() => got(sm, 'match:found').length === 1);
  });

  it('simultaneous join/leave around a tick keeps invariants (one date per user per round, unique pairs)', async () => {
    const e = await mkEvent();
    const ms = await Promise.all([0, 1, 2, 3, 4].map(() => mkUser('male'))); const fs = await Promise.all([0, 1, 2, 3].map(() => mkUser('female')));
    const socks = await joined(e, ...ms.slice(0, 3), ...fs.slice(0, 2));
    for (const u of [...ms.slice(3), ...fs.slice(2)]) await book(e, u);
    const late = await Promise.all([...ms.slice(3), ...fs.slice(2)].map((u) => connect(u.token)));
    const acks = await Promise.all([
      tick(e, 1).then(() => ({ ok: true })),
      ...late.map((s) => emit(s, 'event:join', { eventId: e })),
      emit(socks[0], 'event:leave', { eventId: e }), emit(socks[3], 'event:leave', { eventId: e }),
    ]);
    expect(acks.every((a: any) => a.ok)).toBe(true);
    const dates = await LiveDate.find({ eventId: e, round: 1 });
    const users = dates.flatMap((d) => [String(d.userA), String(d.userB)]);
    expect(new Set(users).size).toBe(users.length);
    // Anyone who left is either not in a date or their date ended as early_disconnect.
    for (const d of dates) for (const left of [ms[0].id, fs[0].id])
      if ([String(d.userA), String(d.userB)].includes(left)) expect(['early_disconnect', undefined]).toContain(d.endReason);
    await emit(socks[0], 'event:leave', { eventId: e }).then((a) => expect(a).toEqual({ ok: false, error: 'NOT_JOINED' }));
    expect((await store.present(e, 0)).map((p) => p.userId)).not.toContain(ms[0].id);
  });

  it('event:leave mid-date ends it early: partner gets partner:left(left) and priority', async () => {
    const e = await mkEvent(); const [m, f] = [await mkUser('male'), await mkUser('female')];
    const [sm, sf] = await joined(e, m, f); await tick(e, 1);
    await until(() => got(sf, 'match:found').length === 1);
    expect(await emit(sm, 'event:leave', { eventId: e })).toEqual({ ok: true });
    await until(() => got(sf, 'partner:left').length === 1);
    expect(got(sf, 'partner:left')[0]).toEqual({ dateId: got(sf, 'match:found')[0].dateId, reason: 'left' });
    expect(await store.priority(e)).toEqual([f.id]);
    await endRound();
    expect((await Booking.findOne({ eventId: e, userId: f.id }))!.datesCompleted).toBe(0); // < 60 s of call
  });
});

describe('reconnect grace', () => {
  async function inDate() {
    const e = await mkEvent(); const [m, f] = [await mkUser('male'), await mkUser('female')];
    const [sm, sf] = await joined(e, m, f); await tick(e, 1);
    await until(() => got(sm, 'match:found').length === 1 && got(sf, 'match:found').length === 1);
    return { e, m, f, sm, sf, dateId: got(sm, 'match:found')[0].dateId as string };
  }
  it('grace expiry: partner gets partner:left(disconnect), date early_disconnect, partner re-queued with priority', async () => {
    const { e, m, f, sm, sf, dateId } = await inDate();
    sm.disconnect();
    await until(() => q().find('live.grace').length === 1);
    expect(q().find('live.grace')[0].runAt - Date.now()).toBeGreaterThan(19_000);
    await q().runDue(Date.now() + 5_000, 'live.grace'); // still in grace
    expect(got(sf, 'partner:left')).toEqual([]);
    await q().runDue(Date.now() + 21_000, 'live.grace');
    await until(() => got(sf, 'partner:left').length === 1);
    expect(got(sf, 'partner:left')[0]).toEqual({ dateId, reason: 'disconnect' });
    expect(await LiveDate.findById(dateId)).toMatchObject({ endReason: 'early_disconnect', leftReason: 'disconnect' });
    expect(await store.priority(e)).toEqual([f.id]);
    expect((await store.present(e, 0)).map((p) => p.userId)).toEqual([f.id]);
    void m;
  });
  it('reconnect within grace resends match:found with a fresh token; grace job is then a no-op', async () => {
    const { e, m, sf, dateId } = await inDate();
    sockets[0].disconnect();
    await until(() => q().find('live.grace').length === 1);
    const before = lk.minted.length;
    const s2 = await connect(m.token);
    expect(await emit(s2, 'event:join', { eventId: e })).toMatchObject({ ok: true });
    await until(() => got(s2, 'match:found').length === 1);
    expect(got(s2, 'match:found')[0]).toMatchObject({ dateId, livekit: { room: `evt_${e}_r1_${dateId}` } });
    expect(lk.minted.length).toBe(before + 1);
    await q().runDue(Date.now() + 21_000, 'live.grace');
    await sleep(50);
    expect(got(sf, 'partner:left')).toEqual([]);
    expect((await LiveDate.findById(dateId))!.endedAt).toBeUndefined();
  });
  it('a second open socket means no grace at all', async () => {
    const { m } = await inDate();
    await connect(m.token); sockets[0].disconnect(); await sleep(100);
    expect(q().find('live.grace')).toHaveLength(0);
  });
});

describe('decisions', () => {
  async function ended() {
    const e = await mkEvent(); const [m, f] = [await mkUser('male'), await mkUser('female')];
    const [sm, sf] = await joined(e, m, f); await tick(e, 1);
    await until(() => got(sm, 'match:found').length === 1);
    const dateId = got(sm, 'match:found')[0].dateId as string;
    await endRound(); await until(() => got(sm, 'round:ended').length === 1);
    return { e, m, f, sm, sf, dateId };
  }
  it('concurrent mutual likes create exactly one connection and one connection:mutual each', async () => {
    const { m, f, sm, sf, dateId } = await ended();
    const r = await Promise.all([emit(sm, 'date:decision', { dateId, decision: 'like' }), emit(sf, 'date:decision', { dateId, decision: 'save' })]);
    expect(r).toEqual([{ ok: true }, { ok: true }]);
    await until(() => got(sm, 'connection:mutual').length === 1 && got(sf, 'connection:mutual').length === 1);
    expect(await Connection.countDocuments()).toBe(1);
    const c = got(sm, 'connection:mutual')[0]; expect(c.partner.id).toBe(f.id);
    await decideRound(); await sleep(50);
    expect(await Connection.countDocuments()).toBe(1); expect(got(sm, 'connection:mutual')).toHaveLength(1);
    expect(await Notification.countDocuments({ type: 'connection_mutual' })).toBe(2);
    expect(await Notification.countDocuments({ type: 'liked_you' })).toBe(0);
    const list = await request(app).get('/api/v1/connections').set('Authorization', `Bearer ${m.token}`).expect(200);
    expect(list.body.items).toEqual([expect.objectContaining({ id: c.connectionId, partner: expect.objectContaining({ id: f.id }) })]);
  });
  it('createMutual is atomic under a direct race (unique index)', async () => {
    const { createMutual } = await import('../src/modules/connections/connections.service');
    const a = new mongoose.Types.ObjectId().toString(); const b = new mongoose.Types.ObjectId().toString(); const e = new mongoose.Types.ObjectId().toString();
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => createMutual(i % 2 ? a : b, i % 2 ? b : a, e, e)));
    expect(rs.filter((r) => r.created)).toHaveLength(1); expect(new Set(rs.map((r) => r.connectionId)).size).toBe(1);
  });
  it('once per user per date; after the deadline rejected; non-participants rejected', async () => {
    const { sm, sf, dateId } = await ended();
    expect(await emit(sm, 'date:decision', { dateId, decision: 'pass' })).toEqual({ ok: true });
    expect(await emit(sm, 'date:decision', { dateId, decision: 'like' })).toEqual({ ok: false, error: 'ALREADY_DECIDED' });
    expect(await emit(sm, 'date:decision', { dateId, decision: 'love' })).toEqual({ ok: false, error: 'VALIDATION_ERROR' });
    const x = await mkUser('female'); const sx = await connect(x.token);
    expect(await emit(sx, 'date:decision', { dateId, decision: 'like' })).toEqual({ ok: false, error: 'DATE_NOT_FOUND' });
    await LiveDate.updateOne({ _id: dateId }, { decisionDeadline: new Date(Date.now() - 1) });
    expect(await emit(sf, 'date:decision', { dateId, decision: 'like' })).toEqual({ ok: false, error: 'DECISION_CLOSED' });
    expect((await LiveDate.findById(dateId))!.decisionB).toBeUndefined();
  });
  it('one-sided like -> "They liked you" for the partner at round.decide', async () => {
    const { m, f, sm, dateId } = await ended();
    await emit(sm, 'date:decision', { dateId, decision: 'like' });
    await decideRound(); await decideRound();
    const ns = await Notification.find({ type: 'liked_you' });
    expect(ns).toHaveLength(1); expect(String(ns[0].userId)).toBe(f.id); expect(ns[0].title).toBe('They liked you');
    expect(await Connection.countDocuments()).toBe(0); void m;
  });
  it('date:spark is relayed to the partner, max 1 per 3 s', async () => {
    const e = await mkEvent(); const [m, f] = [await mkUser('male'), await mkUser('female')];
    const [sm, sf] = await joined(e, m, f); await tick(e, 1);
    await until(() => got(sm, 'match:found').length === 1);
    const dateId = got(sm, 'match:found')[0].dateId;
    expect(await emit(sm, 'date:spark', { dateId })).toEqual({ ok: true });
    expect(await emit(sm, 'date:spark', { dateId })).toEqual({ ok: false, error: 'RATE_LIMITED' });
    await until(() => got(sf, 'date:spark').length === 1);
    expect(got(sf, 'date:spark')[0]).toEqual({ dateId });
  });
  it('general per-socket rate limit', async () => {
    const u = await mkUser('male'); const s = await connect(u.token);
    const acks = await Promise.all(Array.from({ length: 35 }, () => emit(s, 'presence:ping', {})));
    expect(acks.filter((a: any) => a.error === 'RATE_LIMITED').length).toBe(5);
  });
});

describe('event end, attendance and refund eligibility (Sprint 2 wiring)', () => {
  it('event:ended carries datesCompleted; finalize: paid && attended && 0 dates -> refundEligible', async () => {
    const e = await mkEvent({ priceInPaise: 9900, playProductId: 'ticket_99' });
    const [m1, m2, f1] = [await mkUser('male'), await mkUser('male'), await mkUser('female')];
    const paid = { amountInPaise: 9900, paymentId: new mongoose.Types.ObjectId() };
    const absent = await mkUser('female'); await book(e, absent, paid);
    for (const u of [m1, m2, f1]) await book(e, u, paid);
    const socks: Client[] = [];
    for (const u of [m1, m2, f1]) { const s = await connect(u.token); await emit(s, 'event:join', { eventId: e }); socks.push(s); }
    await tick(e, 1); await endRound();
    const withDate = (await LiveDate.findOne({ eventId: e }))!; const dated = [String(withDate.userA), String(withDate.userB)];
    const loner = [m1, m2].find((m) => !dated.includes(m.id))!;
    await Event.updateOne({ _id: e }, { endsAt: new Date(Date.now() - 1000) });
    await q().add('event.end', { eventId: e, at: +(await Event.findById(e))!.endsAt! }, { jobId: 'end-now' });
    await q().runDue(Date.now(), 'event.end');
    expect((await Event.findById(e))!.status).toBe('ended');
    await until(() => socks.every((s) => got(s, 'event:ended').length === 1));
    const byUser = Object.fromEntries([m1, m2, f1].map((u, i) => [u.id, got(socks[i], 'event:ended')[0]]));
    expect(byUser[loner.id]).toEqual({ eventId: e, datesCompleted: 0 });
    expect(byUser[f1.id]).toEqual({ eventId: e, datesCompleted: 1 });
    await q().runDue(Date.now(), 'event.finalize');
    const b = async (u: { id: string }) => (await Booking.findOne({ eventId: e, userId: u.id }))!;
    expect((await b(loner)).refundEligible).toBe(true);
    expect((await b(f1)).refundEligible).toBe(false);
    expect((await b(absent)).refundEligible).toBe(false); // never attended
  });
  it('publishing an event schedules event.open/start/end; stale jobs are no-ops', async () => {
    const e = await mkEvent({ status: 'published', startsAt: new Date(Date.now() + 3600_000), endsAt: new Date(Date.now() + 7200_000) });
    const { scheduleTimeline } = await import('../src/modules/events/events.service');
    await scheduleTimeline((await Event.findById(e))!);
    expect(q().find('event.start')).toHaveLength(1); expect(q().find('event.open')).toHaveLength(1); expect(q().find('event.end')).toHaveLength(1);
    await Event.updateOne({ _id: e }, { startsAt: new Date(Date.now() + 2 * 3600_000), endsAt: new Date(Date.now() + 3 * 3600_000) });
    await q().runDue(Date.now() + 3601_000, 'event.start');
    expect((await Event.findById(e))!.status).toBe('published');
    await Event.updateOne({ _id: e }, { startsAt: new Date(Date.now() - 1000) });
    await q().add('event.start', { eventId: e, at: +(await Event.findById(e))!.startsAt }, { jobId: 'start-now' });
    await q().runDue(Date.now(), 'event.start');
    expect((await Event.findById(e))!.status).toBe('live');
    expect(q().find('round.tick').map((j) => j.data)).toEqual([{ eventId: e, round: 1 }]);
  });
});

describe('LiveKit token (real signer, no network)', () => {
  it('grants join to exactly one room, identity = userId, expiry = requested TTL', async () => {
    const secret = 's'.repeat(40);
    const c = new LiveKitTokenClient('wss://lk.test', 'APIkey123', secret);
    const t = await c.mintToken({ room: 'evt_e_r1_d', identity: 'user1', name: 'U', ttlSec: 120 });
    const p: any = jwt.verify(t, secret, { algorithms: ['HS256'] });
    expect(p.sub).toBe('user1'); expect(p.iss).toBe('APIkey123');
    expect(p.video).toMatchObject({ room: 'evt_e_r1_d', roomJoin: true, canPublish: true, canSubscribe: true });
    expect(p.video.roomAdmin).toBeFalsy(); expect(p.video.roomCreate).toBeFalsy(); expect(p.video.roomList).toBeFalsy(); expect(p.video.roomRecord).toBeFalsy();
    expect(Math.abs(p.exp - (Math.floor(Date.now() / 1000) + 120))).toBeLessThanOrEqual(2);
    expect(() => jwt.verify(t, 'x'.repeat(40))).toThrow();
  });
  it('production config requires LIVEKIT_* (wss, non-placeholder, strong secret)', () => {
    expect(findMissingLiveConfig({}).sort()).toEqual(['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_URL']);
    const ok = { LIVEKIT_URL: 'wss://sparkdate.livekit.cloud', LIVEKIT_API_KEY: 'APIa1b2c3', LIVEKIT_API_SECRET: 'Q'.repeat(43) };
    expect(findMissingLiveConfig(ok)).toEqual([]);
    expect(findMissingLiveConfig({ ...ok, LIVEKIT_URL: 'ws://x' })).toEqual(['LIVEKIT_URL']);
    expect(findMissingLiveConfig({ ...ok, LIVEKIT_API_SECRET: 'your-livekit-api-secret-min-32-chars' })).toEqual(['LIVEKIT_API_SECRET']);
    expect(findMissingLiveConfig({ ...ok, LIVEKIT_API_SECRET: 'short' })).toEqual(['LIVEKIT_API_SECRET']);
  });
});
