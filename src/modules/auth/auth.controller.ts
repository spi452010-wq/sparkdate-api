import { asyncHandler } from '../../utils/errors';
import * as svc from './auth.service';

export const otpRequest = asyncHandler(async (req, res) => { res.json(await svc.requestOtp(req.body.phone)); });
export const otpVerify = asyncHandler(async (req, res) => { res.json(await svc.loginWithOtp(req.body.phone, req.body.code)); });
export const google = asyncHandler(async (req, res) => { res.json(await svc.loginWithGoogle(req.body.idToken)); });
export const refresh = asyncHandler(async (req, res) => { res.json(await svc.refresh(req.body.refreshToken)); });
export const logout = asyncHandler(async (req, res) => { await svc.logout(req.body.refreshToken); res.status(204).end(); });
