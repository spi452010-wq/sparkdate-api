import { registerHandler } from './queue';
import * as svc from '../modules/bookings/booking.service';
import { processWebhookEvent } from '../modules/webhooks/play.routes';

registerHandler('booking.expire', (d) => svc.expireBooking(d.bookingId));
registerHandler('payment.ack', (d) => svc.retryAck(d.paymentId));
registerHandler('refund.retry', (d) => svc.retryRefund(d.paymentId));
registerHandler('event.finalize', (d) => svc.finalizeEvent(d.eventId));
registerHandler('notify.reminder', (d) => svc.sendReminder(d));
registerHandler('notify.chatPassExpiring', (d) => svc.passExpiring(d));
registerHandler('voided.sync', () => svc.syncVoided());
registerHandler('webhook.process', (d) => processWebhookEvent(d.id));
