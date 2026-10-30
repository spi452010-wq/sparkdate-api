import crypto from 'crypto';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { getQueue, jobId } from '../../jobs/queue';
import { getLiveKit } from '../../integrations/livekit';
import { getLiveStore } from '../../integrations/livestore';
import { getLiveEvent, setLiveStatus, LOBBY_OPEN_MS, LiveEvent } from '../events/events.service';
import { findConfirmedBooking, markAttended, addDateCompleted, datesCompletedByUser } from '../bookings/bookings.service';
import { liveProfiles, LiveProfile } from '../users/users.service';
import { blockedPairsAmong, pairKey } from '../blocks/blocks.service';
import { createMutual } from '../connections/connections.service';
import { notify } from '../notifications/notifications.service';
import { dateRepository } from './live.repository';
import { matchRound } from './live.matching';
import { Decision, DecisionPayload, LeftReason, LiveEmitter, SparkPayload } from './live.types';

export { matchRound, score } from './live.matching';
// Sprint 3 rule: other modules are reached only through their services (never their repositories).

const noopEmitter: LiveEmitter = { toUser() {}, toEvent() {}, isOnline: async () => false };
let emitter: LiveEmitter = noopEmitter;
/** Set by the Socket.IO gateway (and tests). */
export const setLiveEmitter = (e: LiveEmitter) => { emitter = e; };

const SEC = 1000;
const MIN_COMPLETED_SEC = 60;
const roundMs = (ev: LiveEvent) => ev.roundMinutes * 60 * SEC;
export const roomName = (e: string, n: number, dateId: string) => `evt_${e}_r${n}_${dateId}`;
const positive = (d?: Decision | null) => d === 'like' || d === 'save';
const card = (p?: LiveProfile, id?: string) => p
  ? { id: p.id, fullName: p.fullName, age: p.age, city: p.city, photoUrl: p.photoUrl, interests: p.interests, bio: p.bio }
  : { id: id!, fullName: null, age: null, city: null, photoUrl: null, interests: [] as string[], bio: null };
const other = (d: any, u: string) => (String(d.userA) === u ? String(d.userB) : String(d.userA));
const inDate = (d: any, u: string) => String(d.userA) === u || String(d.userB) === u;
const iso = (t: number | Date | null | undefined) => (t == null ? null : new Date(t).toISOString());

export const serverTime = () => ({ serverTime: Date.now(), iso: new Date().toISOString() });

// ---------- lobby ----------
async function lobbyState(eventId: string, ev?: LiveEvent | null) {
  const st = await getLiveStore().getState(eventId);
  const waiting = (await getLiveStore().present(eventId, Date.now() - env.LIVE_PRESENCE_TTL_SEC * SEC)).length;
  const e = ev ?? (await getLiveEvent(eventId));
  const status = st?.status ?? (e?.status === 'live' ? 'live' : e?.status === 'ended' ? 'ended' : 'lobby');
  return { eventId, round: st?.round ?? 0, status, waiting, nextRoundAt: iso(st ? st.nextRoundAt : e ? +e.startsAt : null) };
}
async function broadcastLobby(eventId: string, ev?: LiveEvent | null) { emitter.toEvent(eventId, 'lobby:state', await lobbyState(eventId, ev)); }

// ---------- LiveKit ----------
async function mint(room: string, identity: string, name: string | null, endsAt: Date) {
  const ttlSec = Math.max(60, (+endsAt + 60 * SEC - Date.now()) / SEC); // round end + 60 s
  let last: unknown;
  for (let i = 0; i < 3; i++) { // first try + 2 retries
    try { return await getLiveKit().mintToken({ room, identity, name: name ?? undefined, ttlSec }); } catch (e) { last = e; }
  }
  throw last;
}
async function matchFound(d: any, forUser: string, partner: LiveProfile | undefined, token: string) {
  emitter.toUser(forUser, 'match:found', {
    dateId: String(d._id), round: d.round, partner: card(partner, other(d, forUser)),
    livekit: { url: getLiveKit().url, room: d.room, token }, startsAt: iso(d.startsAt), endsAt: iso(d.endsAt),
  });
}

// ---------- client -> server ----------
export async function join(userId: string, eventId: string) {
  const ev = await getLiveEvent(eventId); const now = Date.now();
  if (!ev) throw new AppError(404, 'EVENT_NOT_FOUND');
  if (ev.status === 'ended' || now >= +ev.endsAt) throw new AppError(409, 'EVENT_ENDED');
  if (!['published', 'live'].includes(ev.status)) throw new AppError(409, 'EVENT_NOT_LIVE');
  if (now < +ev.startsAt - LOBBY_OPEN_MS) throw new AppError(409, 'LOBBY_NOT_OPEN');
  const b = await findConfirmedBooking(eventId, userId);
  if (!b) throw new AppError(403, 'NOT_BOOKED');
  await markAttended(eventId, userId);
  const store = getLiveStore();
  await store.delGrace(eventId, userId);
  await store.setPresent(eventId, userId, b.gender, now);
  // Reconnect: resend the current date with a fresh token.
  const d = await activeDate(eventId, userId);
  if (d && +d.endsAt > now) {
    const p = (await liveProfiles([other(d, userId)])).get(other(d, userId));
    try { await matchFound(d, userId, p, await mint(d.room, userId, null, d.endsAt)); }
    catch (err) { logger.error({ err, eventId, dateId: String(d._id) }, 'livekit token mint failed on rejoin'); }
  }
  const lobby = await lobbyState(eventId, ev);
  emitter.toEvent(eventId, 'lobby:state', lobby);
  return { lobby, serverTime: now };
}

export async function leave(userId: string, eventId: string) {
  const store = getLiveStore();
  await store.removePresent(eventId, userId); await store.delGrace(eventId, userId);
  await endActiveDate(eventId, userId, 'left');
  await broadcastLobby(eventId);
  return {};
}

/**
 * date:leave: end only the current date (early_end). The caller stays present in the event (attendedAt was set at join),
 * keeps whatever queue priority it already had, and is matched again at the next round.tick without re-sending event:join.
 * The partner gets partner:left {reason:'ended'} and is re-queued with priority.
 */
export async function dateLeave(userId: string, { dateId }: { dateId: string }) {
  const d = await dateRepository.findById(dateId).lean();
  if (!d || !inDate(d, userId)) throw new AppError(404, 'DATE_NOT_FOUND');
  const ended = await endActiveDate(String(d.eventId), userId, 'ended', dateId);
  if (!ended) throw new AppError(409, 'DATE_NOT_ACTIVE');
  await broadcastLobby(String(d.eventId));
  return {};
}

export async function ping(userId: string, eventIds: string[]) {
  const now = Date.now();
  for (const e of eventIds) await getLiveStore().touch(e, userId, now);
  return { serverTime: now };
}

export async function decide(userId: string, { dateId, decision }: DecisionPayload) {
  const d = await dateRepository.findById(dateId).lean();
  if (!d || !inDate(d, userId)) throw new AppError(404, 'DATE_NOT_FOUND');
  const field = String(d.userA) === userId ? 'decisionA' : 'decisionB';
  const now = new Date();
  const upd = await dateRepository.findOneAndUpdate({ _id: d._id, [field]: { $exists: false }, decisionDeadline: { $gte: now } },
    { $set: { [field]: decision } }, { new: true }).lean();
  if (!upd) {
    const cur = await dateRepository.findById(dateId).select(field).lean();
    throw (cur as any)?.[field] ? new AppError(409, 'ALREADY_DECIDED') : new AppError(409, 'DECISION_CLOSED');
  }
  if (positive(upd.decisionA as Decision) && positive(upd.decisionB as Decision)) await onMutual(upd);
  return {};
}

export async function spark(userId: string, { dateId }: SparkPayload) {
  const d = await dateRepository.findById(dateId).lean();
  if (!d || !inDate(d, userId)) throw new AppError(404, 'DATE_NOT_FOUND');
  if (d.endedAt || Date.now() > +d.endsAt) throw new AppError(409, 'DATE_NOT_ACTIVE');
  emitter.toUser(other(d, userId), 'date:spark', { dateId });
  return {};
}

/** Socket closed. If the user has no other socket left, start the reconnect grace. */
export async function onDisconnect(userId: string, eventIds: string[]) {
  if (!eventIds.length || (await emitter.isOnline(userId))) return;
  const graceMs = env.RECONNECT_GRACE_SEC * SEC;
  for (const eventId of eventIds) {
    const token = crypto.randomUUID();
    await getLiveStore().setGrace(eventId, userId, token, graceMs + 60 * SEC);
    await getQueue().add('live.grace', { eventId, userId, token }, { jobId: jobId('grace', eventId, userId, token), delayMs: graceMs });
  }
}

/** live.grace job: grace over and no rejoin -> end the date as early_disconnect, partner re-queued. */
export async function graceExpired({ eventId, userId, token }: { eventId: string; userId: string; token: string }) {
  const store = getLiveStore();
  if ((await store.getGrace(eventId, userId)) !== token) return; // rejoined or superseded
  await store.delGrace(eventId, userId);
  await store.removePresent(eventId, userId);
  await endActiveDate(eventId, userId, 'disconnect');
  await broadcastLobby(eventId);
}

async function activeDate(eventId: string, userId: string) {
  return dateRepository.findOne({ eventId, endedAt: { $exists: false }, $or: [{ userA: userId }, { userB: userId }] }).sort({ round: -1 }).lean();
}
async function endActiveDate(eventId: string, userId: string, reason: LeftReason, dateId?: string) {
  const now = new Date();
  const filter: any = { eventId, endedAt: { $exists: false }, $or: [{ userA: userId }, { userB: userId }] };
  if (dateId) Object.assign(filter, { _id: dateId, endsAt: { $gt: now } });
  const d = await dateRepository.findOneAndUpdate(filter,
    { $set: { endedAt: now, endReason: reason === 'ended' ? 'early_end' : 'early_disconnect', leftBy: userId, leftReason: reason } }, { new: true, sort: { round: -1 } }).lean();
  if (!d) return null;
  const callSec = Math.max(0, (Math.min(+now, +d.endsAt) - +d.startsAt) / SEC);
  await dateRepository.updateOne({ _id: d._id }, { $set: { callSec } });
  const partner = other(d, userId);
  emitter.toUser(partner, 'partner:left', { dateId: String(d._id), reason });
  await getLiveStore().addPriority(eventId, partner); // re-queued (first) for the next round
  logger.info({ eventId, round: d.round, dateId: String(d._id), reason }, 'live date ended early');
  return d;
}

async function onMutual(d: any) {
  const a = String(d.userA); const b = String(d.userB);
  const r = await createMutual(a, b, String(d.eventId), String(d._id));
  if (!r.created) return;
  const cards = await liveProfiles([a, b]);
  for (const [me, them] of [[a, b], [b, a]]) {
    emitter.toUser(me, 'connection:mutual', { connectionId: r.connectionId, partner: card(cards.get(them), them) });
    await notify({ userId: me, type: 'connection_mutual', title: "It's a match!", body: `You and ${cards.get(them)?.fullName ?? 'your date'} liked each other`,
      data: { connectionId: r.connectionId }, dedupeKey: `mutual:${r.connectionId}:${me}` });
  }
}

// ---------- timeline jobs ----------
export async function eventOpen({ eventId, at }: { eventId: string; at: number }) {
  const ev = await getLiveEvent(eventId);
  if (!ev || ev.status !== 'published' || +ev.startsAt - LOBBY_OPEN_MS !== at) return; // stale (event moved/cancelled)
  await getLiveStore().setState(eventId, { round: 0, status: 'lobby', nextRoundAt: +ev.startsAt });
  await broadcastLobby(eventId, ev);
}

export async function eventStart({ eventId, at }: { eventId: string; at: number }) {
  const ev = await getLiveEvent(eventId);
  if (!ev || +ev.startsAt !== at) return;
  if (!(await setLiveStatus(eventId, ['published'], 'live')) && ev.status !== 'live') return;
  await getQueue().add('round.tick', { eventId, round: 1 }, { jobId: jobId('tick', eventId, 1) });
}

export async function roundTick({ eventId, round: n }: { eventId: string; round: number }) {
  const ev = await getLiveEvent(eventId);
  if (!ev || ev.status !== 'live') return;
  const now = Date.now(); const len = roundMs(ev);
  if (now + len > +ev.endsAt) return; // no time for another full round; event.end closes it
  const store = getLiveStore();
  if (!(await store.claimRound(eventId, n))) return; // already ticked (retry / second process)

  const present = await store.present(eventId, now - env.LIVE_PRESENCE_TTL_SEC * SEC);
  const busy = new Set((await dateRepository.find({ eventId, endedAt: { $exists: false } }).select('userA userB').lean()).flatMap((d) => [String(d.userA), String(d.userB)]));
  const ids = present.map((p) => p.userId).filter((u) => !busy.has(u));
  const profiles = await liveProfiles(ids);
  const users = present.filter((p) => profiles.has(p.userId) && !busy.has(p.userId)).map((p) => {
    const x = profiles.get(p.userId)!;
    return { id: p.userId, gender: p.gender, interests: x.interests, city: x.city, interestedCity: x.interestedCity, profession: x.profession };
  });
  const met = new Set((await dateRepository.distinct('pairKey', { eventId })) as string[]);
  const blocked = await blockedPairsAmong(ids);
  const priority = new Set(await store.priority(eventId));
  const t0 = process.hrtime.bigint();
  const { pairs, unmatched } = matchRound({ users, met, blocked, priority });
  const pairingMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const startsAt = new Date(now); const endsAt = new Date(now + len); const deadline = new Date(+endsAt + env.DECISION_WINDOW_SEC * SEC);
  const sat = [...unmatched]; let created = 0;
  for (const [m, f] of pairs) {
    const [userA, userB] = m < f ? [m, f] : [f, m];
    const _id = new Types.ObjectId(); const room = roomName(eventId, n, String(_id));
    let ta: string, tb: string;
    try { ta = await mint(room, userA, profiles.get(userA)?.fullName ?? null, endsAt); tb = await mint(room, userB, profiles.get(userB)?.fullName ?? null, endsAt); }
    catch (err) { logger.error({ err, eventId, round: n }, 'livekit token mint failed after retries: pair sits out'); sat.push(m, f); continue; }
    try {
      await dateRepository.create({ _id, eventId, round: n, userA, userB, pairKey: pairKey(userA, userB), room, startsAt, endsAt, decisionDeadline: deadline });
    } catch (e: any) { if (e?.code !== 11000) throw e; sat.push(m, f); continue; }
    created++;
    const d = { _id, round: n, userA, userB, room, startsAt, endsAt };
    await matchFound(d, userA, profiles.get(userB), ta); await matchFound(d, userB, profiles.get(userA), tb);
    for (const u of [userA, userB]) emitter.toUser(u, 'round:started', { dateId: String(_id), endsAt: iso(endsAt) });
  }
  for (const u of sat) emitter.toUser(u, 'no:match', { round: n });
  await store.setPriority(eventId, sat);
  await store.setState(eventId, { round: n, status: 'live', nextRoundAt: +endsAt + env.ROUND_BREAK_SEC * SEC });
  await getQueue().add('round.end', { eventId, round: n }, { jobId: jobId('rend', eventId, n), delayMs: len });
  await broadcastLobby(eventId, ev);
  logger.info({ eventId, round: n, present: present.length, pairs: created, satOut: sat.length, pairingMs }, 'live round started');
}

export async function roundEnd({ eventId, round: n }: { eventId: string; round: number }) {
  const dates = await dateRepository.find({ eventId, round: n }).lean();
  for (const d of dates) if (!d.endedAt)
    await dateRepository.updateOne({ _id: d._id, endedAt: { $exists: false } }, { $set: { endedAt: d.endsAt, endReason: 'completed', callSec: (+d.endsAt - +d.startsAt) / SEC } });
  let early = 0; let deadline = 0;
  for (const d of await dateRepository.find({ eventId, round: n }).lean()) {
    if (d.endReason === 'early_disconnect' || d.endReason === 'early_end') early++;
    deadline = Math.max(deadline, +d.decisionDeadline);
    if ((d.callSec ?? 0) >= MIN_COMPLETED_SEC && (await dateRepository.updateOne({ _id: d._id, counted: false }, { $set: { counted: true } })).modifiedCount === 1)
      await addDateCompleted(eventId, [String(d.userA), String(d.userB)]);
    for (const u of [String(d.userA), String(d.userB)]) emitter.toUser(u, 'round:ended', { dateId: String(d._id), decisionDeadline: iso(d.decisionDeadline) });
  }
  const now = Date.now();
  if (dates.length) await getQueue().add('round.decide', { eventId, round: n }, { jobId: jobId('decide', eventId, n), delayMs: Math.max(0, deadline - now) });
  const ev = await getLiveEvent(eventId);
  const nextAt = now + env.ROUND_BREAK_SEC * SEC;
  if (ev && ev.status === 'live' && nextAt + roundMs(ev) <= +ev.endsAt) {
    await getLiveStore().setState(eventId, { round: n, status: 'break', nextRoundAt: nextAt });
    await getQueue().add('round.tick', { eventId, round: n + 1 }, { jobId: jobId('tick', eventId, n + 1), delayMs: nextAt - now });
  } else if (ev && ev.status === 'live') {
    // Last round: end once the decision window closes (event.end at endsAt stays as a backstop).
    await getLiveStore().setState(eventId, { round: n, status: 'break', nextRoundAt: null });
    await getQueue().add('event.end', { eventId, at: 'rounds_done' }, { jobId: jobId('end', eventId, 'done'), delayMs: Math.max(0, deadline - now) });
  }
  await broadcastLobby(eventId, ev);
  logger.info({ eventId, round: n, dates: dates.length, earlyDisconnects: early }, 'live round ended');
}

export async function roundDecide({ eventId, round: n }: { eventId: string; round: number }) {
  let mutual = 0;
  for (const d0 of await dateRepository.find({ eventId, round: n, decidedAt: { $exists: false } }).select('_id').lean()) {
    const d = await dateRepository.findOneAndUpdate({ _id: d0._id, decidedAt: { $exists: false } }, { $set: { decidedAt: new Date() } }, { new: true }).lean();
    if (!d) continue;
    const a = String(d.userA); const b = String(d.userB);
    if (positive(d.decisionA as Decision) && positive(d.decisionB as Decision)) { mutual++; await onMutual(d); continue; }
    for (const [liker, dec, target] of [[a, d.decisionA, b], [b, d.decisionB, a]] as const)
      if (positive(dec as Decision)) await notify({ userId: target, type: 'liked_you', title: 'They liked you', body: 'Someone you met in the live event liked you',
        data: { eventId, dateId: String(d._id) }, dedupeKey: `liked:${d._id}:${liker}` });
  }
  logger.info({ eventId, round: n, mutual }, 'live round decided');
}

export async function eventEnd({ eventId, at }: { eventId: string; at: number | 'rounds_done' }) {
  const ev = await getLiveEvent(eventId);
  if (!ev || (typeof at === 'number' && at !== +ev.endsAt)) return; // stale (event moved)
  if (!(await setLiveStatus(eventId, ['live'], 'ended'))) return; // never started, or already ended
  const now = new Date();
  await dateRepository.updateMany({ eventId, endedAt: { $exists: false } }, { $set: { endedAt: now, endReason: 'completed' } });
  await getLiveStore().setState(eventId, { round: (await getLiveStore().getState(eventId))?.round ?? 0, status: 'ended', nextRoundAt: null });
  for (const [u, n] of await datesCompletedByUser(eventId)) emitter.toUser(u, 'event:ended', { eventId, datesCompleted: n });
  await broadcastLobby(eventId);
  await getQueue().add('event.finalize', { eventId }, { jobId: jobId('finalize', eventId, +ev.endsAt), delayMs: Math.max(0, +ev.endsAt - Date.now()) });
}
