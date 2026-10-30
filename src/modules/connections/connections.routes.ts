import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import * as c from './connections.controller';
import { listQuery } from './connections.validator';

/** /api/v1/connections: the caller's mutual connections (newest first). */
const r = Router();
r.use(requireAuth);
r.get('/', validate(listQuery, 'query'), c.list);
export default r;
