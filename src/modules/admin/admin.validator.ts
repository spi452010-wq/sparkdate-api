import { z } from 'zod';
import { objectId } from '../../utils/validators';
import { BOOKING_STATUSES } from '../bookings/booking.model';
export const idParams = z.object({ id: objectId });
export const listUsersQuery = z.object({
  verification: z.enum(['none', 'pending', 'approved', 'rejected']).optional(),
  status: z.enum(['active', 'blocked']).optional(),
  q: z.string().trim().min(1).max(50).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const userBookingsQuery = z.object({
  status: z.enum(BOOKING_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export const verificationDecisionBody = z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().max(200).optional() }).strict();
export const userStatusBody = z.object({ status: z.enum(['active', 'blocked']) }).strict();
