import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { requireIdempotencyKey } from '../../middleware/idempotency';
import * as c from './bookings.controller';
import { createBookingBody, idParams, refundRequestBody } from './bookings.validation';

export { bookingOut } from './booking.mapper'; // back-compat
export { notifications } from '../notifications/notifications.routes'; // back-compat

/** /api/v1/bookings */
export const bookings = Router();
bookings.use(requireAuth);
bookings.post('/', requireIdempotencyKey, validate(createBookingBody), c.create);
bookings.delete('/:id', validate(idParams, 'params'), c.cancel);
bookings.post('/:id/refund-request', validate(idParams, 'params'), requireIdempotencyKey, validate(refundRequestBody), c.refundRequest);

/** /api/v1/me */
export const me = Router();
me.use(requireAuth);
me.get('/bookings', c.myBookings);
me.get('/events/saved', c.savedEvents);
