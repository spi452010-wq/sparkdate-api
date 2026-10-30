import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../../middleware/validate';
import { env } from '../../config/env';
import * as c from './auth.controller';
import * as v from './auth.validator';


const r = Router();
const ipLimiter = rateLimit({ windowMs: 15 * 60_000, limit: env.AUTH_IP_LIMIT_PER_15MIN, standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: { code: 'OTP_RATE_LIMITED', message: 'Too many requests from this IP' } }) });

r.post('/otp/request', ipLimiter, validate(v.otpRequestBody), c.otpRequest);
r.post('/otp/verify', ipLimiter, validate(v.otpVerifyBody), c.otpVerify);
r.post('/google', ipLimiter, validate(v.googleBody), c.google);
r.post('/refresh', validate(v.refreshBody), c.refresh);
r.post('/logout', validate(v.refreshBody), c.logout);
export default r;
