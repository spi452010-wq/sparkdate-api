import { asyncHandler } from '../../utils/errors';
import * as svc from './live.service';

export const time = asyncHandler(async (_req, res) => { res.set('Cache-Control', 'no-store').json(svc.serverTime()); });
