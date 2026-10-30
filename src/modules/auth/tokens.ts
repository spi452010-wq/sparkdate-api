import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { RefreshToken } from './refreshToken.model';
import { AppError } from '../../utils/errors';

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function issueTokens(userId: string, role: string, family: string = crypto.randomUUID()) {
  const accessToken = jwt.sign({ sub: userId, role }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: env.ACCESS_TOKEN_TTL as any });
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  await RefreshToken.create({ user: userId, tokenHash: sha256(refreshToken), family,
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000) });
  return { accessToken, refreshToken };
}

export async function rotate(refreshToken: string) {
  const hash = sha256(refreshToken);
  const doc = await RefreshToken.findOne({ tokenHash: hash }).populate<{ user: any }>('user', 'role status');
  if (!doc || doc.expiresAt < new Date()) throw new AppError(401, 'REFRESH_INVALID');
  if (doc.revokedAt) {
    // Reuse of a rotated token: assume theft, revoke the whole chain.
    await RefreshToken.updateMany({ family: doc.family, revokedAt: null }, { revokedAt: new Date() });
    throw new AppError(401, 'REFRESH_REUSED');
  }
  if (!doc.user || doc.user.status === 'blocked') throw new AppError(401, 'REFRESH_INVALID');
  // Atomic claim so two parallel refreshes can't both succeed.
  const claimed = await RefreshToken.findOneAndUpdate({ _id: doc._id, revokedAt: null }, { revokedAt: new Date() });
  if (!claimed) throw new AppError(401, 'REFRESH_REUSED');
  return issueTokens(String(doc.user._id), doc.user.role, doc.family);
}

export async function revoke(refreshToken: string) {
  const doc = await RefreshToken.findOne({ tokenHash: sha256(refreshToken) });
  if (doc) await RefreshToken.updateMany({ family: doc.family, revokedAt: null }, { revokedAt: new Date() });
}
