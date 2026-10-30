// Response mappers shared across modules (pure functions, no DB).
export const VISIBLE = ['published', 'live', 'ended', 'cancelled'];
export const appEvent = (e: any, g?: string | null) => ({
  id: String(e._id), title: e.title, city: e.city ?? null, description: e.description, startsAt: e.startsAt, endsAt: e.endsAt ?? null, roundMinutes: e.roundMinutes,
  priceInPaise: e.priceInPaise, isFree: !(e.priceInPaise > 0), playProductId: e.playProductId ?? null, status: e.status,
  seatsLeft: g === 'male' || g === 'female' ? Math.max(0, (e.capacity?.[g] ?? 0) - (e.booked?.[g] ?? 0)) : null,
});
export const adminEventOut = (e: any) => ({ id: String(e._id), title: e.title, city: e.city, description: e.description, startsAt: e.startsAt, endsAt: e.endsAt, roundMinutes: e.roundMinutes,
  priceInPaise: e.priceInPaise, playProductId: e.playProductId ?? null, status: e.status, capacity: e.capacity, booked: e.booked });
