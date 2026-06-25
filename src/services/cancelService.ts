import { Hold } from '../models/Hold';
import { Drop } from '../models/Drop';
import { Wallet } from '../models/Wallet';
import { Purchase } from '../models/Purchase';
import { conflict, notFound } from '../lib/errors';
import { promoteWaitlist } from './waitlistService';

/**
 * CANCEL — release a hold and return its stock; refund coins if already paid.
 *
 * Two cases, both atomic and idempotent:
 *
 *  A) Active hold (not yet paid): flip active -> cancelled with a guarded update.
 *     Only the winner returns the units, so a double-cancel can't double-credit stock.
 *
 *  B) Confirmed + paid hold: flip confirmed -> cancelled (guard on the Purchase still
 *     existing), delete the Purchase, refund the wallet, return the stock. The guarded
 *     transition means exactly one caller does the refund; retries see it's gone.
 *
 * Stock returning triggers waitlist promotion, same as expiry.
 */
export async function cancel(params: { holdId: string; userId: string }) {
  const { holdId, userId } = params;

  const hold = await Hold.findById(holdId);
  if (!hold) throw notFound('HOLD_NOT_FOUND', 'hold not found');
  if (hold.userId !== userId) throw conflict('NOT_OWNER', 'hold belongs to another user');

  // Case A: still an unpaid active hold.
  if (hold.status === 'active') {
    const released = await Hold.findOneAndUpdate(
      { _id: holdId, status: 'active' },
      { $set: { status: 'cancelled' } },
      { new: true }
    );
    if (!released) {
      // Lost the race — someone confirmed/expired/cancelled it first. Re-read & report.
      const fresh = await Hold.findById(holdId);
      throw conflict('NOT_CANCELLABLE', `hold is ${fresh?.status}`);
    }
    await Drop.updateOne({ _id: hold.dropId }, { $inc: { available: released.units } });
    await promoteWaitlist(String(hold.dropId));
    return { status: 'cancelled', refunded: 0, stockReturned: released.units };
  }

  // Case B: confirmed + paid -> refund.
  if (hold.status === 'confirmed') {
    const purchase = await Purchase.findOne({ holdId });
    if (!purchase) throw conflict('NOT_CANCELLABLE', 'confirmed hold without purchase');

    // Win the transition; guard ensures one refund only.
    const cancelled = await Hold.findOneAndUpdate(
      { _id: holdId, status: 'confirmed' },
      { $set: { status: 'cancelled' } },
      { new: true }
    );
    if (!cancelled) {
      throw conflict('NOT_CANCELLABLE', 'hold already being cancelled');
    }
    // Delete purchase first so it can't be seen as a live sale; then refund + restock.
    await Purchase.deleteOne({ _id: purchase._id });
    await Wallet.updateOne({ userId }, { $inc: { balance: purchase.totalPaid } });
    await Drop.updateOne({ _id: hold.dropId }, { $inc: { available: hold.units } });
    await promoteWaitlist(String(hold.dropId));
    return { status: 'cancelled', refunded: purchase.totalPaid, stockReturned: hold.units };
  }

  // Already terminal.
  throw conflict('NOT_CANCELLABLE', `hold is ${hold.status}`);
}
