import { Types } from 'mongoose';
import { AppError } from '../../utils/errors';
import { bookingOut } from '../bookings/bookings.service';
import { appEvent } from './event.mapper';

export { appEvent, VISIBLE } from './event.mapper';
import { VISIBLE } from './event.mapper';
import { userRepository } from '../users/users.repository';
import { eventRepository, reactionRepository } from './events.repository';
import { bookingRepository } from '../bookings/bookings.repository';

const gender = async (id: string) => (await userRepository.findById(id).select('profile.gender'))?.profile?.gender ?? null;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function listEvents(userId: string, { status, city, q, cursor, limit }: any) {
  const f: any = status === 'live' ? { status: 'live' } : { status: 'published', startsAt: { $gt: new Date() } };
  if (city) f.city = city;
  if (q) f.title = new RegExp(esc(q), 'i');
  if (cursor) {
    let c: any; try { c = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw new AppError(400, 'VALIDATION_ERROR', 'Bad cursor'); }
    if (typeof c?.s !== 'number' || !Types.ObjectId.isValid(c?.i)) throw new AppError(400, 'VALIDATION_ERROR', 'Bad cursor');
    const s = new Date(c.s);
    f.$and = [{ $or: [{ startsAt: { $gt: s } }, { startsAt: s, _id: { $gt: new Types.ObjectId(c.i) } }] }];
  }
  const [items, g] = await Promise.all([eventRepository.find(f).sort({ startsAt: 1, _id: 1 }).limit(limit + 1), gender(userId)]);
  const page = items.slice(0, limit); const last = page[page.length - 1];
  return { items: page.map((e) => appEvent(e, g)),
    nextCursor: items.length > limit && last ? Buffer.from(JSON.stringify({ s: +last.startsAt, i: String(last._id) })).toString('base64url') : null };
}

const visible = async (id: string) => {
  const e = await eventRepository.findOne({ _id: id, status: { $in: VISIBLE } });
  if (!e) throw new AppError(404, 'NOT_FOUND');
  return e;
};

export async function eventDetail(userId: string, id: string) {
  const e = await visible(id);
  const [g, b, rx] = await Promise.all([gender(userId), bookingRepository.findOne({ eventId: e._id, userId }),
    reactionRepository.find({ eventId: e._id, userId }).select('kind')]);
  return { ...appEvent(e, g), myBooking: b ? bookingOut(b) : null, liked: rx.some((x) => x.kind === 'like'), saved: rx.some((x) => x.kind === 'save') };
}

export async function addReaction(userId: string, id: string, kind: 'like' | 'save') {
  const e = await visible(id);
  await reactionRepository.updateOne({ userId, eventId: e._id, kind }, { $setOnInsert: { userId, eventId: e._id, kind } }, { upsert: true })
    .catch((err: any) => { if (err?.code !== 11000) throw err; });
}
export async function removeReaction(userId: string, id: string, kind: 'like' | 'save') {
  await reactionRepository.deleteOne({ userId, eventId: id, kind });
}
