import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export interface OtpSender { send(phone: string, code: string): Promise<void>; }

class ConsoleSender implements OtpSender {
  async send(phone: string, code: string) { if (env.NODE_ENV !== 'test') logger.warn(`[DEV ONLY] OTP for ${phone}: ${code}`); }
}
class MetaCloudSender implements OtpSender {
  async send(phone: string, code: string) {
    const url = `https://graph.facebook.com/v20.0/${env.META_WA_PHONE_NUMBER_ID}/messages`;
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, {
        method: 'POST', signal: ctrl.signal,
        headers: { Authorization: `Bearer ${env.META_WA_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to: phone.replace('+', ''), type: 'template',
          template: { name: env.META_WA_TEMPLATE, language: { code: 'en' },
            components: [{ type: 'body', parameters: [{ type: 'text', text: code }] },
                         { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }] },
        }),
      });
      if (!r.ok) throw new Error(`WA status ${r.status}`);
    } catch (e) {
      logger.error({ err: String(e) }, 'whatsapp send failed');
      throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'Could not send OTP, please retry');
    } finally { clearTimeout(t); }
  }
}
export let otpSender: OtpSender = env.WHATSAPP_PROVIDER === 'meta' ? new MetaCloudSender() : new ConsoleSender();
export const setOtpSender = (s: OtpSender) => { otpSender = s; }; // for tests
