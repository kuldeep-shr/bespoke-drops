import { Schema, model } from 'mongoose';

// One purchase per confirmed hold. Unique holdId makes pay idempotent:
// a retried pay can't charge the wallet twice.
const purchaseSchema = new Schema({
  holdId: { type: Schema.Types.ObjectId, ref: 'Hold', required: true, unique: true },
  dropId: { type: Schema.Types.ObjectId, ref: 'Drop', required: true, index: true },
  userId: { type: String, required: true, index: true },
  units: { type: Number, required: true },
  totalPaid: { type: Number, required: true },
}, { timestamps: true });

export const Purchase = model('Purchase', purchaseSchema);
