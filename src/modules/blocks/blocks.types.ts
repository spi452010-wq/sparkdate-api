import { z } from 'zod';
import { blockBody } from './blocks.validator';

export type BlockInput = z.infer<typeof blockBody>;
export const pairKey = (a: string, b: string) => (a < b ? `${a}_${b}` : `${b}_${a}`);
