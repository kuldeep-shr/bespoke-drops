import { Wallet } from '../models/Wallet';
import { bad } from '../lib/errors';

/**
 * TOP-UP — add coins. Atomic $inc with upsert so a brand-new user gets a wallet.
 * Amount must be positive; this only ever credits, never debits.
 */
export async function topUp(params: { userId: string; amount: number }) {
  const { userId, amount } = params;
  if (!(amount > 0)) throw bad('VALIDATION', 'amount must be > 0');
  const w = await Wallet.findOneAndUpdate(
    { userId },
    { $inc: { balance: amount } },
    { new: true, upsert: true }
  );
  return { userId, balance: w!.balance };
}
