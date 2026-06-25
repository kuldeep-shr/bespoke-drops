import { Router, Request, Response, NextFunction } from 'express';
import { auth } from '../middleware/auth';
import { createDrop } from '../services/dropService';
import { claim } from '../services/claimService';
import { pay } from '../services/payService';
import { joinWaitlist } from '../services/waitlistService';
import { cancel } from '../services/cancelService';
import { topUp } from '../services/walletService';
import { Drop } from '../models/Drop';
import { Hold } from '../models/Hold';
import { Purchase } from '../models/Purchase';
import { Wallet } from '../models/Wallet';
import { reclaimExpiredForDrop } from '../services/expiryService';
import { notFound } from '../lib/errors';

const r = Router();
const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

// --- Admin ---
r.post('/drops', wrap(async (req: Request, res: Response) => {
  const drop = await createDrop(req.body);
  res.status(201).json(drop);
}));

r.get('/drops/:id', wrap(async (req: Request, res: Response) => {
  await reclaimExpiredForDrop(req.params.id); // reflect live availability
  const drop = await Drop.findById(req.params.id);
  if (!drop) throw notFound('DROP_NOT_FOUND', 'drop not found');
  res.json(drop);
}));

// --- User actions ---
r.post('/drops/:id/claim', auth, wrap(async (req: Request, res: Response) => {
  const out = await claim({
    dropId: req.params.id,
    userId: req.userId!,
    units: Number(req.body.units),
    idempotencyKey: req.header('idempotency-key') || req.body.idempotencyKey,
  });
  res.status(out.idempotentReplay ? 200 : 201).json(out.hold);
}));

r.post('/holds/:id/pay', auth, wrap(async (req: Request, res: Response) => {
  const out = await pay({ holdId: req.params.id, userId: req.userId! });
  res.status(out.replay ? 200 : 201).json(out.purchase);
}));

r.post('/holds/:id/cancel', auth, wrap(async (req: Request, res: Response) => {
  const out = await cancel({ holdId: req.params.id, userId: req.userId! });
  res.json(out);
}));

r.post('/me/wallet/topup', auth, wrap(async (req: Request, res: Response) => {
  const out = await topUp({ userId: req.userId!, amount: Number(req.body.amount) });
  res.json(out);
}));

r.post('/drops/:id/waitlist', auth, wrap(async (req: Request, res: Response) => {
  const entry = await joinWaitlist({ dropId: req.params.id, userId: req.userId!, units: Number(req.body.units) });
  res.status(201).json(entry);
}));

// --- Visibility ---
r.get('/me/holds', auth, wrap(async (req: Request, res: Response) => {
  res.json(await Hold.find({ userId: req.userId! }).sort({ createdAt: -1 }));
}));
r.get('/me/purchases', auth, wrap(async (req: Request, res: Response) => {
  res.json(await Purchase.find({ userId: req.userId! }).sort({ createdAt: -1 }));
}));
r.get('/me/wallet', auth, wrap(async (req: Request, res: Response) => {
  const w = await Wallet.findOne({ userId: req.userId! });
  res.json({ userId: req.userId!, balance: w?.balance ?? 0 });
}));

export default r;
