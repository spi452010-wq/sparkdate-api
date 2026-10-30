import { z } from 'zod';
import { objectId } from '../bookings/bookings.validation';

export const listQuery = z.object({ before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
export const readBody = z.object({ ids: z.array(objectId).max(100).optional() }).strict();
