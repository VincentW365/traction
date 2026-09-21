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
  // CR-2026-106 — the ONE browser-reachable base URL of the web app (e.g.
  // https://bsop-web.onrender.com, no trailing slash). Every customer-facing link
  // (status page, booking manage link, booking link) is built from it — never from
  // whichever internal host received the request. Falls back to the first CORS
  // origin for local development; deploy-check FAILS in production when it is
  // unset, localhost, or a private address.
  PUBLIC_APP_URL: z.string().url().optional(),
  // CR-2026-112 — customer notifications are EMAIL ONLY in this release. The
  // SMS provider selector and the Twilio credentials were removed with the SMS
  // implementation: nothing reads them, and an unconfigured SMS provider can no
  // longer affect email because there is no SMS provider. A future SMS phase
  // adds its own keys back alongside the email ones.
  //
  // CR-2026-099 — email delivery. `smtp` sends real mail through any SMTP
  // mailbox (Microsoft 365, Google Workspace, a relay); `stub` records only.
  EMAIL_PROVIDER: z.enum(['stub', 'smtp']).default('stub'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  // CR-2026-096 — notification routing mode. TEST (the default) redirects every
  // customer send to the configured test recipients; reaching real customers
  // requires an EXPLICIT NOTIFICATION_MODE=LIVE in deployment config. With the
  // stub provider the mode is recorded but nothing real is sent either way.
  NOTIFICATION_MODE: z.enum(['TEST', 'LIVE']).default('TEST'),
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
