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
  // VIN decode: STUB (no outbound calls) by default; LIVE opt-in enables NHTSA vPIC.
  VIN_DECODE_PROVIDER: z.enum(['STUB', 'LIVE']).default('STUB'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  DEFAULT_SITE_CODE: z.string().default('BERT-01'),
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
