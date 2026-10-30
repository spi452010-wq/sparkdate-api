import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import * as c from './profile.controller';
import * as v from './profile.validator';


const r = Router();
r.use(requireAuth);
r.get('/me', c.getMe);
r.put('/me', validate(v.completeSchema), c.complete);
r.patch('/me', validate(v.updateSchema), c.update);
r.post('/me/verification', validate(v.verificationSchema), c.submitVerification);
export default r;
