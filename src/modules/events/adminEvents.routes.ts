import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { validate } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import { asyncHandler, AppError } from '../../utils/errors';
import { Event } from './event.model';
import { Booking } from './booking.model';

const r = Router();
r.use(requireAuth, requireRole('admin', 'host'));
const idParam = validate(z.object({ id: z.string().refine((s) => Types.ObjectId.isValid(s)) }), 'params');
const STATUSES = ['draft', 'published', 'live', 'ended', 'cancelled'] as const;
// Admin can move anything; live/ended are normally set by the live-session module.
const ALLOWED: Record<string, string[]> = { draft: ['published', 'cancelled'], published: ['draft', 'cancelled', 'live'], live: ['ended'], ended: [], cancelled: [] };

const fields = {
  title: z.string().trim().min(3).max(80),
  description: z.string().trim().max(1000).default(''),
  city: z.string().trim().min(1).max(60),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().optional(),
  roundMinutes: z.number().int().min(1).max(30).default(3),
  capacity: z.object({ male: z.number().int().min(1), female: z.number().int().min(1) }).strict().refine((c) => c.male + c.female <= 300, 'Total capacity max 300'),
  priceInPaise: z.number().int().min(0).max(10_000_000).default(0),
  playProductId: z.string().regex(/^[a-z0-9_.]{1,100}$/).nullable().optional(),
  status: z.enum(STATUSES).optional(),
};
const paidRule = (e: any) => !(e.priceInPaise > 0) || !!e.playProductId;
const createSchema = z.object(fields).strict()
  .refine(paidRule, { message: 'playProductId required for paid events', path: ['playProductId'] })
  .refine((e) => !e.endsAt || e.endsAt > e.startsAt, { message: 'endsAt must be after startsAt', path: ['endsAt'] })
  .refine((e) => e.startsAt > new Date(), { message: 'startsAt must be in the future', path: ['startsAt'] })
  .refine((e) => !e.status || ['draft', 'published'].includes(e.status), { path: ['status'], message: 'New events start as draft or published' });
const patchSchema = z.object(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, (v as any).optional?.() ?? v]))).strict();

const out = (e: any) => ({ id: String(e._id), title: e.title, city: e.city, description: e.description, startsAt: e.startsAt, endsAt: e.endsAt, roundMinutes: e.roundMinutes,
  priceInPaise: e.priceInPaise, playProductId: e.playProductId ?? null, status: e.status, capacity: e.capacity, booked: e.booked });
// Hosts only see and edit their own events.
const scope = (req: any) => (req.user.role === 'admin' ? {} : { createdBy: req.user.id });

r.get('/', validate(z.object({ status: z.enum(STATUSES).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) }), 'query'),
  asyncHandler(async (req, res) => {
    const { status, page, limit } = req.query as any;
    const q: any = { ...scope(req), ...(status && { status }) };
    const [items, total] = await Promise.all([Event.find(q).sort({ startsAt: -1 }).skip((page - 1) * limit).limit(limit), Event.countDocuments(q)]);
    res.json({ items: items.map(out), total });
  }));

r.get('/:id', idParam, asyncHandler(async (req, res) => {
  const e = await Event.findOne({ _id: req.params.id, ...scope(req) });
  if (!e) throw new AppError(404, 'NOT_FOUND');
  res.json(out(e));
}));

r.post('/', validate(createSchema), asyncHandler(async (req, res) => {
  const body = { ...req.body, playProductId: req.body.priceInPaise > 0 ? req.body.playProductId : null };
  res.status(201).json(out(await Event.create({ ...body, booked: { male: 0, female: 0 }, createdBy: req.user.id })));
}));

r.patch('/:id', idParam, validate(patchSchema), asyncHandler(async (req, res) => {
  const cur = await Event.findOne({ _id: req.params.id, ...scope(req) });
  if (!cur) throw new AppError(404, 'NOT_FOUND');
  const next = { ...cur.toObject(), ...req.body };
  if (!paidRule(next)) throw new AppError(400, 'VALIDATION_ERROR', 'playProductId required for paid events');
  if (next.endsAt && next.endsAt <= next.startsAt) throw new AppError(400, 'VALIDATION_ERROR', 'endsAt must be after startsAt');
  if (req.body.status && req.body.status !== cur.status && !ALLOWED[cur.status].includes(req.body.status))
    throw new AppError(409, 'INVALID_STATUS_TRANSITION', `${cur.status} -> ${req.body.status}`);
  if (['live', 'ended'].includes(cur.status) && (req.body.capacity || req.body.startsAt || req.body.priceInPaise !== undefined || req.body.playProductId !== undefined))
    throw new AppError(409, 'EVENT_LOCKED', 'Cannot change schedule, price or capacity once live');
  if (req.body.status === 'cancelled' && (await Booking.exists({ eventId: cur._id, status: { $in: ['pending', 'confirmed', 'refund_requested'] } })))
    throw new AppError(409, 'USE_CANCEL_ENDPOINT', 'Event has bookings: use POST /admin/events/:id/cancel so holds are released and payments refunded');
  const set: any = { ...req.body };
  if (next.priceInPaise === 0) set.playProductId = null;
  const filter: any = { _id: cur._id };
  if (req.body.capacity) {
    // Atomic guard: new capacity must still cover seats booked by the time we write.
    filter['booked.male'] = { $lte: req.body.capacity.male };
    filter['booked.female'] = { $lte: req.body.capacity.female };
  }
  const e = await Event.findOneAndUpdate(filter, { $set: set }, { new: true, runValidators: true });
  if (!e) throw new AppError(409, 'CAPACITY_BELOW_BOOKED', 'Capacity cannot be below seats already booked', { booked: cur.booked });
  res.json(out(e));
}));

r.get('/:id/bookings', idParam, asyncHandler(async (req, res) => {
  const e = await Event.findOne({ _id: req.params.id, ...scope(req) }).select('_id');
  if (!e) throw new AppError(404, 'NOT_FOUND');
  const items = await Booking.find({ eventId: e._id }).sort({ createdAt: -1 }).limit(500).populate<{ userId: any }>('userId', 'profile.fullName');
  res.json({ items: items.map((b: any) => ({ id: String(b._id), eventId: String(b.eventId), userId: String(b.userId?._id ?? b.userId), userName: b.userId?.profile?.fullName,
    gender: b.gender, status: b.status, amountInPaise: b.amountInPaise, datesCompleted: b.datesCompleted, createdAt: b.createdAt, refund: b.refund?.status ? b.refund : undefined })), total: items.length });
}));
export default r;
