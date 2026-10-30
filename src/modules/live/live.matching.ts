import { pairKey } from '../blocks/blocks.service';
import { Candidate, MatchInput, MatchResult } from './live.types';

const norm = (s?: string | null) => (s ?? '').trim().toLowerCase();
/** Shared interests + interestedCity match (falls back to same city) + profession overlap. */
export function score(a: Candidate, b: Candidate): number {
  const ai = new Set(a.interests.map(norm)); let s = 0;
  for (const i of new Set(b.interests.map(norm))) if (i && ai.has(i)) s++;
  const cityOk = (x: Candidate, y: Candidate) => !!norm(y.city) && norm(x.interestedCity || x.city) === norm(y.city);
  if (cityOk(a, b) || cityOk(b, a)) s++;
  if (norm(a.profession) && norm(a.profession) === norm(b.profession)) s++;
  return s;
}

/**
 * Pure, deterministic round matching (male x female). Never pairs users who already met or blocked each other.
 * Greedy best-first: candidate edges sorted by (number of priority users in the pair, score, stable key), taken
 * when both ends are free, then augmented to a maximum matching. O(M*F log(M*F)) + O(V*E); 150x150 = 22.5k edges.
 */
export function matchRound({ users, met, blocked, priority }: MatchInput): MatchResult {
  const seen = new Set<string>(); const uniq = users.filter((u) => !seen.has(u.id) && seen.add(u.id));
  const males = uniq.filter((u) => u.gender === 'male'); const females = uniq.filter((u) => u.gender === 'female');
  const edges: { a: string; b: string; p: number; s: number; k: string }[] = [];
  for (const m of males) for (const f of females) {
    const k = pairKey(m.id, f.id);
    if (met.has(k) || blocked.has(k)) continue;
    edges.push({ a: m.id, b: f.id, p: +priority.has(m.id) + +priority.has(f.id), s: score(m, f), k });
  }
  edges.sort((x, y) => y.p - x.p || y.s - x.s || (x.k < y.k ? -1 : x.k > y.k ? 1 : 0));
  const mate = new Map<string, string>();
  for (const e of edges) if (!mate.has(e.a) && !mate.has(e.b)) { mate.set(e.a, e.b); mate.set(e.b, e.a); }
  // Greedy alone can strand pairable users (e.g. late rounds where few unmet pairs remain). Augmenting paths
  // (Kuhn) raise the pair count to the maximum without ever unpairing anyone, so priority users stay paired.
  const adj = new Map<string, string[]>();
  for (const e of edges) { const l = adj.get(e.a) ?? []; l.push(e.b); adj.set(e.a, l); }
  const augment = (m: string, seenF: Set<string>): boolean => {
    for (const f of adj.get(m) ?? []) {
      if (seenF.has(f)) continue; seenF.add(f);
      const cur = mate.get(f);
      if (cur === undefined || augment(cur, seenF)) { mate.set(m, f); mate.set(f, m); return true; }
    }
    return false;
  };
  for (const m of males) if (!mate.has(m.id)) augment(m.id, new Set());
  const pairs: [string, string][] = males.filter((m) => mate.has(m.id)).map((m) => [m.id, mate.get(m.id)!]);
  return { pairs, unmatched: uniq.filter((u) => !mate.has(u.id)).map((u) => u.id) };
}
