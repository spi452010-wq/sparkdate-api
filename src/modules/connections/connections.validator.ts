import { z } from 'zod';

export const listQuery = z.object({ before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
