import { Request, Response, NextFunction } from 'express';

// Stub auth: identity via x-user-id header. Real JWT is out of scope per brief.
declare global { namespace Express { interface Request { userId?: string } } }

export function auth(req: Request, res: Response, next: NextFunction) {
  const uid = req.header('x-user-id');
  if (!uid) return res.status(401).json({ error: { code: 'NO_AUTH', message: 'x-user-id header required' } });
  req.userId = uid;
  next();
}
