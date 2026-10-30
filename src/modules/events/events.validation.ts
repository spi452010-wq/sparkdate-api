import { z } from 'zod';
import { Types } from 'mongoose';
export const idParams = z.object({ id: z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id') });
export const listQuery = z.object({
  status: z.enum(['upcoming', 'live']).default('upcoming'),
  city: z.string().trim().min(1).max(60).optional(), q: z.string().trim().min(1).max(50).optional(),
  cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20),
});
