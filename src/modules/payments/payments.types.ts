import { z } from 'zod';
import { verifyBody } from './payments.validator';

/** DTOs and interfaces of the payments module. Input DTOs are inferred from the zod schemas in the validators. */
export type VerifyPurchaseInput = z.infer<typeof verifyBody>;
/** Result of applying a Play ticket purchase to a booking. */
export type TicketResult = { status: 'confirmed' | 'pending'; booking: any };
