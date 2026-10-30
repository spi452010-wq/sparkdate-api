import { asyncHandler } from '../../utils/errors';
import * as svc from './notifications.service';

export const list = asyncHandler(async (req, res) => {
  const { before, limit } = req.query as any;
  res.json(await svc.list(req.user.id, before, limit));
});
export const markRead = asyncHandler(async (req, res) => { res.json(await svc.markRead(req.user.id, req.body.ids)); });
