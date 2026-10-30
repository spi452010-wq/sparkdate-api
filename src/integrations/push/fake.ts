import { NotificationSender, PushMessage } from './index';

/** Records pushes (tests). */
export class FakeNotificationSender implements NotificationSender {
  sent: PushMessage[] = [];
  async send(m: PushMessage) { this.sent.push(m); }
}
