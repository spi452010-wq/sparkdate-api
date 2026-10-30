import { asyncHandler } from '../../utils/errors';
import * as svc from './connections.service';

export const list = asyncHandler(async (req, res) => {
  const { before, limit } = req.query as any;
  res.json(await svc.listMine(req.user.id, before, limit));
});
