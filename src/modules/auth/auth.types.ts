import { z } from 'zod';
import { googleBody, otpRequestBody, otpVerifyBody, refreshBody } from './auth.validator';

/** DTOs and interfaces of the auth module. Input DTOs are inferred from the zod schemas in the validators. */
export type OtpRequestInput = z.infer<typeof otpRequestBody>;
export type OtpVerifyInput = z.infer<typeof otpVerifyBody>;
export type GoogleLoginInput = z.infer<typeof googleBody>;
export type RefreshInput = z.infer<typeof refreshBody>;
