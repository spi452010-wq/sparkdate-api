import { ZodSchema } from 'zod';
import { AppError } from '../utils/errors';
export const validate = (schema: ZodSchema, part: 'body' | 'query' | 'params' = 'body') => (req: any, _res: any, next: any) => {
  const r = schema.safeParse(req[part]);
  if (!r.success) return next(new AppError(400, 'VALIDATION_ERROR', 'Invalid request', r.error.flatten()));
  if (part === 'query') Object.defineProperty(req, 'query', { value: r.data, writable: true }); else req[part] = r.data;
  next();
};
