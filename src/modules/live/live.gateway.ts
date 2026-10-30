import type { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { ZodSchema } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { getAuthUser } from '../users/users.service';
import * as svc from './live.service';
import { dateLeavePayload, decisionPayload, eventPayload, pingPayload, sparkPayload } from './live.validator';
import { Ack } from './live.types';

/** Per-socket limits: every event 30 per 10 s; date:spark additionally 1 per 3 s. */
export const RATE = { windowMs: 10_000, max: 30, sparkMs: 3_000 };
const MAX_EVENTS_PER_SOCKET = 3;

function authError(code: string) { const e: any = new Error(code); e.data = { code }; return e; }

/**
 * Socket.IO namespace /live. Handshake: `auth: { token: <access JWT> }`. Each socket joins `user:{id}`;
 * `event:{id}` only after a successful event:join (confirmed booking). Every client event is acked with {ok, error?}.
 */
export function attachLive(http: HttpServer, opts: { redisUrl?: string; corsOrigins?: string[] } = {}) {
  const io = new Server(http, {
    serveClient: false, maxHttpBufferSize: 4_096, pingInterval: 10_000, pingTimeout: 20_000,
    cors: { origin: opts.corsOrigins ?? [], credentials: true },
  });
  let redis: any[] = [];
  if (opts.redisUrl) {
    const IORedis = require('ioredis'); const { createAdapter } = require('@socket.io/redis-adapter');
    const pub = new IORedis(opts.redisUrl); const sub = pub.duplicate(); redis = [pub, sub];
    io.adapter(createAdapter(pub, sub));
  }
  const nsp = io.of('/live');

  nsp.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || !token) return next(authError('UNAUTHORIZED'));
      let payload: any;
      try { payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }); } catch { return next(authError('TOKEN_INVALID')); }
      const user = await getAuthUser(String(payload.sub));
      if (!user) return next(authError('UNAUTHORIZED'));
      if (user.status === 'blocked') return next(authError('ACCOUNT_BLOCKED'));
      socket.data.userId = user.id; socket.data.events = new Set<string>();
      next();
    } catch (err) { logger.error({ err }, 'live auth failed'); next(authError('INTERNAL')); }
  });

  svc.setLiveEmitter({
    toUser: (u, ev, d) => { nsp.to(`user:${u}`).emit(ev, d); },
    toEvent: (e, ev, d) => { nsp.to(`event:${e}`).emit(ev, d); },
    isOnline: async (u) => (await nsp.in(`user:${u}`).fetchSockets()).length > 0,
  });

  nsp.on('connection', (socket: Socket) => {
    const uid: string = socket.data.userId; const events: Set<string> = socket.data.events;
    socket.join(`user:${uid}`);
    const hits: number[] = []; let lastSpark = 0;
    const limited = (name: string) => {
      const now = Date.now();
      while (hits.length && hits[0] <= now - RATE.windowMs) hits.shift();
      if (hits.length >= RATE.max) return true;
      if (name === 'date:spark') { if (now - lastSpark < RATE.sparkMs) return true; lastSpark = now; }
      hits.push(now); return false;
    };
    const on = <T>(name: string, schema: ZodSchema<T>, fn: (p: T) => Promise<Record<string, unknown>>) => {
      socket.on(name, async (payload: unknown, ack?: (a: Ack) => void) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        if (limited(name)) return reply({ ok: false, error: 'RATE_LIMITED' });
        const p = schema.safeParse(payload ?? {});
        if (!p.success) return reply({ ok: false, error: 'VALIDATION_ERROR' });
        try { reply({ ok: true, ...(await fn(p.data)) }); }
        catch (e: any) {
          if (e instanceof AppError) return reply({ ok: false, error: e.code });
          logger.error({ err: e, event: name, userId: uid }, 'live handler failed'); reply({ ok: false, error: 'INTERNAL' });
        }
      });
    };

    on('event:join', eventPayload, async ({ eventId }) => {
      if (!events.has(eventId) && events.size >= MAX_EVENTS_PER_SOCKET) throw new AppError(429, 'TOO_MANY_EVENTS');
      const r = await svc.join(uid, eventId); // authz first: confirmed booking (match:found on rejoin goes to user:{id})
      socket.join(`event:${eventId}`); events.add(eventId);
      return r;
    });
    on('event:leave', eventPayload, async ({ eventId }) => {
      if (!events.has(eventId)) throw new AppError(409, 'NOT_JOINED');
      socket.leave(`event:${eventId}`); events.delete(eventId);
      return svc.leave(uid, eventId);
    });
    on('date:leave', dateLeavePayload, (p) => svc.dateLeave(uid, p));
    on('date:decision', decisionPayload, (p) => svc.decide(uid, p));
    on('date:spark', sparkPayload, (p) => svc.spark(uid, p));
    on('presence:ping', pingPayload, ({ eventId }) => svc.ping(uid, eventId ? [eventId].filter((e) => events.has(e)) : [...events]));

    socket.on('disconnect', () => {
      svc.onDisconnect(uid, [...events]).catch((err) => logger.error({ err, userId: uid }, 'live disconnect handling failed'));
    });
  });

  return { io, nsp, close: async () => { await io.close(); for (const r of redis) await r.quit().catch(() => {}); } };
}
