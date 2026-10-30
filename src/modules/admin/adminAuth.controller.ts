import crypto from 'crypto';
import { env } from '../../config/env';
import { ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE } from '../../middleware/auth';
import { asyncHandler, AppError } from '../../utils/errors';
import * as svc from './adminAuth.service';

const secure = env.NODE_ENV === 'production';
const base = { httpOnly: true, secure, sameSite: 'strict' as const };
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

export const login = asyncHandler(async (req, res) => {
  const { user, tokens } = await svc.login(req.body.email, req.body.password);
  setSession(res, tokens);
  res.json(user);
});

// Panel calls this on load; if the access cookie expired, rotate the refresh cookie transparently.
export const me = asyncHandler(async (req, res) => {
  let id = svc.accessTokenSubject(req.cookies?.[ACCESS_COOKIE]);
  if (!id) {
    const rt = req.cookies?.[REFRESH_COOKIE];
    if (!rt) throw new AppError(401, 'UNAUTHORIZED');
    let t; try { t = await svc.rotateRefresh(rt); } catch (e) { clearSession(res); throw e; }
    setSession(res, t);
    id = svc.subjectOf(t.accessToken);
  }
  res.json(await svc.me(id!));
});

export const logout = asyncHandler(async (req, res) => {
  await svc.logout(req.cookies?.[REFRESH_COOKIE]);
  clearSession(res);
  res.status(204).end();
});
