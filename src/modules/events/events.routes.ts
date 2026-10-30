import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { asyncHandler, AppError } from '../../utils/errors';
import { User } from '../auth/user.model';
import { Event } from './event.model';
import { Booking } from './booking.model';
import { EventReaction } from './reaction.model';
import { bookingOut } from '../bookings/bookings.routes';

export const VISIBLE = ['published', 'live', 'ended', 'cancelled'];
export const appEvent = (e: any, g?: string | null) => ({
  id: String(e._id), title: e.title, city: e.city ?? null, description: e.description, startsAt: e.startsAt, endsAt: e.endsAt ?? null, roundMinutes: e.roundMinutes,
  priceInPaise: e.priceInPaise, isFree: !(e.priceInPaise > 0), playProductId: e.playProductId ?? null, status: e.status,
  seatsLeft: g === 'male' || g === 'female' ? Math.max(0, (e.capacity?.[g] ?? 0) - (e.booked?.[g] ?? 0)) : null,
});
const gender = async (id: string) => (await User.findById(id).select('profile.gender'))?.profile?.gender ?? null;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const idParam = validate(z.object({ id: z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id') }), 'params');

const r = Router();
r.use(requireAuth);
r.get('/', validate(z.object({
  status: z.enum(['upcoming', 'live']).default('upcoming'),
  city: z.string().trim().min(1).max(60).optional(), q: z.string().trim().min(1).max(50).optional(),
  cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20),
}), 'query'), asyncHandler(async (req, res) => {
  const { status, city, q, cursor, limit } = req.query as any;
  const f: any = status === 'live' ? { status: 'live' } : { status: 'published', startsAt: { $gt: new Date() } };
  if (city) f.city = city;
  if (q) f.title = new RegExp(esc(q), 'i');
  if (cursor) {
    let c: any; try { c = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw new AppError(400, 'VALIDATION_ERROR', 'Bad cursor'); }
    if (typeof c?.s !== 'number' || !Types.ObjectId.isValid(c?.i)) throw new AppError(400, 'VALIDATION_ERROR', 'Bad cursor');
    const s = new Date(c.s);
    f.$and = [{ $or: [{ startsAt: { $gt: s } }, { startsAt: s, _id: { $gt: new Types.ObjectId(c.i) } }] }];
  }
  const [items, g] = await Promise.all([Event.find(f).sort({ startsAt: 1, _id: 1 }).limit(limit + 1), gender(req.user.id)]);
  const page = items.slice(0, limit); const last = page[page.length - 1];
  res.set('Cache-Control', 'private, max-age=60');
  res.json({ items: page.map((e) => appEvent(e, g)),
    nextCursor: items.length > limit && last ? Buffer.from(JSON.stringify({ s: +last.startsAt, i: String(last._id) })).toString('base64url') : null });
}));

const visible = async (id: string) => {
  const e = await Event.findOne({ _id: id, status: { $in: VISIBLE } });
  if (!e) throw new AppError(404, 'NOT_FOUND');
  return e;
};
r.get('/:id', idParam, asyncHandler(async (req, res) => {
  const e = await visible(req.params.id);
  const [g, b, rx] = await Promise.all([gender(req.user.id), Booking.findOne({ eventId: e._id, userId: req.user.id }),
    EventReaction.find({ eventId: e._id, userId: req.user.id }).select('kind')]);
  res.json({ ...appEvent(e, g), myBooking: b ? bookingOut(b) : null, liked: rx.some((x) => x.kind === 'like'), saved: rx.some((x) => x.kind === 'save') });
}));
for (const kind of ['like', 'save'] as const) {
  const flag = kind === 'like' ? 'liked' : 'saved';
  r.post(`/:id/${kind}`, idParam, asyncHandler(async (req, res) => {
    const e = await visible(req.params.id);
    await EventReaction.updateOne({ userId: req.user.id, eventId: e._id, kind }, { $setOnInsert: { userId: req.user.id, eventId: e._id, kind } }, { upsert: true })
      .catch((err: any) => { if (err?.code !== 11000) throw err; });
    res.json({ [flag]: true });
  }));
  r.delete(`/:id/${kind}`, idParam, asyncHandler(async (req, res) => {
    await EventReaction.deleteOne({ userId: req.user.id, eventId: req.params.id, kind });
    res.json({ [flag]: false });
  }));
}
export default r;
