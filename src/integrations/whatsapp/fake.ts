import { OtpSender } from './index';

/** Captures OTPs instead of sending them (tests). */
export class FakeOtpSender implements OtpSender {
  sent: { phone: string; code: string }[] = [];
  async send(phone: string, code: string) { this.sent.push({ phone, code }); }
  lastCode(phone: string) { return [...this.sent].reverse().find((s) => s.phone === phone)?.code; }
}
