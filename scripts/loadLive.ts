/* Opt-in load test for the /live namespace. NOT run by jest.
 * Usage: LOAD_URL=https://api.example.com LOAD_EVENT_ID=<id> LOAD_TOKENS_FILE=tokens.txt [LOAD_SOCKETS=300] npm run load:live
 * tokens.txt: one access token per line, each for a user with a confirmed booking on the event.
 * Tokens are read from a file so nothing secret lands in shell history or the repo. */
import { readFileSync } from 'node:fs';
import { io, Socket } from 'socket.io-client';

const url = process.env.LOAD_URL ?? 'http://localhost:4000';
const eventId = process.env.LOAD_EVENT_ID;
const file = process.env.LOAD_TOKENS_FILE;
const n = Number(process.env.LOAD_SOCKETS ?? 300);
const holdSec = Number(process.env.LOAD_HOLD_SEC ?? 60);
if (!eventId || !file) { console.error('LOAD_EVENT_ID and LOAD_TOKENS_FILE are required'); process.exit(1); }
const tokens = readFileSync(file, 'utf8').split('\n').map((t) => t.trim()).filter(Boolean);
if (!tokens.length) { console.error('no tokens'); process.exit(1); }

const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };

async function main() {
  const sockets: Socket[] = []; const connectMs: number[] = []; const joinMs: number[] = [];
  const errors: Record<string, number> = {}; const recv: Record<string, number> = {};
  const err = (k: string) => { errors[k] = (errors[k] ?? 0) + 1; };
  await Promise.all(Array.from({ length: n }, (_, i) => new Promise<void>((resolve) => {
    const t0 = Date.now();
    const s = io(`${url}/live`, { auth: { token: tokens[i % tokens.length] }, transports: ['websocket'], reconnection: false });
    sockets.push(s);
    s.onAny((ev) => { recv[ev] = (recv[ev] ?? 0) + 1; });
    s.on('connect_error', (e) => { err(`connect:${e.message}`); resolve(); });
    s.on('connect', async () => {
      connectMs.push(Date.now() - t0);
      const t1 = Date.now();
      try {
        const r = await s.timeout(10_000).emitWithAck('event:join', { eventId });
        if (r?.ok) joinMs.push(Date.now() - t1); else err(`join:${r?.error ?? 'unknown'}`);
      } catch { err('join:timeout'); }
      resolve();
    });
  })));
  const pinger = setInterval(() => sockets.forEach((s) => s.connected && s.emit('presence:ping', {}, () => {})), 10_000);
  console.log(`connected ${connectMs.length}/${n}, joined ${joinMs.length}; holding ${holdSec}s`);
  await new Promise((r) => setTimeout(r, holdSec * 1000));
  clearInterval(pinger);
  const alive = sockets.filter((s) => s.connected).length;
  sockets.forEach((s) => s.close());
  console.log(JSON.stringify({ sockets: n, connected: connectMs.length, joined: joinMs.length, aliveAtEnd: alive,
    connectMs: { p50: pct(connectMs, 50), p95: pct(connectMs, 95), p99: pct(connectMs, 99) },
    joinMs: { p50: pct(joinMs, 50), p95: pct(joinMs, 95), p99: pct(joinMs, 99) }, errors, received: recv }, null, 2));
  process.exit(0);
}
main();
