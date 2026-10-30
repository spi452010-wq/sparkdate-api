import { asyncHandler } from '../../utils/errors';
import * as svc from './payments.service';

export const verify = asyncHandler(async (req, res) => {
  const r = await svc.verifyPurchase(req.user.id, req.body);
  res.status(r.status === 'pending' ? 202 : 200).json(r);
});
export const mySubscription = asyncHandler(async (req, res) => { res.json(await svc.chatPassStatus(req.user.id)); });
