import { z } from 'zod';

import { objectId } from '../../utils/validators';
const qParam = z.string().trim().min(1).max(80).optional();
const paging = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) };
export const refundsQuery = z.object({ status: z.enum(['requested', 'processing', 'processed', 'rejected', 'failed']).optional(), q: qParam, ...paging });
export const paymentsQuery = z.object({ userId: objectId.optional(), status: z.enum(['verified', 'unlinked', 'refunded', 'refund_failed', 'voided']).optional(), eventId: objectId.optional(), q: qParam, ...paging });
export const bookingIdParams = z.object({ bookingId: objectId });
export const idParams = z.object({ id: objectId });
export const linkBody = z.object({ bookingId: objectId }).strict();
export const rejectBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
