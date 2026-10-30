import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import * as c from './adminAuth.controller';
import * as v from './adminAuth.validator';

const r = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: env.ADMIN_LOGIN_IP_LIMIT_PER_15MIN, standardHeaders: true, legacyHeaders: false,
  handler: (_q, res) => res.status(429).json({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Try again later' } }) });

r.post('/login', loginLimiter, validate(v.loginBody), c.login);
r.get('/me', c.me);
r.post('/logout', requireAuth, c.logout);
export default r;
