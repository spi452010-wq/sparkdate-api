import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import * as c from './events.controller';
import * as v from './events.validation';

export { appEvent, VISIBLE } from './event.mapper';

const r = Router();
const idParam = validate(v.idParams, 'params');
r.use(requireAuth);
r.get('/', validate(v.listQuery, 'query'), c.list);
r.get('/:id', idParam, c.detail);
for (const kind of ['like', 'save'] as const) {
  r.post(`/:id/${kind}`, idParam, c.react(kind, true));
  r.delete(`/:id/${kind}`, idParam, c.react(kind, false));
}
export default r;
