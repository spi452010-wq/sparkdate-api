import { z } from 'zod';
import { listQuery, readBody } from './notifications.validator';

/** DTOs and interfaces of the notifications module. Input DTOs are inferred from the zod schemas in the validators. */
export type NotificationListQuery = z.infer<typeof listQuery>;
export type MarkReadInput = z.infer<typeof readBody>;
