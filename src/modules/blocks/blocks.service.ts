import { AppError } from '../../utils/errors';
import { blockRepository } from './blocks.repository';
import { pairKey } from './blocks.types';

export { pairKey } from './blocks.types';
export async function block(userId: string, otherId: string) {
  if (userId === otherId) throw new AppError(400, 'CANNOT_BLOCK_SELF');
  await blockRepository.updateOne({ blockerId: userId, blockedId: otherId }, { $setOnInsert: { blockerId: userId, blockedId: otherId } }, { upsert: true });
  return { blocked: true };
}
export async function unblock(userId: string, otherId: string) {
  await blockRepository.deleteOne({ blockerId: userId, blockedId: otherId });
  return { blocked: false };
}
/** Pair keys (either direction) of blocks among the given users. */
export async function blockedPairsAmong(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await blockRepository.find({ blockerId: { $in: ids }, blockedId: { $in: ids } }).select('blockerId blockedId').lean();
  return new Set(rows.map((r) => pairKey(String(r.blockerId), String(r.blockedId))));
}
export async function isBlockedEitherWay(a: string, b: string) {
  return !!(await blockRepository.exists({ $or: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] }));
}
