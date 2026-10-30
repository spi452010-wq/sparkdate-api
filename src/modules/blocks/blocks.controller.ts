import { asyncHandler } from '../../utils/errors';
import * as svc from './blocks.service';

export const block = asyncHandler(async (req, res) => { res.json(await svc.block(req.user.id, req.body.userId)); });
export const unblock = asyncHandler(async (req, res) => { res.json(await svc.unblock(req.user.id, req.params.userId)); });
