import mongoose from 'mongoose';
import { createApp } from './app';
import { startSweeper } from './sweeper';
import { env } from './lib/env';

async function main() {
  await mongoose.connect(env.mongoUri);
  console.log('mongo connected');
  startSweeper();
  createApp().listen(env.port, () => console.log(`listening on :${env.port}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
