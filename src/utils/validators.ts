import { z } from 'zod';
import { Types } from 'mongoose';

/** Shared zod primitives used by every module's <module>.validator.ts. */
export const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');
