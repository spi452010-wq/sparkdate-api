import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import * as c from './admin.controller';
import * as v from './admin.validator';

const r = Router();
r.use(requireAuth, requireRole('admin'));
r.get('/users', validate(v.listUsersQuery, 'query'), c.listUsers);
r.get('/stats', c.stats);
r.post('/users/:id/verification', validate(v.idParams, 'params'), validate(v.verificationDecisionBody), c.decideVerification);
r.post('/users/:id/status', validate(v.idParams, 'params'), validate(v.userStatusBody), c.setUserStatus);
export default r;
