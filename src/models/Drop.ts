import { Schema, model, InferSchemaType } from 'mongoose';

// available = units in the pool, not held and not sold.
// held + sold + available == totalStock  (invariant we never violate)
const dropSchema = new Schema({
  itemName: { type: String, required: true },
  totalStock: { type: Number, required: true, min: 1 },
  available: { type: Number, required: true, min: 0 },
  pricePerUnit: { type: Number, required: true, min: 0 },
  goLiveAt: { type: Date, required: true },
  maxPerUser: { type: Number, required: true, min: 1 },
}, { timestamps: true });

export type DropDoc = InferSchemaType<typeof dropSchema>;
export const Drop = model('Drop', dropSchema);
