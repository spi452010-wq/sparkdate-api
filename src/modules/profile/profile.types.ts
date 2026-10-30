import { z } from 'zod';
import { completeSchema, updateSchema, verificationSchema } from './profile.validator';

/** DTOs and interfaces of the profile module. Input DTOs are inferred from the zod schemas in the validators. */
export type CompleteProfileInput = z.infer<typeof completeSchema>;
export type UpdateProfileInput = z.infer<typeof updateSchema>;
export type VerificationInput = z.infer<typeof verificationSchema>;
