import { describe, it, expect } from 'vitest';
import './setup';
import { Drop } from '../models/Drop';
import { Wallet } from '../models/Wallet';
import { Hold } from '../models/Hold';
import { Purchase } from '../models/Purchase';
import { claim } from '../services/claimService';
import { pay } from '../services/payService';
import { joinWaitlist, promoteWaitlist } from '../services/waitlistService';
import { reclaimExpiredForDrop } from '../services/expiryService';

const liveDrop = (over = {}) => Drop.create({
  itemName: 'X', totalStock: 5, available: 5, pricePerUnit: 100,
  goLiveAt: new Date(Date.now() - 1000), maxPerUser: 2, ...over,
});

describe('stock correctness under load', () => {
  it('never oversells when many claim the same instant', async () => {
    const drop = await liveDrop({ totalStock: 5, available: 5, maxPerUser: 1 });
    const users = Array.from({ length: 50 }, (_, i) => `u${i}`);
    const results = await Promise.allSettled(
      users.map((u) => claim({ dropId: drop.id, userId: u, units: 1 }))
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(5); // exactly the stock, no more
    const fresh = await Drop.findById(drop.id);
    expect(fresh!.available).toBe(0);
    const holds = await Hold.countDocuments({ dropId: drop.id, status: 'active' });
    expect(holds).toBe(5);
  });

  it('is idempotent: same idempotency key reserves once', async () => {
    const drop = await liveDrop();
    const key = 'abc-123';
    const a = await claim({ dropId: drop.id, userId: 'alice', units: 1, idempotencyKey: key });
    const b = await claim({ dropId: drop.id, userId: 'alice', units: 1, idempotencyKey: key });
    expect(String(a.hold._id)).toBe(String(b.hold._id));
    expect(b.idempotentReplay).toBe(true);
    const fresh = await Drop.findById(drop.id);
    expect(fresh!.available).toBe(4); // only 1 unit gone
  });

  it('enforces maxPerUser across holds', async () => {
    const drop = await liveDrop({ maxPerUser: 2 });
    await claim({ dropId: drop.id, userId: 'alice', units: 2 });
    await expect(claim({ dropId: drop.id, userId: 'alice', units: 1 }))
      .rejects.toMatchObject({ code: 'MAX_PER_USER' });
  });
});

describe('money safety', () => {
  it('debits exactly once even on retried pay', async () => {
    const drop = await liveDrop();
    await Wallet.create({ userId: 'alice', balance: 1000 });
    const { hold } = await claim({ dropId: drop.id, userId: 'alice', units: 2 });
    const [p1, p2] = await Promise.all([
      pay({ holdId: hold.id, userId: 'alice' }),
      pay({ holdId: hold.id, userId: 'alice' }),
    ]);
    expect(String(p1.purchase._id)).toBe(String(p2.purchase._id));
    const w = await Wallet.findOne({ userId: 'alice' });
    expect(w!.balance).toBe(800); // 2 * 100 once, not twice
    expect(await Purchase.countDocuments({ holdId: hold.id })).toBe(1);
  });

  it('rejects pay when funds insufficient and leaves wallet untouched', async () => {
    const drop = await liveDrop();
    await Wallet.create({ userId: 'carol', balance: 50 });
    const { hold } = await claim({ dropId: drop.id, userId: 'carol', units: 1 });
    await expect(pay({ holdId: hold.id, userId: 'carol' }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    const w = await Wallet.findOne({ userId: 'carol' });
    expect(w!.balance).toBe(50);
    const h = await Hold.findById(hold.id);
    expect(h!.status).toBe('active'); // rolled back, can retry
  });
});

describe('expiry + waitlist fairness', () => {
  it('returns expired stock to the pool', async () => {
    const drop = await liveDrop({ totalStock: 1, available: 1 });
    const { hold } = await claim({ dropId: drop.id, userId: 'alice', units: 1 });
    await Hold.updateOne({ _id: hold.id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    const reclaimed = await reclaimExpiredForDrop(drop.id);
    expect(reclaimed).toBe(1);
    const fresh = await Drop.findById(drop.id);
    expect(fresh!.available).toBe(1);
  });

  it('promotes waitlist FIFO when stock frees up', async () => {
    const drop = await liveDrop({ totalStock: 1, available: 0, maxPerUser: 1 });
    await joinWaitlist({ dropId: drop.id, userId: 'first', units: 1 });
    await new Promise((r) => setTimeout(r, 10));
    await joinWaitlist({ dropId: drop.id, userId: 'second', units: 1 });
    // free one unit
    await Drop.updateOne({ _id: drop.id }, { $inc: { available: 1 } });
    await promoteWaitlist(drop.id);
    const firstHold = await Hold.findOne({ dropId: drop.id, userId: 'first' });
    const secondHold = await Hold.findOne({ dropId: drop.id, userId: 'second' });
    expect(firstHold).toBeTruthy();  // oldest promoted
    expect(secondHold).toBeFalsy();  // still waiting, no stock left
  });
});
