import { z } from 'zod';
export const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Phone must be E.164, e.g. +919876543210');
export const otpRequestBody = z.object({ phone });
export const otpVerifyBody = z.object({ phone, code: z.string().regex(/^\d{6}$/) });
export const googleBody = z.object({ idToken: z.string().min(10) });
export const refreshBody = z.object({ refreshToken: z.string().min(20) });
