import { registerHandler } from './queue';
import * as bookings from '../modules/bookings/bookings.service';
import * as payments from '../modules/payments/payments.service';
import * as refunds from '../modules/refunds/refunds.service';
import { processWebhookEvent } from '../modules/webhooks/webhooks.service';

registerHandler('booking.expire', (d) => bookings.expireBooking(d.bookingId));
registerHandler('payment.ack', (d) => payments.retryAck(d.paymentId));
registerHandler('refund.retry', (d) => payments.retryRefund(d.paymentId));
registerHandler('event.finalize', (d) => refunds.finalizeEvent(d.eventId));
registerHandler('notify.reminder', (d) => bookings.sendReminder(d));
registerHandler('notify.chatPassExpiring', (d) => payments.passExpiring(d));
registerHandler('voided.sync', () => payments.syncVoided());
registerHandler('webhook.process', (d) => processWebhookEvent(d.id));
