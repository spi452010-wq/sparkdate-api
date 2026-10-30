import { z } from 'zod';
import { paymentsQuery, refundsQuery, rejectBody } from './refunds.validator';

/** DTOs and interfaces of the refunds module. Input DTOs are inferred from the zod schemas in the validators. */
export type RefundsQuery = z.infer<typeof refundsQuery>;
export type PaymentsQuery = z.infer<typeof paymentsQuery>;
export type RejectRefundInput = z.infer<typeof rejectBody>;
export type Page = { page: number; limit: number };
