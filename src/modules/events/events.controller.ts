import { asyncHandler } from '../../utils/errors';
import * as svc from './events.service';

export const list = asyncHandler(async (req, res) => {
  const out = await svc.listEvents(req.user.id, req.query);
  res.set('Cache-Control', 'private, max-age=60');
  res.json(out);
});
export const detail = asyncHandler(async (req, res) => { res.json(await svc.eventDetail(req.user.id, req.params.id)); });
export const react = (kind: 'like' | 'save', on: boolean) => asyncHandler(async (req, res) => {
  if (on) await svc.addReaction(req.user.id, req.params.id, kind); else await svc.removeReaction(req.user.id, req.params.id, kind);
  res.json({ [kind === 'like' ? 'liked' : 'saved']: on });
});
