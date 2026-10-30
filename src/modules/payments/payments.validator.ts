import { z } from 'zod';
import { objectId } from '../../utils/validators';

export const verifyBody = z.object({
  bookingId: objectId.optional(), // required for tickets (refine below)
  purchaseToken: z.string().min(10).max(4096), productId: z.string().regex(/^[a-z0-9_.]{1,100}$/), kind: z.enum(['ticket', 'chat_pass']),
}).strict().refine((b) => b.kind !== 'ticket' || !!b.bookingId, { path: ['bookingId'], message: 'bookingId required for tickets' });
