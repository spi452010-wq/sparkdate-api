import mongoose from 'mongoose';
import { env } from './config/env';
import { createApp } from './app';
import { logger } from './utils/logger';

(async () => {
  await mongoose.connect(env.MONGO_URI);
  await mongoose.syncIndexes();
  const server = createApp().listen(env.PORT, () => logger.info(`API on :${env.PORT}`));
  const stop = async () => { server.close(); await mongoose.disconnect(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
})().catch((e) => { logger.error(e); process.exit(1); });
