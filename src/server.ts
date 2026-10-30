import mongoose from 'mongoose';
import { env } from './config/env';
import { createApp } from './app';
import { logger } from './utils/logger';
import { initQueue } from './jobs/queue';
import { RedisLiveStore, setLiveStore, getLiveStore } from './integrations/livestore';
import { attachLive } from './modules/live/live.gateway';

(async () => {
  await mongoose.connect(env.MONGO_URI);
  await mongoose.syncIndexes();
  const queue = initQueue(env.REDIS_URL, env.NODE_ENV);
  if (env.REDIS_URL) setLiveStore(new RedisLiveStore(env.REDIS_URL));
  else if (env.NODE_ENV !== 'test') logger.warn('REDIS_URL not set: live-session state is in-process (single API process only)');
  const server = createApp().listen(env.PORT, () => logger.info(`API on :${env.PORT}`));
  const live = attachLive(server, { redisUrl: env.REDIS_URL || undefined, corsOrigins: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) });
  const stop = async () => { await live.close(); server.close(); await queue.close(); await getLiveStore().close(); await mongoose.disconnect(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
})().catch((e) => { logger.error(e); process.exit(1); });
