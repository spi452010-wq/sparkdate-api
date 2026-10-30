import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import * as c from './blocks.controller';
import { blockBody, blockParams } from './blocks.validator';

/** /api/v1/blocks: block / unblock a user (excluded from live matching both ways). */
const r = Router();
r.use(requireAuth);
r.post('/', validate(blockBody), c.block);
r.delete('/:userId', validate(blockParams, 'params'), c.unblock);
export default r;
