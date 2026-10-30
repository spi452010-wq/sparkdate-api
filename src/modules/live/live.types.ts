import { z } from 'zod';
import { decisionPayload, eventPayload, sparkPayload } from './live.validator';

export type EventPayload = z.infer<typeof eventPayload>;
export type DecisionPayload = z.infer<typeof decisionPayload>;
export type SparkPayload = z.infer<typeof sparkPayload>;
export type Decision = DecisionPayload['decision'];
export type LeftReason = 'disconnect' | 'left';
export interface Ack { ok: boolean; error?: string; [k: string]: unknown }

/** Server -> client fan-out. The gateway implements it over Socket.IO rooms (`user:{id}`, `event:{id}`). */
export interface LiveEmitter {
  toUser(userId: string, ev: string, data: unknown): void;
  toEvent(eventId: string, ev: string, data: unknown): void;
  /** True if the user still has at least one socket connected (any process). */
  isOnline(userId: string): Promise<boolean>;
}

/** Matching input: one present user. */
export interface Candidate {
  id: string; gender: 'male' | 'female'; interests: string[];
  city?: string | null; interestedCity?: string | null; profession?: string | null;
}
export interface MatchInput {
  users: Candidate[];
  /** pairKey()s already met this event (never re-paired). */
  met: Set<string>;
  /** pairKey()s blocked either way. */
  blocked: Set<string>;
  /** Users who sat out (or lost their partner) last round: paired first. */
  priority: Set<string>;
}
export interface MatchResult { pairs: [string, string][]; unmatched: string[] }
