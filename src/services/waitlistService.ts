import { Waitlist } from '../models/Waitlist';
import { Hold } from '../models/Hold';
import { Drop } from '../models/Drop';
import { env } from '../lib/env';
import { conflict, notFound } from '../lib/errors';

/** Join waitlist only when truly sold out. One waiting entry per user per drop. */
export async function joinWaitlist(params: { dropId: string; userId: string; units: number }) {
  const { dropId, userId, units } = params;
  const drop = await Drop.findById(dropId);
  if (!drop) throw notFound('DROP_NOT_FOUND', 'drop not found');
  if (drop.available >= units) throw conflict('NOT_SOLD_OUT', 'stock still available; claim instead');
  try {
    return await Waitlist.create({ dropId, userId, units, status: 'waiting' });
  } catch (e: any) {
    if (e?.code === 11000) throw conflict('ALREADY_WAITING', 'already on waitlist for this drop');
    throw e;
  }
}

/**
 * Promote waitlisted users FIFO when stock frees up. For each entry (oldest first)
 * we attempt the SAME atomic conditional decrement used in claim. If it succeeds we
 * mint a fresh hold + fresh window and mark them promoted; if stock runs out we stop.
 * Idempotent + restart-safe: re-running just continues from whoever is still waiting.
 */
export async function promoteWaitlist(dropId: string) {
  while (true) {
    const next = await Waitlist.findOne({ dropId, status: 'waiting' }).sort({ createdAt: 1 });
    if (!next) break;

    const reserved = await Drop.findOneAndUpdate(
      { _id: dropId, available: { $gte: next.units } },
      { $inc: { available: -next.units } },
      { new: true }
    );
    if (!reserved) break; // not enough stock for the head of the line -> stop, stay fair

    const claimed = await Waitlist.findOneAndUpdate(
      { _id: next._id, status: 'waiting' },
      { $set: { status: 'promoted' } },
      { new: true }
    );
    if (!claimed) { // someone else promoted them; give stock back and retry loop
      await Drop.updateOne({ _id: dropId }, { $inc: { available: next.units } });
      continue;
    }

    const expiresAt = new Date(Date.now() + env.holdTtlSeconds * 1000);
    await Hold.create({ dropId, userId: next.userId, units: next.units, expiresAt });
  }
}
