import { logger } from '../../utils/logger';
import { getNotificationSender, PushMessage } from '../../integrations/push';
import { notificationRepository } from './notifications.repository';

export async function list(userId: string, before: Date | undefined, limit: number) {
  const items = await notificationRepository.find({ userId, ...(before ? { createdAt: { $lt: before } } : {}) }).sort({ createdAt: -1 }).limit(limit);
  return { items: items.map((n) => ({ id: String(n._id), type: n.type, title: n.title, body: n.body, data: n.data, read: !!n.readAt, createdAt: n.createdAt })) };
}
export async function markRead(userId: string, ids?: string[]) {
  const f: any = { userId, readAt: { $exists: false } }; if (ids) f._id = { $in: ids };
  const r = await notificationRepository.updateMany(f, { readAt: new Date() });
  return { updated: r.modifiedCount };
}

/** Stores an in-app notification (deduped by key) and pushes it. Push failures never break the caller. */
export async function notify(m: PushMessage & { dedupeKey?: string }) {
  try { await notificationRepository.create({ userId: m.userId, type: m.type, title: m.title, body: m.body, data: m.data ?? {}, dedupeKey: m.dedupeKey }); }
  catch (e: any) { if (e?.code === 11000) return; throw e; }
  await getNotificationSender().send(m).catch((err) => logger.warn({ err, type: m.type }, 'push failed'));
}
