import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { validate } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import { asyncHandler, AppError } from '../../utils/errors';
import { User } from '../auth/user.model';
import { Event } from '../events/event.model';
import { signedUrl } from '../media/signing';

const r = Router();
r.use(requireAuth, requireRole('admin'));
const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');

r.get('/users', validate(z.object({
  verification: z.enum(['none', 'pending', 'approved', 'rejected']).optional(),
  status: z.enum(['active', 'blocked']).optional(),
  q: z.string().trim().min(1).max(50).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}), 'query'), asyncHandler(async (req, res) => {
  const { verification, status, page, limit, q: search } = req.query as any;
  const q: any = {};
  if (search) { const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); q.$or = [{ 'profile.fullName': rx }, { phone: rx }, { email: rx }]; } if (verification) q['verification.status'] = verification; if (status) q.status = status;
  const [items, total] = await Promise.all([
    User.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('phone email role status profile profileCompleted verification createdAt'),
    User.countDocuments(q)]);
  res.json({ items: items.map((u: any) => ({ ...u.toObject(), id: String(u._id), profile: u.profile && { ...u.profile.toObject(), photos: (u.profile.photos ?? []).map((p: any) => ({ key: p.key, order: p.order, url: signedUrl(p.key) })) }, selfieUrl: u.verification?.selfieKey ? signedUrl(u.verification.selfieKey) : undefined })), page, limit, total });
}));

r.get('/stats', asyncHandler(async (_req, res) => {
  const [totalUsers, pendingVerifications, publishedEvents, liveEvents] = await Promise.all([
    User.countDocuments({ role: 'user' }), User.countDocuments({ 'verification.status': 'pending' }),
    Event.countDocuments({ status: 'published' }), Event.countDocuments({ status: 'live' })]);
  // Reports and refunds modules arrive in later sprints.
  res.json({ totalUsers, pendingVerifications, publishedEvents, liveEvents, openReports: 0, pendingRefunds: 0 });
}));

r.post('/users/:id/verification', validate(z.object({ id: objectId }), 'params'),
  validate(z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().max(200).optional() }).strict()),
  asyncHandler(async (req, res) => {
    const u = await User.findOneAndUpdate({ _id: req.params.id, 'verification.status': 'pending' },
      { 'verification.status': req.body.decision, 'verification.reason': req.body.reason, 'verification.reviewedBy': req.user.id, 'verification.reviewedAt': new Date() }, { new: true });
    if (!u) throw new AppError(404, 'NO_PENDING_VERIFICATION');
    res.json({ id: String(u._id), verification: u.verification });
  }));

r.post('/users/:id/status', validate(z.object({ id: objectId }), 'params'),
  validate(z.object({ status: z.enum(['active', 'blocked']) }).strict()), asyncHandler(async (req, res) => {
    if (req.params.id === req.user.id) throw new AppError(400, 'CANNOT_CHANGE_SELF');
    const u = await User.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
    if (!u) throw new AppError(404, 'NOT_FOUND');
    res.json({ id: String(u._id), status: u.status });
  }));
export default r;
