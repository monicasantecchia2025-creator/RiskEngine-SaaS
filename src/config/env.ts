import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(12),
  JWT_EXPIRES_IN: z.string().default('1d'),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PRICE_ID_MONTHLY: z.string().min(1),
  STRIPE_PRICE_ID_ANNUAL: z.string().min(1),
  METAAPI_TOKEN: z.string().min(1),
  METAAPI_BASE_URL: z.string().url(),
  DEFAULT_TIMEZONE: z.string().default('UTC'),
  WORKER_POLL_MS: z.coerce.number().default(5000),
  RISK_ENGINE_POLL_MS: z.coerce.number().default(500),
  MAX_RETRY_ATTEMPTS: z.coerce.number().default(10),
  APP_BASE_URL: z.string().url().default('http://localhost:3000')
});

export const env = envSchema.parse(process.env);
