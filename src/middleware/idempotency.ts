import { AppError } from '../utils/errors';
import { IdempotencyKey } from './idempotency.model';

/**
 * Requires an Idempotency-Key header on money/seat-creating POSTs. The first response (status < 500) is stored for 24h
 * and replayed for retries with the same key; a key reused on a different route is rejected.
 */
export const requireIdempotencyKey = async (req: any, res: any, next: any) => {
  try {
    const key = req.get('Idempotency-Key');
    if (!key || !/^[A-Za-z0-9_\-:.]{8,128}$/.test(key)) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header (8-128 chars) required');
    const route = `${req.method} ${req.baseUrl}${req.path}`;
    let rec;
    try { rec = await IdempotencyKey.create({ userId: req.user.id, key, route }); }
    catch (e: any) {
      if (e?.code !== 11000) throw e;
      const prev = await IdempotencyKey.findOne({ userId: req.user.id, key });
      if (!prev) throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS');
      if (prev.route !== route) throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Key already used for a different request');
      if (prev.state !== 'done') throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Request with this key is still processing');
      res.set('Idempotent-Replayed', 'true');
      return res.status(prev.status!).json(prev.body);
    }
    const json = res.json.bind(res);
    res.json = (body: any) => {
      const done = res.statusCode < 500
        ? IdempotencyKey.updateOne({ _id: rec._id }, { state: 'done', status: res.statusCode, body })
        : IdempotencyKey.deleteOne({ _id: rec._id });
      done.then(() => json(body), () => json(body));
      return res;
    };
    next();
  } catch (e) { next(e); }
};
