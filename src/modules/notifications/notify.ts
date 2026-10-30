import { Notification } from './notification.model';
import { logger } from '../../utils/logger';

export interface PushMessage { userId: string; type: string; title: string; body: string; data?: Record<string, string> }
/** Push transport. TODO: FCM implementation using FCM_SA_JSON_PATH (firebase-admin) and users.fcmTokens. */
export interface NotificationSender { send(m: PushMessage): Promise<void> }
class LogSender implements NotificationSender { async send(m: PushMessage) { logger.debug({ type: m.type, userId: m.userId }, 'push (stub)'); } }
let sender: NotificationSender = new LogSender();
export const setNotificationSender = (s: NotificationSender) => { sender = s; };

/** Stores an in-app notification (deduped by key) and pushes it. Push failures never break the caller. */
export async function notify(m: PushMessage & { dedupeKey?: string }) {
  try { await Notification.create({ userId: m.userId, type: m.type, title: m.title, body: m.body, data: m.data ?? {}, dedupeKey: m.dedupeKey }); }
  catch (e: any) { if (e?.code === 11000) return; throw e; }
  await sender.send(m).catch((err) => logger.warn({ err, type: m.type }, 'push failed'));
}
