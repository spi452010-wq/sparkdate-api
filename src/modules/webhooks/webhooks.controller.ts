import { asyncHandler } from '../../utils/errors';
import * as svc from './webhooks.service';

export const playPush = asyncHandler(async (req, res) => {
  await svc.receivePlayPush(req.get('authorization'), req.body);
  res.status(204).end();
});
