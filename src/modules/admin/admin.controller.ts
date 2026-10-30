import { asyncHandler } from '../../utils/errors';
import * as svc from './admin.service';
import { adminUserBookings } from '../bookings/bookings.service';

export const listUsers = asyncHandler(async (req, res) => { res.json(await svc.listUsers(req.query)); });
export const userBookings = asyncHandler(async (req, res) => { res.json(await adminUserBookings(String(req.params.id), req.query as any)); });
export const stats = asyncHandler(async (_req, res) => { res.json(await svc.stats()); });
export const decideVerification = asyncHandler(async (req, res) => { res.json(await svc.decideVerification(req.params.id, req.user.id, req.body.decision, req.body.reason)); });
export const setUserStatus = asyncHandler(async (req, res) => { res.json(await svc.setUserStatus(req.params.id, req.user.id, req.body.status)); });
