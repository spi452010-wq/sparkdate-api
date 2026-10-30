import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import * as c from './media.controller';

const r = Router();
r.post('/photos', requireAuth, c.single, c.uploadPhoto);
r.post('/selfie', requireAuth, c.single, c.uploadSelfie);
// Owner can fetch own selfie with Bearer; admins get 5-min signed URLs from /admin/users (no cookie auth on media).
r.get('/selfies/me', requireAuth, c.mySelfie);
// Photos: short-lived HMAC-signed URL issued by profile reads.
r.get('/:kind/:uid/:file', c.serveSigned);
export default r;
