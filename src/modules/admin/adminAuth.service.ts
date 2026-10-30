import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import { User } from '../auth/user.model';
import { verifyPassword } from '../auth/password';
import { issueTokens, rotate, revoke } from '../auth/tokens';

export const adminOut = (u: any) => ({ id: String(u._id), email: u.email, role: u.role, fullName: u.profile?.fullName });

export async function panelUser(id: string) {
  const u = await User.findById(id);
  if (!u || u.status === 'blocked') throw new AppError(403, 'ACCOUNT_BLOCKED');
  if (!['admin', 'host'].includes(u.role)) throw new AppError(403, 'FORBIDDEN');
  return u;
}

/** Password login with lockout (5 failures -> 15 min). Returns the user and fresh tokens. */
export async function login(email: string, password: string) {
  const u = await User.findOne({ email }).select('+passwordHash +failedLogins +lockedUntil');
  if (u?.lockedUntil && u.lockedUntil > new Date())
    throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed logins', { retryAfterSec: Math.ceil((+u.lockedUntil - Date.now()) / 1000) });
  if (!(await verifyPassword(password, u?.passwordHash))) {
    if (u) {
      const n = (u.failedLogins ?? 0) + 1;
      await User.updateOne({ _id: u._id }, n >= 5 ? { failedLogins: 0, lockedUntil: new Date(Date.now() + 15 * 60_000) } : { failedLogins: n });
    }
    throw new AppError(401, 'INVALID_CREDENTIALS');
  }
  if (u!.failedLogins || u!.lockedUntil) await User.updateOne({ _id: u!._id }, { failedLogins: 0, $unset: { lockedUntil: 1 } });
  if (u!.status === 'blocked') throw new AppError(403, 'ACCOUNT_BLOCKED');
  if (!['admin', 'host'].includes(u!.role)) throw new AppError(403, 'FORBIDDEN');
  return { user: adminOut(u), tokens: await issueTokens(String(u!._id), u!.role) };
}

export function accessTokenSubject(token?: string): string | undefined {
  try { return (jwt.verify(token ?? '', env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as any).sub; } catch { return undefined; }
}
export const rotateRefresh = (rt: string) => rotate(rt);
export const subjectOf = (accessToken: string) => (jwt.decode(accessToken) as any).sub as string;
export const me = async (id: string) => adminOut(await panelUser(id));
export const logout = async (rt?: string) => { if (rt) await revoke(rt); };
