import { Router } from 'express';
import * as c from './live.controller';

/** /api/v1/live: REST side of the live session (the session itself is the Socket.IO namespace /live, see live.gateway.ts). */
const r = Router();
r.get('/time', c.time);
export default r;
