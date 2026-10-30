import crypto from 'crypto';
import { env } from '../../config/env';
const sig = (key: string, exp: number) => crypto.createHmac('sha256', env.MEDIA_URL_SECRET).update(`${key}:${exp}`).digest('base64url');
export const signedUrl = (key: string, ttlSec = key.startsWith('selfies/') ? 300 : env.MEDIA_URL_TTL_SEC) => {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${env.PUBLIC_BASE_URL}/api/v1/media/${key}?exp=${exp}&sig=${sig(key, exp)}`;
};
export const checkSig = (key: string, exp: number, s: string) => {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const a = Buffer.from(sig(key, exp)); const b = Buffer.from(s);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
