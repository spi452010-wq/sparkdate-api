import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGO_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  GOOGLE_CLIENT_IDS: z.string().default(''),
  WHATSAPP_PROVIDER: z.enum(['console', 'meta']).default('console'),
  META_WA_TOKEN: z.string().optional(),
  META_WA_PHONE_NUMBER_ID: z.string().optional(),
  META_WA_TEMPLATE: z.string().default('otp_login'),
  UPLOAD_DIR: z.string().default('/var/sparkdate/uploads'),
  MEDIA_URL_SECRET: z.string().min(32),
  MEDIA_URL_TTL_SEC: z.coerce.number().int().positive().default(900),
  PUBLIC_BASE_URL: z.string().default('http://localhost:4000'),
  USE_X_ACCEL: z.enum(['true','false']).default('false'),
  AUTH_IP_LIMIT_PER_15MIN: z.coerce.number().int().positive().default(30),
  ADMIN_LOGIN_IP_LIMIT_PER_15MIN: z.coerce.number().int().positive().default(10),
  CORS_ORIGINS: z.string().default(''),
  // Sprint 2: Play Billing, Pub/Sub RTDN, jobs, notifications. Optional in dev/test; required in production (see below).
  PLAY_PACKAGE_NAME: z.string().default(''),
  GOOGLE_PLAY_SA_JSON_PATH: z.string().default(''),
  CHAT_PASS_PRODUCT_ID: z.string().regex(/^[a-z0-9_.]{1,100}$/).default('chat_pass_monthly'),
  PUBSUB_PUSH_AUDIENCE: z.string().default(''),
  PUBSUB_SA_EMAIL: z.string().default(''),
  REDIS_URL: z.string().default(''),
  BOOKING_HOLD_MIN: z.coerce.number().int().min(1).max(60).default(10),
  PENDING_PURCHASE_HOLD_MIN: z.coerce.number().int().min(1).max(120).default(30),
  AUTO_REFUND_NO_MATCH: z.enum(['true', 'false']).default('false'),
  FCM_SA_JSON_PATH: z.string().default(''),
  // Sprint 3: live session. LIVEKIT_* optional in dev/test (placeholder tokens); required in production (see below).
  LIVEKIT_URL: z.string().default(''),
  LIVEKIT_API_KEY: z.string().default(''),
  LIVEKIT_API_SECRET: z.string().default(''),
  ROUND_BREAK_SEC: z.coerce.number().int().min(5).max(600).default(30),
  DECISION_WINDOW_SEC: z.coerce.number().int().min(10).max(600).default(60),
  RECONNECT_GRACE_SEC: z.coerce.number().int().min(5).max(120).default(20),
  LIVE_PRESENCE_TTL_SEC: z.coerce.number().int().min(15).max(300).default(30),
  LIVE_LOBBY_THROTTLE_MS: z.coerce.number().int().min(0).max(10_000).default(1000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Never print values, only which keys are invalid.
  console.error('Invalid environment:', Object.keys(parsed.error.flatten().fieldErrors));
  process.exit(1);
}
export const env = parsed.data;

const SECRET_KEYS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'MEDIA_URL_SECRET'] as const;
const PLACEHOLDER_RE = /change[-_ ]?me|changeme|example|placeholder|your[-_]|secret123|^x+$/i;

/**
 * Returns names (never values) of secrets that are unsafe for production:
 * placeholder-looking values (e.g. from the public .env.example) or secrets reused across keys.
 */
export function findUnsafeSecrets(e: Record<string, string | undefined>): string[] {
  const bad = new Set<string>();
  for (const k of SECRET_KEYS) {
    const v = e[k] ?? '';
    if (PLACEHOLDER_RE.test(v)) bad.add(k);
  }
  for (let i = 0; i < SECRET_KEYS.length; i++)
    for (let j = i + 1; j < SECRET_KEYS.length; j++)
      if (e[SECRET_KEYS[i]] && e[SECRET_KEYS[i]] === e[SECRET_KEYS[j]]) {
        bad.add(SECRET_KEYS[i]); bad.add(SECRET_KEYS[j]);
      }
  return [...bad];
}

if (env.NODE_ENV === 'production') {
  const unsafe = findUnsafeSecrets(env as unknown as Record<string, string>);
  if (unsafe.length) {
    console.error('Refusing to start: placeholder or reused secrets in production:', unsafe);
    process.exit(1);
  }
}
if (env.NODE_ENV === 'production' && env.WHATSAPP_PROVIDER === 'console') {
  console.error('WHATSAPP_PROVIDER=console is not allowed in production');
  process.exit(1);
}

export const PROD_REQUIRED = ['PLAY_PACKAGE_NAME', 'GOOGLE_PLAY_SA_JSON_PATH', 'PUBSUB_PUSH_AUDIENCE', 'PUBSUB_SA_EMAIL', 'REDIS_URL'] as const;
/** Names (never values) of Sprint 2 settings that are missing or unsafe for production. */
export function findMissingProdConfig(e: Record<string, string | undefined>, cwd = process.cwd()): string[] {
  const bad: string[] = PROD_REQUIRED.filter((k) => !e[k] || PLACEHOLDER_RE.test(e[k]!));
  // Service account keys must live outside the repo / deploy directory.
  for (const k of ['GOOGLE_PLAY_SA_JSON_PATH', 'FCM_SA_JSON_PATH'] as const) {
    const v = e[k];
    if (v && !bad.includes(k)) {
      const abs = require('path').resolve(cwd, v) as string;
      if (abs === cwd || abs.startsWith(cwd + require('path').sep)) bad.push(k);
    }
  }
  if (e.PUBSUB_PUSH_AUDIENCE && !/^https:\/\//.test(e.PUBSUB_PUSH_AUDIENCE) && !bad.includes('PUBSUB_PUSH_AUDIENCE')) bad.push('PUBSUB_PUSH_AUDIENCE');
  return bad;
}
if (env.NODE_ENV === 'production') {
  const missing = findMissingProdConfig(env as unknown as Record<string, string>);
  if (missing.length) {
    console.error('Refusing to start: missing or unsafe production config:', missing);
    process.exit(1);
  }
}

/** Names (never values) of Sprint 3 LiveKit settings that are missing or unsafe for production. */
export function findMissingLiveConfig(e: Record<string, string | undefined>): string[] {
  const bad = (['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const).filter((k) => !e[k] || PLACEHOLDER_RE.test(e[k]!)) as string[];
  if (e.LIVEKIT_URL && !bad.includes('LIVEKIT_URL') && !/^wss:\/\//.test(e.LIVEKIT_URL)) bad.push('LIVEKIT_URL');
  if (e.LIVEKIT_API_SECRET && !bad.includes('LIVEKIT_API_SECRET') && e.LIVEKIT_API_SECRET.length < 32) bad.push('LIVEKIT_API_SECRET');
  return bad;
}
if (env.NODE_ENV === 'production') {
  const missing = findMissingLiveConfig(env as unknown as Record<string, string>);
  if (missing.length) {
    console.error('Refusing to start: missing or unsafe LiveKit config:', missing);
    process.exit(1);
  }
}
