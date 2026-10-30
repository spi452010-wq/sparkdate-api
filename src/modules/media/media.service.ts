import sharp from 'sharp';
import crypto from 'crypto';
import { AppError } from '../../utils/errors';
import { storage, isValidKey } from './storage';
import { checkSig, signedUrl } from './signing';
import { User } from '../auth/user.model';

async function processImage(buf?: Buffer) {
  if (!buf?.length) throw new AppError(400, 'FILE_REQUIRED');
  let meta;
  try { meta = await sharp(buf).metadata(); } catch { throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE'); }
  // Real decoded format, not the filename or client Content-Type.
  if (!['jpeg', 'png', 'webp'].includes(meta.format ?? '')) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE');
  // Re-encode: strips EXIF/GPS (sharp drops metadata unless asked), fixes rotation, caps size.
  return sharp(buf, { limitInputPixels: 40_000_000 }).rotate().resize(1440, 1440, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
}

async function save(kind: 'photos' | 'selfies', userId: string, buf: Buffer) {
  const key = `${kind}/${userId}/${crypto.randomUUID()}.webp`;
  try { await storage.put(key, buf); }
  catch (e: any) { throw new AppError(e?.code === 'ENOSPC' ? 507 : 500, e?.code === 'ENOSPC' ? 'STORAGE_FULL' : 'STORAGE_ERROR'); }
  return key;
}

export async function uploadImage(kind: 'photos' | 'selfies', userId: string, buf?: Buffer) {
  return { key: await save(kind, userId, await processImage(buf)) };
}

export async function ownSelfieUrl(userId: string) {
  const u = await User.findById(userId).select('verification.selfieKey');
  if (!u?.verification?.selfieKey) throw new AppError(404, 'NOT_FOUND');
  return { url: signedUrl(u.verification.selfieKey) };
}

/** Validates a signed media URL and returns the storage key. */
export function resolveSignedKey(kind: string, uid: string, file: string, exp: number, sig: string) {
  const key = `${kind}/${uid}/${file}`;
  if (!isValidKey(key) || !checkSig(key, exp, sig)) throw new AppError(403, 'URL_EXPIRED_OR_INVALID');
  return key;
}
export const absolutePath = (key: string) => storage.absolutePath(key);
