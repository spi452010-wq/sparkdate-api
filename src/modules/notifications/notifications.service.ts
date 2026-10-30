import { Notification } from './notification.model';

export async function list(userId: string, before: Date | undefined, limit: number) {
  const items = await Notification.find({ userId, ...(before ? { createdAt: { $lt: before } } : {}) }).sort({ createdAt: -1 }).limit(limit);
  return { items: items.map((n) => ({ id: String(n._id), type: n.type, title: n.title, body: n.body, data: n.data, read: !!n.readAt, createdAt: n.createdAt })) };
}
export async function markRead(userId: string, ids?: string[]) {
  const f: any = { userId, readAt: { $exists: false } }; if (ids) f._id = { $in: ids };
  const r = await Notification.updateMany(f, { readAt: new Date() });
  return { updated: r.modifiedCount };
}
