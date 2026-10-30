import { z } from 'zod';
import { createBookingBody, refundRequestBody } from './bookings.validator';

/** DTOs and interfaces of the bookings module. Input DTOs are inferred from the zod schemas in the validators. */
export type CreateBookingInput = z.infer<typeof createBookingBody>;
export type RefundRequestInput = z.infer<typeof refundRequestBody>;
