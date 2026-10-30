import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import * as c from './notifications.controller';
import { listQuery, readBody } from './notifications.validation';

/** /api/v1/notifications (in-app list) */
export const notifications = Router();
notifications.use(requireAuth);
notifications.get('/', validate(listQuery, 'query'), c.list);
notifications.post('/read', validate(readBody), c.markRead);
