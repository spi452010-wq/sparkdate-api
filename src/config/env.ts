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
if (env.NODE_ENV === 'production' && env.WHATSAPP_PROVIDER === 'console') {
  console.error('WHATSAPP_PROVIDER=console is not allowed in production');
  process.exit(1);
}
