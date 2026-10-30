import { Router } from 'express';
import * as c from './webhooks.controller';

// Auth is the Pub/Sub OIDC token, checked in the service (no user auth here).
const r = Router();
r.post('/play', c.playPush);
export default r;
