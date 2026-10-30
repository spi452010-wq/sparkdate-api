import { asyncHandler } from '../../utils/errors';
import * as svc from './profile.service';

export const getMe = asyncHandler(async (req, res) => { res.json(await svc.getMe(req.user.id)); });
export const complete = asyncHandler(async (req, res) => { res.json(await svc.completeProfile(req.user.id, req.body)); });
export const update = asyncHandler(async (req, res) => { res.json(await svc.updateProfile(req.user.id, req.body)); });
export const submitVerification = asyncHandler(async (req, res) => { res.status(202).json(await svc.submitVerification(req.user.id, req.body.selfieKey)); });
// Gate for later modules (events, booking): profile complete required.
export const requireCompletedProfile = asyncHandler(async (req, _res, next) => { await svc.assertProfileCompleted(req.user.id); next(); });
