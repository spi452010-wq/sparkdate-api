import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import crypto from 'crypto';
import { env } from '../../config/env';
import { requireAuth } from '../../middleware/auth';
import { asyncHandler, AppError } from '../../utils/errors';
import { storage, isValidKey } from './storage';
import { checkSig, signedUrl } from './signing';
import { User } from '../auth/user.model';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const single = (req: any, res: any, next: any) => upload.single('file')(req, res, (err: any) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'FILE_TOO_LARGE', 'Max 8 MB'));
  if (err) return next(new AppError(400, 'UPLOAD_INVALID'));
  next();
});

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

r.post('/photos', requireAuth, single, asyncHandler(async (req, res) => {
  res.status(201).json({ key: await save('photos', req.user.id, await processImage(req.file?.buffer)) });
}));
r.post('/selfie', requireAuth, single, asyncHandler(async (req, res) => {
  res.status(201).json({ key: await save('selfies', req.user.id, await processImage(req.file?.buffer)) });
}));

const send = (res: any, key: string) => {
  res.set('Cache-Control', 'private, max-age=300'); res.type('image/webp');
  if (env.USE_X_ACCEL === 'true') {
    const sub = key.startsWith('photos/') ? 'public' : 'private';
    return res.set('X-Accel-Redirect', `/protected-media/${sub}/${key}`).end();
  }
  res.sendFile(storage.absolutePath(key), (err: any) => { if (err && !res.headersSent) res.status(404).end(); });
};

// Owner can fetch own selfie with Bearer; admins get 5-min signed URLs from /admin/users (no cookie auth on media).
r.get('/selfies/me', requireAuth, asyncHandler(async (req, res) => {
  const u = await User.findById(req.user.id).select('verification.selfieKey');
  if (!u?.verification?.selfieKey) throw new AppError(404, 'NOT_FOUND');
  res.json({ url: signedUrl(u.verification.selfieKey) });
}));

// Photos: short-lived HMAC-signed URL issued by profile reads.
r.get('/:kind/:uid/:file', asyncHandler(async (req, res) => {
  const key = `${req.params.kind}/${req.params.uid}/${req.params.file}`;
  if (!isValidKey(key) || !checkSig(key, Number(req.query.exp), String(req.query.sig ?? ''))) throw new AppError(403, 'URL_EXPIRED_OR_INVALID');
  send(res, key);
}));
export default r;
