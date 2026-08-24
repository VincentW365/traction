import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().default(''),
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),
  API_PORT: z.coerce.number().default(3001),
  API_CORS_ORIGIN: z.string().default('http://localhost:3000'),
  NOTIFICATION_PROVIDER: z
    .enum(['stub', 'twilio', 'sendgrid'])
    .default('stub'),
  // CR-2026-033 — Twilio SMS credentials. Optional in the schema; the provider
  // factory requires SID + token + (from-number OR messaging-service-sid) only
  // when NOTIFICATION_PROVIDER=twilio. Never committed — set in env/.env.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  // CR-2026-096 — notification routing mode. TEST (the default) redirects every
  // customer send to the configured test recipients; reaching real customers
  // requires an EXPLICIT NOTIFICATION_MODE=LIVE in deployment config. With the
  // stub provider the mode is recorded but nothing real is sent either way.
  NOTIFICATION_MODE: z.enum(['TEST', 'LIVE']).default('TEST'),
  NOTIFICATION_TEST_SMS_TO: z.string().optional(),
  NOTIFICATION_TEST_EMAIL_TO: z.string().optional(),
  // VIN decode: STUB (no outbound calls) by default; LIVE opt-in enables NHTSA vPIC.
  VIN_DECODE_PROVIDER: z.enum(['STUB', 'LIVE']).default('STUB'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  DEFAULT_SITE_CODE: z.string().default('BERT-01'),
  // CR-2026-022 — runtime environment; dev-login is ALWAYS refused when 'production'.
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // CR-2026-022 — gate for the dev-only one-click role login. Default OFF.
  // Effective only when ALLOW_DEV_LOGIN=true AND NODE_ENV !== 'production'.
  ALLOW_DEV_LOGIN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // CR-2026-020 — gate for the test-data sandbox tooling (create/cleanup runner).
  // Default OFF; enable only in local/staging. Must never be true in production.
  ALLOW_TEST_DATA_TOOLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(env: Record<string, unknown> = process.env): Env {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const formatted = result.error.format();
    console.error('Environment validation failed:', formatted);
    throw new Error('Invalid environment configuration');
  }
  return result.data;
}
