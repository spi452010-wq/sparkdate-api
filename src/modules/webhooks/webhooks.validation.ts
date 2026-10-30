import { z } from 'zod';

export const pushSchema = z.object({ message: z.object({ data: z.string().max(64_000).default(''), messageId: z.string().min(1).max(200) }).passthrough(), subscription: z.string().optional() }).passthrough();
