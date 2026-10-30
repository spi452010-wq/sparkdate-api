import type { Gender, LiveStore, LobbyState, PresentUser } from './index';

/** In-process store (tests and single-process dev without Redis). Same semantics as RedisLiveStore. */
export class MemoryLiveStore implements LiveStore {
  waiting = new Map<string, Map<string, { g: Gender; t: number }>>(); prio = new Map<string, Set<string>>();
  grace = new Map<string, { token: string; until: number }>(); rounds = new Set<string>(); states = new Map<string, LobbyState>();
  private w(e: string) { let m = this.waiting.get(e); if (!m) this.waiting.set(e, (m = new Map())); return m; }
  async setPresent(e: string, u: string, g: Gender, now: number) { this.w(e).set(u, { g, t: now }); }
  async touch(e: string, u: string, now: number) { const x = this.w(e).get(u); if (x) x.t = now; return !!x; }
  async removePresent(e: string, u: string) { this.w(e).delete(u); }
  async present(e: string, since: number): Promise<PresentUser[]> {
    return [...this.w(e)].filter(([, v]) => v.t >= since).map(([userId, v]) => ({ userId, gender: v.g, lastSeen: v.t }));
  }
  async setPriority(e: string, users: string[]) { this.prio.set(e, new Set(users)); }
  async addPriority(e: string, u: string) { const s = this.prio.get(e) ?? new Set(); s.add(u); this.prio.set(e, s); }
  async priority(e: string) { return [...(this.prio.get(e) ?? [])]; }
  async setGrace(e: string, u: string, token: string, ttl: number) { this.grace.set(`${e}:${u}`, { token, until: Date.now() + ttl }); }
  async getGrace(e: string, u: string) { const g = this.grace.get(`${e}:${u}`); return g ? g.token : null; } // expiry is decided by the grace job, which compares tokens
  async delGrace(e: string, u: string) { this.grace.delete(`${e}:${u}`); }
  async claimRound(e: string, n: number) { const key = `${e}:${n}`; if (this.rounds.has(key)) return false; this.rounds.add(key); return true; }
  async setState(e: string, s: LobbyState) { this.states.set(e, s); }
  async getState(e: string) { return this.states.get(e) ?? null; }
  async close() { this.waiting.clear(); this.prio.clear(); this.grace.clear(); this.rounds.clear(); this.states.clear(); }
}
