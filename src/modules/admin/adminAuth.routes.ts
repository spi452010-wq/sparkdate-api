import { Router } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { validate } from '../../middleware/validate';
import { ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE, requireAuth } from '../../middleware/auth';
import { asyncHandler, AppError } from '../../utils/errors';
import { User } from '../auth/user.model';
import { verifyPassword } from '../auth/password';
import { issueTokens, rotate, revoke } from '../auth/tokens';

const r = Router();
const secure = env.NODE_ENV === 'production';
const base = { httpOnly: true, secure, sameSite: 'strict' as const };
const out = (u: any) => ({ id: String(u._id), email: u.email, role: u.role, fullName: u.profile?.fullName });

function setSession(res: any, t: { accessToken: string; refreshToken: string }) {
  res.cookie(ACCESS_COOKIE, t.accessToken, { ...base, path: '/api/v1', maxAge: 15 * 60_000 });
  res.cookie(REFRESH_COOKIE, t.refreshToken, { ...base, path: '/api/v1/admin/auth', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000 });
  res.cookie(CSRF_COOKIE, crypto.randomBytes(24).toString('base64url'), { httpOnly: false, secure, sameSite: 'strict', path: '/' });
}
function clearSession(res: any) {
  res.clearCookie(ACCESS_COOKIE, { ...base, path: '/api/v1' });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: '/api/v1/admin/auth' });
  res.clearCookie(CSRF_COOKIE, { secure, sameSite: 'strict', path: '/' });
}
const panelUser = async (id: string) => {
  const u = await User.findById(id);
  if (!u || u.status === 'blocked') throw new AppError(403, 'ACCOUNT_BLOCKED');
  if (!['admin', 'host'].includes(u.role)) throw new AppError(403, 'FORBIDDEN');
  return u;
};

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: env.ADMIN_LOGIN_IP_LIMIT_PER_15MIN, standardHeaders: true, legacyHeaders: false,
  handler: (_q, res) => res.status(429).json({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Try again later' } }) });

r.post('/login', loginLimiter, validate(z.object({ email: z.string().trim().toLowerCase().email().max(120), password: z.string().min(8).max(200) }).strict()),
  asyncHandler(async (req, res) => {
    const u = await User.findOne({ email: req.body.email }).select('+passwordHash +failedLogins +lockedUntil');
    if (u?.lockedUntil && u.lockedUntil > new Date())
      throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed logins', { retryAfterSec: Math.ceil((+u.lockedUntil - Date.now()) / 1000) });
    if (!(await verifyPassword(req.body.password, u?.passwordHash))) {
      if (u) {
        const n = (u.failedLogins ?? 0) + 1; // 5 failures -> 15 min lock
        await User.updateOne({ _id: u._id }, n >= 5 ? { failedLogins: 0, lockedUntil: new Date(Date.now() + 15 * 60_000) } : { failedLogins: n });
      }
      throw new AppError(401, 'INVALID_CREDENTIALS');
    }
    if (u!.failedLogins || u!.lockedUntil) await User.updateOne({ _id: u!._id }, { failedLogins: 0, $unset: { lockedUntil: 1 } });
    if (u!.status === 'blocked') throw new AppError(403, 'ACCOUNT_BLOCKED');
    if (!['admin', 'host'].includes(u!.role)) throw new AppError(403, 'FORBIDDEN');
    setSession(res, await issueTokens(String(u!._id), u!.role));
    res.json(out(u));
  }));

// Panel calls this on load; if the access cookie expired, rotate the refresh cookie transparently.
r.get('/me', asyncHandler(async (req, res) => {
  let id: string | undefined;
  try { id = (jwt.verify(req.cookies?.[ACCESS_COOKIE] ?? '', env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as any).sub; } catch {}
  if (!id) {
    const rt = req.cookies?.[REFRESH_COOKIE];
    if (!rt) throw new AppError(401, 'UNAUTHORIZED');
    let t; try { t = await rotate(rt); } catch (e) { clearSession(res); throw e; }
    setSession(res, t);
    id = (jwt.decode(t.accessToken) as any).sub;
  }
  res.json(out(await panelUser(id!)));
}));

r.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  if (req.cookies?.[REFRESH_COOKIE]) await revoke(req.cookies[REFRESH_COOKIE]);
  clearSession(res);
  res.status(204).end();
}));
export default r;
