import { Actor } from './events.types';
import { AppError } from '../../utils/errors';
import { adminEventOut as out } from './event.mapper';
import { paidRule } from './adminEvents.validator';
import { eventRepository } from './events.repository';
import { bookingRepository } from '../bookings/bookings.repository';
import { scheduleTimeline } from './events.service';

// Admin can move anything; live/ended are normally set by the live-session module.
const ALLOWED: Record<string, string[]> = { draft: ['published', 'cancelled'], published: ['draft', 'cancelled', 'live'], live: ['ended'], ended: [], cancelled: [] };
// Hosts only see and edit their own events.
const scope = (a: Actor) => (a.role === 'admin' ? {} : { createdBy: a.id });

export async function list(a: Actor, { status, page, limit }: any) {
  const q: any = { ...scope(a), ...(status && { status }) };
  const [items, total] = await Promise.all([eventRepository.find(q).sort({ startsAt: -1 }).skip((page - 1) * limit).limit(limit), eventRepository.countDocuments(q)]);
  return { items: items.map(out), total };
}

export async function get(a: Actor, id: string) {
  const e = await eventRepository.findOne({ _id: id, ...scope(a) });
  if (!e) throw new AppError(404, 'NOT_FOUND');
  return out(e);
}

export async function create(a: Actor, input: any) {
  const body = { ...input, playProductId: input.priceInPaise > 0 ? input.playProductId : null };
  const e = await eventRepository.create({ ...body, booked: { male: 0, female: 0 }, createdBy: a.id });
  await scheduleTimeline(e);
  return out(e);
}

export async function update(a: Actor, id: string, patch: any) {
  const cur = await eventRepository.findOne({ _id: id, ...scope(a) });
  if (!cur) throw new AppError(404, 'NOT_FOUND');
  const next = { ...cur.toObject(), ...patch };
  if (!paidRule(next)) throw new AppError(400, 'VALIDATION_ERROR', 'playProductId required for paid events');
  if (next.endsAt && next.endsAt <= next.startsAt) throw new AppError(400, 'VALIDATION_ERROR', 'endsAt must be after startsAt');
  if (patch.status && patch.status !== cur.status && !ALLOWED[cur.status].includes(patch.status))
    throw new AppError(409, 'INVALID_STATUS_TRANSITION', `${cur.status} -> ${patch.status}`);
  if (['live', 'ended'].includes(cur.status) && (patch.capacity || patch.startsAt || patch.priceInPaise !== undefined || patch.playProductId !== undefined))
    throw new AppError(409, 'EVENT_LOCKED', 'Cannot change schedule, price or capacity once live');
  if (patch.status === 'cancelled' && (await bookingRepository.exists({ eventId: cur._id, status: { $in: ['pending', 'confirmed', 'refund_requested'] } })))
    throw new AppError(409, 'USE_CANCEL_ENDPOINT', 'Event has bookings: use POST /admin/events/:id/cancel so holds are released and payments refunded');
  const set: any = { ...patch };
  if (next.priceInPaise === 0) set.playProductId = null;
  const filter: any = { _id: cur._id };
  if (patch.capacity) {
    // Atomic guard: new capacity must still cover seats booked by the time we write.
    filter['booked.male'] = { $lte: patch.capacity.male };
    filter['booked.female'] = { $lte: patch.capacity.female };
  }
  const e = await eventRepository.findOneAndUpdate(filter, { $set: set }, { new: true, runValidators: true });
  if (!e) throw new AppError(409, 'CAPACITY_BELOW_BOOKED', 'Capacity cannot be below seats already booked', { booked: cur.booked });
  await scheduleTimeline(e);
  return out(e);
}

export async function listBookings(a: Actor, id: string) {
  const e = await eventRepository.findOne({ _id: id, ...scope(a) }).select('_id');
  if (!e) throw new AppError(404, 'NOT_FOUND');
  const items = await bookingRepository.find({ eventId: e._id }).sort({ createdAt: -1 }).limit(500).populate<{ userId: any }>('userId', 'profile.fullName');
  return { items: items.map((b: any) => ({ id: String(b._id), eventId: String(b.eventId), userId: String(b.userId?._id ?? b.userId), userName: b.userId?.profile?.fullName,
    gender: b.gender, status: b.status, amountInPaise: b.amountInPaise, datesCompleted: b.datesCompleted, createdAt: b.createdAt, refund: b.refund?.status ? b.refund : undefined })), total: items.length };
}
