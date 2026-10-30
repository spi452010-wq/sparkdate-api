import { z } from 'zod';
import { Types } from 'mongoose';
export const STATUSES = ['draft', 'published', 'live', 'ended', 'cancelled'] as const;
export const idParams = z.object({ id: z.string().refine((s) => Types.ObjectId.isValid(s)) });
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
export const paidRule = (e: any) => !(e.priceInPaise > 0) || !!e.playProductId;
export const createSchema = z.object(fields).strict()
  .refine(paidRule, { message: 'playProductId required for paid events', path: ['playProductId'] })
  .refine((e) => !e.endsAt || e.endsAt > e.startsAt, { message: 'endsAt must be after startsAt', path: ['endsAt'] })
  .refine((e) => e.startsAt > new Date(), { message: 'startsAt must be in the future', path: ['startsAt'] })
  .refine((e) => !e.status || ['draft', 'published'].includes(e.status), { path: ['status'], message: 'New events start as draft or published' });
// PATCH: every field optional; city, if present, must still be non-empty.
export const patchSchema = z.object(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, (v as any).optional?.() ?? v]))).strict();
export const listQuery = z.object({ status: z.enum(STATUSES).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) });
