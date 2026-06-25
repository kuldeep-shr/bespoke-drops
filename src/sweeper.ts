import { reclaimAllExpired } from './services/expiryService';
import { env } from './lib/env';

// Background safety net: reclaims expired holds + promotes waitlist even when no
// request touches a drop. Lazy reclaim on read covers the rest. Restart just
// resumes sweeping; a single-flight guard prevents overlapping runs.
let running = false;
export function startSweeper() {
  return setInterval(async () => {
    if (running) return;
    running = true;
    try { await reclaimAllExpired(); }
    catch (e) { console.error('sweep error', e); }
    finally { running = false; }
  }, env.sweepIntervalMs);
}
