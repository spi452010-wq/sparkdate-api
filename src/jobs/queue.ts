import { logger } from '../utils/logger';

export type JobName = 'booking.expire' | 'payment.ack' | 'payment.reconcile' | 'event.finalize' | 'webhook.process' | 'refund.retry'
  | 'notify.reminder' | 'notify.chatPassExpiring' | 'voided.sync';
export interface JobOpts { delayMs?: number; jobId?: string }
export type Handler = (data: any) => Promise<void>;

/** Small queue abstraction: BullMQ in production, in-process timers in dev without Redis, in-memory in tests. */
export interface JobQueue {
  add(name: JobName, data: any, opts?: JobOpts): Promise<void>;
  /** Remove a not-yet-run job (no-op if missing). */
  remove(jobId: string): Promise<void>;
  close(): Promise<void>;
}

export const handlers = new Map<JobName, Handler>();
export const registerHandler = (name: JobName, h: Handler) => handlers.set(name, h);
async function run(name: JobName, data: any) {
  const h = handlers.get(name);
  if (!h) throw new Error(`No handler for ${name}`);
  await h(data);
}
// Deterministic ids keep rescheduling idempotent. BullMQ forbids ':' in custom ids, so we use '_'.
export const jobId = (...parts: (string | number)[]) => parts.join('_');

type MemJob = { name: JobName; data: any; runAt: number; id: string };
/** Test queue: jobs are recorded and only run when the test calls runDue(). */
export class MemoryQueue implements JobQueue {
  jobs = new Map<string, MemJob>(); private seq = 0;
  async add(name: JobName, data: any, o: JobOpts = {}) {
    const id = o.jobId ?? `auto_${++this.seq}`;
    if (this.jobs.has(id)) return; // same semantics as BullMQ: duplicate id is ignored
    this.jobs.set(id, { name, data, runAt: Date.now() + (o.delayMs ?? 0), id });
  }
  async remove(id: string) { this.jobs.delete(id); }
  async close() { this.jobs.clear(); }
  /** Run (and remove) every job due at `now`, including jobs those jobs enqueue, until none are due. */
  async runDue(now = Date.now(), only?: JobName) {
    for (let guard = 0; guard < 50; guard++) {
      const due = [...this.jobs.values()].filter((j) => j.runAt <= now && (!only || j.name === only));
      if (!due.length) return;
      for (const j of due) { this.jobs.delete(j.id); await run(j.name, j.data); }
    }
  }
  find(name: JobName) { return [...this.jobs.values()].filter((j) => j.name === name); }
}

/** Dev fallback without Redis: setTimeout, lost on restart. */
export class TimerQueue implements JobQueue {
  private timers = new Map<string, NodeJS.Timeout>(); private seq = 0;
  async add(name: JobName, data: any, o: JobOpts = {}) {
    const id = o.jobId ?? `auto_${++this.seq}`;
    if (this.timers.has(id)) return;
    const delay = Math.min(Math.max(0, o.delayMs ?? 0), 2 ** 31 - 1);
    const t = setTimeout(() => { this.timers.delete(id); run(name, data).catch((err) => logger.error({ err, name }, 'job failed')); }, delay);
    t.unref(); this.timers.set(id, t);
  }
  async remove(id: string) { const t = this.timers.get(id); if (t) clearTimeout(t); this.timers.delete(id); }
  async close() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}

const QUEUE = 'sparkdate';
export class BullQueue implements JobQueue {
  private q: any; private worker: any; private conn: any;
  constructor(redisUrl: string, startWorker = true) {
    // Lazy require so tests/dev never need Redis.
    const { Queue, Worker } = require('bullmq'); const IORedis = require('ioredis');
    this.conn = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.q = new Queue(QUEUE, { connection: this.conn, defaultJobOptions: { attempts: 8, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 1000, removeOnFail: 5000 } });
    if (startWorker) {
      this.worker = new Worker(QUEUE, (job: any) => run(job.name, job.data), { connection: this.conn.duplicate(), concurrency: 5 });
      this.worker.on('failed', (job: any, err: any) => logger.error({ err, name: job?.name, id: job?.id }, 'job failed'));
    }
  }
  async add(name: JobName, data: any, o: JobOpts = {}) {
    await this.q.add(name, data, { delay: Math.max(0, o.delayMs ?? 0), jobId: o.jobId });
  }
  async remove(id: string) {
    const j = await this.q.getJob(id);
    if (j && !(await j.isActive())) await j.remove().catch(() => {});
  }
  async repeatDaily(name: JobName, data: any) {
    await this.q.add(name, data, { repeat: { pattern: '30 3 * * *' }, jobId: `daily_${name}` });
  }
  async close() { await this.worker?.close(); await this.q.close(); await this.conn.quit(); }
}

let current: JobQueue = new MemoryQueue();
export const getQueue = () => current;
export const setQueue = (q: JobQueue) => { current = q; };
export function initQueue(redisUrl: string, nodeEnv: string) {
  if (redisUrl) { const q = new BullQueue(redisUrl); current = q; q.repeatDaily('voided.sync', {}).catch((err) => logger.error({ err }, 'repeat schedule failed')); return q; }
  if (nodeEnv !== 'test') logger.warn('REDIS_URL not set: using in-process timers for jobs (dev only, jobs are lost on restart)');
  current = nodeEnv === 'test' ? new MemoryQueue() : new TimerQueue();
  return current;
}
/** Remove then add, for jobs whose time moves (e.g. extended holds). */
export async function reschedule(name: JobName, data: any, o: Required<Pick<JobOpts, 'jobId'>> & JobOpts) {
  await current.remove(o.jobId); await current.add(name, data, o);
}
