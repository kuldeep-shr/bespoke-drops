import { Schema, model } from 'mongoose';

// A Hold is the single source of truth for "reserved but unpaid" stock.
// status flows: active -> confirmed | expired | cancelled
// expiresAt + a TTL-ish sweeper reclaim active holds; lazy checks back this up.
const holdSchema = new Schema({
  dropId: { type: Schema.Types.ObjectId, ref: 'Drop', required: true, index: true },
  userId: { type: String, required: true, index: true },
  units: { type: Number, required: true, min: 1 },
  status: {
    type: String,
    enum: ['active', 'confirmed', 'expired', 'cancelled'],
    default: 'active',
    index: true,
  },
  expiresAt: { type: Date, required: true },
  // Idempotency: same key => same hold returned, never a second reservation.
  idempotencyKey: { type: String },
}, { timestamps: true });

// One claim per (drop,user,idempotencyKey). Lets retries collapse safely.
holdSchema.index(
  { dropId: 1, userId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

export const Hold = model('Hold', holdSchema);
