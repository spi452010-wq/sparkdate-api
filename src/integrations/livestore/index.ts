import { MemoryLiveStore } from './fake';

export type Gender = 'male' | 'female';
export interface PresentUser { userId: string; gender: Gender; lastSeen: number }
export interface LobbyState { round: number; status: 'lobby' | 'live' | 'break' | 'ended'; nextRoundAt: number | null }
/**
 * Ephemeral live-session state (presence, priority, reconnect grace, lobby state, round claims).
 * Redis in production so several API processes share it; in-memory in dev/tests. Durable facts
 * (dates, met pairs, decisions, connections) live in MongoDB, so a Redis restart only loses presence,
 * which clients rebuild by re-sending event:join on reconnect.
 */
export interface LiveStore {
  setPresent(e: string, u: string, g: Gender, now: number): Promise<void>;
  touch(e: string, u: string, now: number): Promise<boolean>;
  removePresent(e: string, u: string): Promise<void>;
  present(e: string, since: number): Promise<PresentUser[]>;
  setPriority(e: string, users: string[]): Promise<void>;
  addPriority(e: string, u: string): Promise<void>;
  priority(e: string): Promise<string[]>;
  setGrace(e: string, u: string, token: string, ttlMs: number): Promise<void>;
  getGrace(e: string, u: string): Promise<string | null>;
  delGrace(e: string, u: string): Promise<void>;
  /** True only for the first caller per (event, round): makes round.tick idempotent across processes. */
  claimRound(e: string, n: number): Promise<boolean>;
  setState(e: string, s: LobbyState): Promise<void>;
  getState(e: string): Promise<LobbyState | null>;
  close(): Promise<void>;
}

const k = (e: string, s: string) => `live:${e}:${s}`;
export class RedisLiveStore implements LiveStore {
  private r: any;
  constructor(redisUrl: string) { const IORedis = require('ioredis'); this.r = new IORedis(redisUrl); }
  async setPresent(e: string, u: string, g: Gender, now: number) {
    await this.r.multi().zrem(k(e, `waiting:${g === 'male' ? 'female' : 'male'}`), u).zadd(k(e, `waiting:${g}`), now, u).expire(k(e, `waiting:${g}`), 86400).exec();
  }
  async touch(e: string, u: string, now: number) {
    const r = await Promise.all(['male', 'female'].map((g) => this.r.zadd(k(e, `waiting:${g}`), 'XX', 'CH', now, u)));
    return r.some((x: number) => x > 0) || (await Promise.all(['male', 'female'].map((g) => this.r.zscore(k(e, `waiting:${g}`), u)))).some((x: any) => x !== null);
  }
  async removePresent(e: string, u: string) { await this.r.multi().zrem(k(e, 'waiting:male'), u).zrem(k(e, 'waiting:female'), u).exec(); }
  async present(e: string, since: number) {
    const out: PresentUser[] = [];
    for (const g of ['male', 'female'] as Gender[]) {
      const rows: string[] = await this.r.zrangebyscore(k(e, `waiting:${g}`), since, '+inf', 'WITHSCORES');
      for (let i = 0; i < rows.length; i += 2) out.push({ userId: rows[i], gender: g, lastSeen: Number(rows[i + 1]) });
    }
    return out;
  }
  async setPriority(e: string, users: string[]) {
    const m = this.r.multi().del(k(e, 'priority')); if (users.length) m.sadd(k(e, 'priority'), ...users).expire(k(e, 'priority'), 86400); await m.exec();
  }
  async addPriority(e: string, u: string) { await this.r.multi().sadd(k(e, 'priority'), u).expire(k(e, 'priority'), 86400).exec(); }
  async priority(e: string) { return this.r.smembers(k(e, 'priority')); }
  async setGrace(e: string, u: string, t: string, ttl: number) { await this.r.set(k(e, `grace:${u}`), t, 'PX', ttl); }
  async getGrace(e: string, u: string) { return this.r.get(k(e, `grace:${u}`)); }
  async delGrace(e: string, u: string) { await this.r.del(k(e, `grace:${u}`)); }
  async claimRound(e: string, n: number) { return (await this.r.set(k(e, `round:${n}`), '1', 'EX', 86400, 'NX')) === 'OK'; }
  async setState(e: string, s: LobbyState) { await this.r.set(k(e, 'state'), JSON.stringify(s), 'EX', 86400); }
  async getState(e: string) { const v = await this.r.get(k(e, 'state')); return v ? JSON.parse(v) : null; }
  async close() { await this.r.quit(); }
}

let store: LiveStore = new MemoryLiveStore();
export const getLiveStore = () => store;
/** Production wiring (server.ts) and test seam. */
export const setLiveStore = (s: LiveStore) => { store = s; };
