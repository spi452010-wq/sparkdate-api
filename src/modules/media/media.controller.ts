import multer from 'multer';
import { env } from '../../config/env';
import { asyncHandler, AppError } from '../../utils/errors';
import { MAX_UPLOAD_BYTES } from './media.validator';
import * as svc from './media.service';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
export const single = (req: any, res: any, next: any) => upload.single('file')(req, res, (err: any) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'FILE_TOO_LARGE', 'Max 8 MB'));
  if (err) return next(new AppError(400, 'UPLOAD_INVALID'));
  next();
});

export const uploadPhoto = asyncHandler(async (req, res) => { res.status(201).json(await svc.uploadImage('photos', req.user.id, req.file?.buffer)); });
export const uploadSelfie = asyncHandler(async (req, res) => { res.status(201).json(await svc.uploadImage('selfies', req.user.id, req.file?.buffer)); });
export const mySelfie = asyncHandler(async (req, res) => { res.json(await svc.ownSelfieUrl(req.user.id)); });

const send = (res: any, key: string) => {
  res.set('Cache-Control', 'private, max-age=300'); res.type('image/webp');
  if (env.USE_X_ACCEL === 'true') {
    const sub = key.startsWith('photos/') ? 'public' : 'private';
    return res.set('X-Accel-Redirect', `/protected-media/${sub}/${key}`).end();
  }
  res.sendFile(svc.absolutePath(key), (err: any) => { if (err && !res.headersSent) res.status(404).end(); });
};
export const serveSigned = asyncHandler(async (req, res) => {
  send(res, svc.resolveSignedKey(req.params.kind, req.params.uid, req.params.file, Number(req.query.exp), String(req.query.sig ?? '')));
});
