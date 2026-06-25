export const env = {
  port: Number(process.env.PORT ?? 3000),
  mongoUri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/bespoke',
  holdTtlSeconds: Number(process.env.HOLD_TTL_SECONDS ?? 120),
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 2000),
};
