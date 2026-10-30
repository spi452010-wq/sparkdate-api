import { z } from 'zod';
import { objectId } from '../../utils/validators';

export const blockBody = z.object({ userId: objectId }).strict();
export const blockParams = z.object({ userId: objectId });
