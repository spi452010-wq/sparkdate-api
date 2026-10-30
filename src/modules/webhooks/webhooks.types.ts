import { z } from 'zod';
import { pushSchema } from './webhooks.validator';

/** DTOs and interfaces of the webhooks module. Input DTOs are inferred from the zod schemas in the validators. */
export type PubsubPush = z.infer<typeof pushSchema>;
