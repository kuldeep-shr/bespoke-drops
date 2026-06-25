import { Drop } from '../models/Drop';
import { bad } from '../lib/errors';

export async function createDrop(input: {
  itemName: string; totalStock: number; pricePerUnit: number;
  goLiveAt: string | Date; maxPerUser: number;
}) {
  if (!input.itemName) throw bad('VALIDATION', 'itemName required');
  if (!(input.totalStock > 0)) throw bad('VALIDATION', 'totalStock must be > 0');
  if (!(input.maxPerUser > 0)) throw bad('VALIDATION', 'maxPerUser must be > 0');
  if (input.pricePerUnit < 0) throw bad('VALIDATION', 'pricePerUnit must be >= 0');

  return Drop.create({
    itemName: input.itemName,
    totalStock: input.totalStock,
    available: input.totalStock,
    pricePerUnit: input.pricePerUnit,
    goLiveAt: new Date(input.goLiveAt),
    maxPerUser: input.maxPerUser,
  });
}
