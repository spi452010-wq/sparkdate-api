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
