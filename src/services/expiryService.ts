import { Hold } from '../models/Hold';
import { Drop } from '../models/Drop';
import { promoteWaitlist } from './waitlistService';

/**
 * Reclaim expired active holds and return their units to the pool.
 *
 * Restart-safety + no double-return: we flip each hold active->expired with an
 * atomic findOneAndUpdate guarded on status:'active'. Only the update that wins
 * gets to $inc the stock back. A crash mid-loop just leaves work for the next
 * sweep; nothing is lost or returned twice.
 */
export async function reclaimExpiredForDrop(dropId: string) {
  const now = new Date();
  let reclaimedTotal = 0;

  while (true) {
    const hold = await Hold.findOneAndUpdate(
      { dropId, status: 'active', expiresAt: { $lte: now } },
      { $set: { status: 'expired' } },
      { new: true }
    );
    if (!hold) break;
    await Drop.updateOne({ _id: dropId }, { $inc: { available: hold.units } });
    reclaimedTotal += hold.units;
  }

  if (reclaimedTotal > 0) await promoteWaitlist(dropId);
  return reclaimedTotal;
}

export async function reclaimAllExpired() {
  const dropIds = await Hold.distinct('dropId', {
    status: 'active', expiresAt: { $lte: new Date() },
  });
  for (const id of dropIds) await reclaimExpiredForDrop(String(id));
}
