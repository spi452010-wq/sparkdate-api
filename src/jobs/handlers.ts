import { registerHandler } from './queue';
import * as bookings from '../modules/bookings/bookings.service';
import * as payments from '../modules/payments/payments.service';
import * as refunds from '../modules/refunds/refunds.service';
import * as live from '../modules/live/live.service';
import { processWebhookEvent } from '../modules/webhooks/webhooks.service';

registerHandler('booking.expire', (d) => bookings.expireBooking(d.bookingId));
registerHandler('payment.ack', (d) => payments.retryAck(d.paymentId));
registerHandler('payment.reconcile', async (d) => { await payments.reconcileUnlinked(d.paymentId); });
registerHandler('refund.retry', (d) => payments.retryRefund(d.paymentId));
registerHandler('event.finalize', (d) => refunds.finalizeEvent(d.eventId));
registerHandler('notify.reminder', (d) => bookings.sendReminder(d));
registerHandler('notify.chatPassExpiring', (d) => payments.passExpiring(d));
registerHandler('voided.sync', () => payments.syncVoided());
registerHandler('webhook.process', (d) => processWebhookEvent(d.id));
// Sprint 3: live session timeline
registerHandler('event.open', (d) => live.eventOpen(d));
registerHandler('event.start', (d) => live.eventStart(d));
registerHandler('event.end', (d) => live.eventEnd(d));
registerHandler('round.tick', (d) => live.roundTick(d));
registerHandler('round.end', (d) => live.roundEnd(d));
registerHandler('round.decide', (d) => live.roundDecide(d));
registerHandler('live.grace', (d) => live.graceExpired(d));
