import { z } from 'zod';
import { createSchema, listQuery as adminEvents_listQuery, patchSchema } from './adminEvents.validator';
import { listQuery as events_listQuery } from './events.validator';

/** DTOs and interfaces of the events module. Input DTOs are inferred from the zod schemas in the validators. */
export type EventListQuery = z.infer<typeof events_listQuery>;
export type CreateEventInput = z.infer<typeof createSchema>;
export type PatchEventInput = z.infer<typeof patchSchema>;
export type AdminEventListQuery = z.infer<typeof adminEvents_listQuery>;
/** Caller of an admin events operation (admin or owning host). */
export type Actor = { id: string; role: string };
