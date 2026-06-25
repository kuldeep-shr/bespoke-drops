import { Drop } from '../models/Drop';
import { Hold } from '../models/Hold';
import { Purchase } from '../models/Purchase';
import { env } from '../lib/env';
import { bad, conflict, notFound } from '../lib/errors';
import { reclaimExpiredForDrop } from './expiryService';

/**
 * CLAIM — the hottest path. Thousands hit one Drop in the same instant.
 *
 * Correctness rests on ONE atomic operator:
 *   Drop.findOneAndUpdate({ _id, available >= units }, { $inc: { available: -units } })
 * Mongo serializes single-doc updates, so stock can never be oversold — the
 * conditional decrement either wins atomically or returns null (sold out).
 * No transaction, no lock, no replica set needed.
 *
 * Idempotency: a retried claim with the same idempotencyKey returns the EXISTING
 * hold instead of reserving twice. We try the insert first; on duplicate-key we
 * fetch and return the original.
 */
export async function claim(params: {
  dropId: string; userId: string; units: number; idempotencyKey?: string;
}) {
  const { dropId, userId, units, idempotencyKey } = params;
  if (!(units > 0)) throw bad('VALIDATION', 'units must be > 0');

  const drop = await Drop.findById(dropId);
  if (!drop) throw notFound('DROP_NOT_FOUND', 'drop not found');
  if (drop.goLiveAt > new Date()) throw conflict('NOT_LIVE', 'drop is not live yet');

  // Reclaim anything expired right now so freed stock is claimable immediately.
  await reclaimExpiredForDrop(dropId);

  // Idempotent short-circuit: same key already produced a hold? return it.
  if (idempotencyKey) {
    const existing = await Hold.findOne({ dropId, userId, idempotencyKey });
    if (existing) return { hold: existing, idempotentReplay: true };
  }

  // Enforce per-user cap across active holds + purchases.
  const [heldAgg, boughtAgg] = await Promise.all([
    Hold.aggregate([
      { $match: { dropId: drop._id, userId, status: 'active' } },
      { $group: { _id: null, n: { $sum: '$units' } } },
    ]),
    Purchase.aggregate([
      { $match: { dropId: drop._id, userId } },
      { $group: { _id: null, n: { $sum: '$units' } } },
    ]),
  ]);
  const alreadyHeld = (heldAgg[0]?.n ?? 0) + (boughtAgg[0]?.n ?? 0);
  if (alreadyHeld + units > drop.maxPerUser) {
    throw conflict('MAX_PER_USER', `exceeds maxPerUser (${drop.maxPerUser})`);
  }

  // THE atomic reservation.
  const reserved = await Drop.findOneAndUpdate(
    { _id: drop._id, available: { $gte: units } },
    { $inc: { available: -units } },
    { new: true }
  );
  if (!reserved) throw conflict('SOLD_OUT', 'not enough stock available');

  const expiresAt = new Date(Date.now() + env.holdTtlSeconds * 1000);
  try {
    const hold = await Hold.create({ dropId, userId, units, expiresAt, idempotencyKey });
    return { hold, idempotentReplay: false };
  } catch (e: any) {
    // Lost an idempotency race: give back the stock, return the winning hold.
    if (e?.code === 11000) {
      await Drop.updateOne({ _id: drop._id }, { $inc: { available: units } });
      const existing = await Hold.findOne({ dropId, userId, idempotencyKey });
      if (existing) return { hold: existing, idempotentReplay: true };
    }
    throw e;
  }
}
