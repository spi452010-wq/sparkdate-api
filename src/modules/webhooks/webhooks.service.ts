import { env } from '../../config/env';
import { verifyPubsubToken } from '../../integrations/pubsub';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { getQueue, jobId } from '../../jobs/queue';
import { pushSchema } from './webhooks.validator';
import { onOneTimeRtdn, onSubscriptionRtdn, onVoided } from '../payments/payments.service';
import { webhookEventRepository } from './webhooks.repository';

/** Authenticates and stores a Play RTDN push; enqueues processing. Duplicate deliveries are no-ops. */
export async function receivePlayPush(authorization: string | undefined, body: unknown) {
  if (!authorization?.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHORIZED');
  try { await verifyPubsubToken(authorization.slice(7)); } catch (err) { logger.warn({ err }, 'pubsub auth failed'); throw new AppError(401, 'UNAUTHORIZED'); }
  const parsed = pushSchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR');
  const { data, messageId } = parsed.data.message;
  let payload: any = null; let status: 'received' | 'ignored' = 'received';
  try { payload = JSON.parse(Buffer.from(data, 'base64').toString('utf8')); } catch { status = 'ignored'; }
  if (payload && env.PLAY_PACKAGE_NAME && payload.packageName !== env.PLAY_PACKAGE_NAME) status = 'ignored';
  let w;
  try { w = await webhookEventRepository.create({ source: 'play', messageId, payload, status }); }
  catch (e: any) { if (e?.code === 11000) return; throw e; } // duplicate delivery
  if (status === 'received') await getQueue().add('webhook.process', { id: String(w._id) }, { jobId: jobId('wh', String(w._id)) });
}

export async function processWebhookEvent(id: string) {
  // Claim atomically so concurrent workers never process the same message twice.
  const w = await webhookEventRepository.findOneAndUpdate({ _id: id, status: 'received' }, { $set: { status: 'failed', error: 'processing' } }, { new: true });
  if (!w) return;
  const n = w.payload ?? {};
  try {
    let out: string = 'ignored';
    if (n.subscriptionNotification?.purchaseToken) out = await onSubscriptionRtdn(n.subscriptionNotification.purchaseToken);
    else if (n.oneTimeProductNotification?.purchaseToken) out = await onOneTimeRtdn(n.oneTimeProductNotification);
    else if (n.voidedPurchaseNotification?.purchaseToken) out = await onVoided(n.voidedPurchaseNotification.purchaseToken);
    await webhookEventRepository.updateOne({ _id: w._id }, { $set: { status: out === 'processed' ? 'processed' : 'ignored', processedAt: new Date() }, $unset: { error: 1 } });
  } catch (e: any) {
    if (e instanceof AppError && e.status < 500) { await webhookEventRepository.updateOne({ _id: w._id }, { status: 'failed', error: e.code }); return; }
    await webhookEventRepository.updateOne({ _id: w._id }, { status: 'received', error: String(e?.code ?? 'error') }); // let the queue retry
    throw e;
  }
}
