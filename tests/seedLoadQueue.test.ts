process.env.JWT_ACCESS_SECRET = 'a'.repeat(40); process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
process.env.NODE_ENV = 'test'; process.env.MEDIA_URL_SECRET = 'm'.repeat(40); process.env.MONGO_URI = 'mongodb://placeholder';
process.env.REDIS_URL = 'redis://fake-redis:6379';

// Fake BullMQ/ioredis: records what the seed enqueues without a real Redis.
const added: { name: string; data: any; opts: any }[] = []; const life = { workers: 0, queueClosed: 0, connQuit: 0 };
jest.mock('bullmq', () => ({
  Queue: class { async add(name: string, data: any, opts: any) { added.push({ name, data, opts }); } async close() { life.queueClosed++; } },
  Worker: class { constructor() { life.workers++; } on() {} async close() {} },
}));
jest.mock('ioredis', () => class { duplicate() { return this; } async quit() { life.connQuit++; } });

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { readFileSync, rmSync } from 'node:fs';
import { runSeed } from '../scripts/seed-load';
import { Event } from '../src/modules/events/event.model';

let mongo: MongoMemoryServer;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

it('seed:load enqueues the event timeline into the configured (Redis) queue, producer only, and closes it', async () => {
  const file = join(tmpdir(), `seed-tokens-${Date.now()}.txt`);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const r: any = await runSeed({ tag: 'jest-seed', tokensFile: file });
  expect(r.tokens).toBe(300);
  expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(300); rmSync(file);
  const names = added.filter((a) => a.data.eventId === r.eventId).map((a) => a.name).sort();
  expect(names).toEqual(['event.end', 'event.open', 'event.start']);
  expect(life).toEqual({ workers: 0, queueClosed: 1, connQuit: 1 });
  expect(await Event.collection.countDocuments({ seedTag: 'jest-seed' })).toBe(1);
  const c: any = await runSeed({ clean: true, tag: 'jest-seed' });
  expect(c.cleaned).toMatchObject({ users: 301, bookings: 300, blocks: 8, events: 1, refreshTokens: 300 });
});
