// Back-compat shim: tests and jobs import these names from here.
export { default } from './webhooks.routes';
export { setPubsubVerifier, processWebhookEvent } from './webhooks.service';
export type { PubsubVerifier } from './webhooks.service';
