import { z } from 'zod';
import { objectId } from '../../utils/validators';

/** Socket payloads (validated in the gateway; unknown keys rejected). */
export const eventPayload = z.object({ eventId: objectId }).strict();
export const decisionPayload = z.object({ dateId: objectId, decision: z.enum(['like', 'pass', 'save']) }).strict();
export const dateLeavePayload = z.object({ dateId: objectId }).strict();
export const sparkPayload = z.object({ dateId: objectId }).strict();
export const pingPayload = z.object({ eventId: objectId.optional() }).strict();
