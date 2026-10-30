import { z } from 'zod';
import { loginBody } from './adminAuth.validator';
import { listUsersQuery, userStatusBody, verificationDecisionBody } from './admin.validator';

/** DTOs and interfaces of the admin module. Input DTOs are inferred from the zod schemas in the validators. */
export type ListUsersQuery = z.infer<typeof listUsersQuery>;
export type VerificationDecisionInput = z.infer<typeof verificationDecisionBody>;
export type UserStatusInput = z.infer<typeof userStatusBody>;
export type AdminLoginInput = z.infer<typeof loginBody>;
