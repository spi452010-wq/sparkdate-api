import { asyncHandler } from '../../utils/errors';
import * as svc from './adminEvents.service';

export const list = asyncHandler(async (req, res) => { res.json(await svc.list(req.user, req.query)); });
export const get = asyncHandler(async (req, res) => { res.json(await svc.get(req.user, req.params.id)); });
export const create = asyncHandler(async (req, res) => { res.status(201).json(await svc.create(req.user, req.body)); });
export const update = asyncHandler(async (req, res) => { res.json(await svc.update(req.user, req.params.id, req.body)); });
export const bookings = asyncHandler(async (req, res) => { res.json(await svc.listBookings(req.user, req.params.id)); });
