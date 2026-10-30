import { z } from 'zod';
export const loginBody = z.object({ email: z.string().trim().toLowerCase().email().max(120), password: z.string().min(8).max(200) }).strict();
