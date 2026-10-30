import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import * as c from './adminEvents.controller';
import * as v from './adminEvents.validation';

const r = Router();
const idParam = validate(v.idParams, 'params');
r.use(requireAuth, requireRole('admin', 'host'));
r.get('/', validate(v.listQuery, 'query'), c.list);
r.get('/:id', idParam, c.get);
r.post('/', validate(v.createSchema), c.create);
r.patch('/:id', idParam, validate(v.patchSchema), c.update);
r.get('/:id/bookings', idParam, c.bookings);
export default r;
