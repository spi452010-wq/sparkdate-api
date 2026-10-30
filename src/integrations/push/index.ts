import { logger } from '../../utils/logger';

export interface PushMessage { userId: string; type: string; title: string; body: string; data?: Record<string, string> }
/** Push transport. TODO: FCM implementation using FCM_SA_JSON_PATH (firebase-admin) and users.fcmTokens. */
export interface NotificationSender { send(m: PushMessage): Promise<void> }

class LogSender implements NotificationSender { async send(m: PushMessage) { logger.debug({ type: m.type, userId: m.userId }, 'push (stub)'); } }

let sender: NotificationSender = new LogSender();
export const getNotificationSender = () => sender;
/** Test seam. */
export const setNotificationSender = (s: NotificationSender) => { sender = s; };
