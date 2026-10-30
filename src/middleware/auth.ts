import crypto from 'crypto';
import jwt from 'jsonwebtoken';
export const ACCESS_COOKIE = 'sd_at';
export const REFRESH_COOKIE = 'sd_rt';
export const CSRF_COOKIE = 'csrf_token';
import { env } from '../config/env';
import { AppError } from '../utils/errors';
import { User } from '../modules/auth/user.model';

export type Role = 'user' | 'host' | 'admin';
export const requireAuth = async (req: any, _res: any, next: any) => {
  try {
    const h = req.headers.authorization as string | undefined;
    let token: string | undefined;
    if (h?.startsWith('Bearer ')) token = h.slice(7);
    else if (req.cookies?.[ACCESS_COOKIE] && String(req.baseUrl).startsWith('/api/v1/admin')) {
      token = req.cookies[ACCESS_COOKIE];
      // Cookie sessions: double-submit CSRF on every unsafe method.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const c = req.cookies?.[CSRF_COOKIE]; const x = req.get('X-CSRF-Token');
        if (!c || !x || c.length !== x.length || !crypto.timingSafeEqual(Buffer.from(c), Buffer.from(x))) throw new AppError(403, 'CSRF_INVALID');
      }
    }
    if (!token) throw new AppError(401, 'UNAUTHORIZED');
    let payload: any;
    try { payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }); }
    catch { throw new AppError(401, 'TOKEN_INVALID'); }
    const user = await User.findById(payload.sub).select('role status');
    if (!user) throw new AppError(401, 'UNAUTHORIZED');
    if (user.status === 'blocked') throw new AppError(403, 'ACCOUNT_BLOCKED');
    req.user = { id: String(user._id), role: user.role };
    next();
  } catch (e) { next(e); }
};
export const requireRole = (...roles: Role[]) => (req: any, _res: any, next: any) =>
  roles.includes(req.user?.role) ? next() : next(new AppError(403, 'FORBIDDEN'));
