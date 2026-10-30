import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
export const errorHandler = (err: any, _req: any, res: any, _next: any) => {
  if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON' } });
  logger.error({ err }, 'unhandled');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
};
