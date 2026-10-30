import { z } from 'zod';
import { Types } from 'mongoose';

export const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');
export const idParams = z.object({ id: objectId });
export const createBookingBody = z.object({ eventId: objectId }).strict();
export const refundRequestBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
