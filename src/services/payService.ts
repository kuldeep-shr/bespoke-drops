import { Hold } from '../models/Hold';
import { Drop } from '../models/Drop';
import { Wallet } from '../models/Wallet';
import { Purchase } from '../models/Purchase';
import { bad, conflict, notFound } from '../lib/errors';

/**
 * PAY — confirm a hold, move coins. Money must never be lost or double-charged.
 *
 * Three atomic steps, ordered so any crash is safe:
 *  1) Claim the hold: active -> confirmed via guarded findOneAndUpdate. Only one
 *     concurrent/retried pay can win this; the rest see it's gone -> idempotent.
 *  2) Debit wallet conditionally: { balance >= cost } $inc -1. Can't go negative.
 *     If it fails, we roll the hold back to active (coins never left).
 *  3) Record Purchase (unique holdId). If a retry already wrote it, treat as done.
 *
 * Stock is NOT returned on pay: held units simply convert to sold. Invariant holds.
 */
export async function pay(params: { holdId: string; userId: string }) {
  const { holdId, userId } = params;

  // Already paid? (retry after success) -> return the existing purchase.
  const prior = await Purchase.findOne({ holdId });
  if (prior) {
    if (prior.userId !== userId) throw conflict('NOT_OWNER', 'hold belongs to another user');
    return { purchase: prior, replay: true };
  }

  const hold = await Hold.findById(holdId);
  if (!hold) throw notFound('HOLD_NOT_FOUND', 'hold not found');
  if (hold.userId !== userId) throw conflict('NOT_OWNER', 'hold belongs to another user');
  if (hold.status === 'expired') throw conflict('HOLD_EXPIRED', 'hold expired');
  if (hold.status === 'cancelled') throw conflict('HOLD_CANCELLED', 'hold cancelled');
  if (hold.expiresAt <= new Date() && hold.status === 'active') {
    throw conflict('HOLD_EXPIRED', 'hold expired');
  }

  const drop = await Drop.findById(hold.dropId);
  if (!drop) throw notFound('DROP_NOT_FOUND', 'drop not found');
  const cost = drop.pricePerUnit * hold.units;

  // Step 1: win the confirm race.
  const confirmed = await Hold.findOneAndUpdate(
    { _id: holdId, status: 'active', expiresAt: { $gt: new Date() } },
    { $set: { status: 'confirmed' } },
    { new: true }
  );
  if (!confirmed) {
    const after = await Purchase.findOne({ holdId });
    if (after) return { purchase: after, replay: true };
    throw conflict('HOLD_NOT_CONFIRMABLE', 'hold no longer active');
  }

  // Step 2: conditional debit.
  const debited = await Wallet.findOneAndUpdate(
    { userId, balance: { $gte: cost } },
    { $inc: { balance: -cost } },
    { new: true }
  );
  if (!debited) {
    await Hold.updateOne({ _id: holdId, status: 'confirmed' }, { $set: { status: 'active' } });
    throw bad('INSUFFICIENT_FUNDS', 'wallet balance too low');
  }

  // Step 3: record purchase (unique holdId guards against dup).
  try {
    const purchase = await Purchase.create({
      holdId, dropId: hold.dropId, userId, units: hold.units, totalPaid: cost,
    });
    return { purchase, replay: false };
  } catch (e: any) {
    if (e?.code === 11000) {
      // Refund our debit; the winning attempt already recorded the purchase.
      await Wallet.updateOne({ userId }, { $inc: { balance: cost } });
      const existing = await Purchase.findOne({ holdId });
      if (existing) return { purchase: existing, replay: true };
    }
    throw e;
  }
}
