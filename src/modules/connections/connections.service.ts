import { connectionRepository } from './connections.repository';
import { MutualResult } from './connections.types';
import { liveProfiles } from '../users/users.service';

/**
 * Creates the pair's connection exactly once: an upsert on the unique (userA, userB) index.
 * Concurrent callers race on the index; exactly one sees `created: true`.
 */
export async function createMutual(u1: string, u2: string, eventId: string, dateId: string): Promise<MutualResult> {
  const [userA, userB] = u1 < u2 ? [u1, u2] : [u2, u1];
  for (let i = 0; i < 2; i++) {
    try {
      const r = await connectionRepository.findOneAndUpdate({ userA, userB }, { $setOnInsert: { userA, userB, eventId, dateId } },
        { upsert: true, new: true, includeResultMetadata: true });
      return { connectionId: String(r.value!._id), created: !r.lastErrorObject?.updatedExisting };
    } catch (e: any) { if (e?.code !== 11000 || i === 1) throw e; } // concurrent upsert lost the race: re-read
  }
  throw new Error('unreachable');
}

export async function listMine(userId: string, before: Date | undefined, limit: number) {
  const rows = await connectionRepository.find({ $or: [{ userA: userId }, { userB: userId }], ...(before ? { createdAt: { $lt: before } } : {}) })
    .sort({ createdAt: -1 }).limit(limit).lean();
  const others = rows.map((c) => (String(c.userA) === userId ? String(c.userB) : String(c.userA)));
  const cards = await liveProfiles(others);
  return { items: rows.map((c, i) => {
    const p = cards.get(others[i]);
    return { id: String(c._id), eventId: String(c.eventId), createdAt: c.createdAt,
      partner: p ? { id: p.id, fullName: p.fullName, age: p.age, city: p.city, photoUrl: p.photoUrl, interests: p.interests } : { id: others[i] } };
  }) };
}
