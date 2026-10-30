import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import * as c from './refunds.controller';
import { bookingIdParams, idParams, paymentsQuery, refundsQuery, rejectBody } from './refunds.validator';

// Money operations are admin-only (hosts cannot refund or cancel paid events).
const r = Router();
r.use(requireAuth, requireRole('admin'));
r.get('/refunds', validate(refundsQuery, 'query'), c.listRefunds);
r.post('/refunds/:bookingId/approve', validate(bookingIdParams, 'params'), c.approve);
r.post('/refunds/:bookingId/reject', validate(bookingIdParams, 'params'), validate(rejectBody), c.reject);
r.get('/payments', validate(paymentsQuery, 'query'), c.listPayments);
r.post('/events/:id/cancel', validate(idParams, 'params'), c.cancelEvent);
export default r;
