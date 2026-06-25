import { Schema, model } from 'mongoose';

const walletSchema = new Schema({
  userId: { type: String, required: true, unique: true },
  balance: { type: Number, required: true, min: 0 },
}, { timestamps: true });

export const Wallet = model('Wallet', walletSchema);
