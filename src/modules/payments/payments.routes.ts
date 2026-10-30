import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { requireIdempotencyKey } from '../../middleware/idempotency';
import * as c from './payments.controller';
import { verifyBody } from './payments.validator';

export const payments = Router();
payments.use(requireAuth);
payments.post('/play/verify', requireIdempotencyKey, validate(verifyBody), c.verify);

export const subscriptions = Router();
subscriptions.use(requireAuth);
subscriptions.get('/me', c.mySubscription);
