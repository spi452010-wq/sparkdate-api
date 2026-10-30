import { z } from 'zod';
import { listQuery } from './connections.validator';

export type ConnectionListQuery = z.infer<typeof listQuery>;
export interface MutualResult { connectionId: string; created: boolean }
