import { baseRepository } from '../../utils/repository';
import { WebhookEvent } from './webhookEvent.model';

export const webhookEventRepository = baseRepository(WebhookEvent);
