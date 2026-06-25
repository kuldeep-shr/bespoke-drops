import { Schema, model } from 'mongoose';

// Fairness = strict FIFO by createdAt. A user has at most one waiting entry
// per drop (unique partial index). On promotion they get a fresh hold + window.
const waitlistSchema = new Schema({
  dropId: { type: Schema.Types.ObjectId, ref: 'Drop', required: true, index: true },
  userId: { type: String, required: true },
  units: { type: Number, required: true, min: 1 },
  status: {
    type: String,
    enum: ['waiting', 'promoted', 'fulfilled', 'cancelled'],
    default: 'waiting',
    index: true,
  },
}, { timestamps: true });

waitlistSchema.index(
  { dropId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: 'waiting' } }
);

export const Waitlist = model('Waitlist', waitlistSchema);
