/**
 * BUZZZ API — Environment Configuration & Validation Module
 *
 * Strict separation of concerns:
 * 1. Validates required core variables on startup.
 * 2. Identifies optional external integrations and exposes readiness flags.
 * 3. Prevents crashes when optional third-party credentials (Stripe, S3, GoWhats, etc.) are absent.
 * 4. Never exposes or logs raw secret values.
 */

import { z } from "zod";

/**
 * Zod Schema for BUZZZ Backend Environment
 */
const envSchema = z.object({
  // Application
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url().default("http://localhost:5173"),
  API_URL: z.string().url().default("http://localhost:4000"),
  ALLOWED_ORIGINS: z.string().default("https://buzzzbuzzz.com,https://app.buzzzbuzzz.com,http://localhost:5173"),
  CORS_ORIGIN: z.string().optional(),
  LOG_LEVEL: z.enum(["silent", "trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  GIT_SHA: z.string().default("dev"),
  npm_package_version: z.string().default("1.0.0"),

  // Database (PostgreSQL with RLS & pgvector)
  DATABASE_URL: z.string().min(1).default("postgres://buzzz:buzzz@localhost:5432/buzzz"),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  MONGODB_URI: z.string().optional(),

  // Redis (Queue, Rate-limits, Caching)
  REDIS_URL: z.string().optional(),

  // Authentication & Session
  JWT_SECRET: z.string().optional(),
  JWT_REFRESH_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().optional(),

  // Encryption Keys
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),

  // AI & LLM Providers
  OPENROUTER_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("openai/gpt-4o-mini"),
  ANTHROPIC_API_KEY: z.string().optional(),

  // GoWhats (WhatsApp Business API)
  GOWHATS_BASE_URL: z.string().url().default("https://api.gowhats.app"),
  GOWHATS_API_KEY: z.string().optional(),
  GOWHATS_WEBHOOK_SECRET: z.string().optional(),

  // MrAssistant.ai (Voice AI)
  MRASSISTANT_BASE_URL: z.string().url().default("https://api.mrassistant.ai"),
  MRASSISTANT_API_KEY: z.string().optional(),
  MRASSISTANT_CLIENT_ID: z.string().optional(),
  MRASSISTANT_CLIENT_SECRET: z.string().optional(),
  MRASSISTANT_WEBHOOK_SECRET: z.string().optional(),

  // OAuth Integrations (Google Calendar / Meet)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  GOOGLE_WEBHOOK_URL: z.string().optional(),

  // Social Sign-in OAuth
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  APPLE_OAUTH_CLIENT_ID: z.string().optional(),
  APPLE_OAUTH_CLIENT_SECRET: z.string().optional(),

  // Stripe Payments & Billing
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // S3 Compatible Object Storage
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  // Email / SMTP
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().default("noreply@buzzzbuzzz.com"),

  // Monitoring
  SENTRY_DSN: z.string().optional(),
});

/**
 * Validates the environment and returns typed config object.
 * In production mode, enforces that critical variables (e.g. DATABASE_URL, secrets) are present.
 */
export function validateEnv(rawEnv = process.env) {
  const result = envSchema.safeParse(rawEnv);

  if (!result.success) {
    const errorDetails = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`[BUZZZ Config Error] Invalid environment variables:\n${errorDetails}`);
  }

  const parsed = result.data;
  const isProd = parsed.NODE_ENV === "production";

  // Production-specific critical enforcement
  if (isProd) {
    const missingProdSecrets = [];
    if (!parsed.DATABASE_URL || parsed.DATABASE_URL.includes("localhost")) {
      missingProdSecrets.push("DATABASE_URL must be configured with a production PostgreSQL connection string");
    }
    if (!parsed.TOKEN_ENCRYPTION_KEY && !parsed.ENCRYPTION_KEY) {
      missingProdSecrets.push("TOKEN_ENCRYPTION_KEY or ENCRYPTION_KEY must be defined in production");
    }

    if (missingProdSecrets.length > 0) {
      throw new Error(
        `[BUZZZ Config Error] Missing critical production configuration:\n` +
        missingProdSecrets.map((m) => `  - ${m}`).join("\n")
      );
    }
  }

  // Parse CORS origins
  const originList = parsed.CORS_ORIGIN
    ? parsed.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)
    : parsed.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);

  // Integration readiness flags
  const integrations = {
    googleCalendar: Boolean(parsed.GOOGLE_CLIENT_ID && parsed.GOOGLE_CLIENT_SECRET),
    googleOAuth: Boolean(parsed.GOOGLE_OAUTH_CLIENT_ID && parsed.GOOGLE_OAUTH_CLIENT_SECRET),
    appleOAuth: Boolean(parsed.APPLE_OAUTH_CLIENT_ID && parsed.APPLE_OAUTH_CLIENT_SECRET),
    mrAssistant: Boolean(parsed.MRASSISTANT_API_KEY || (parsed.MRASSISTANT_CLIENT_ID && parsed.MRASSISTANT_CLIENT_SECRET)),
    goWhats: Boolean(parsed.GOWHATS_API_KEY),
    stripe: Boolean(parsed.STRIPE_SECRET_KEY),
    s3: Boolean(parsed.S3_BUCKET && parsed.S3_ACCESS_KEY_ID && parsed.S3_SECRET_ACCESS_KEY),
    smtp: Boolean(parsed.SMTP_HOST && parsed.SMTP_USER && parsed.SMTP_PASSWORD),
    redis: Boolean(parsed.REDIS_URL),
    mongodb: Boolean(parsed.MONGODB_URI),
    llm: Boolean(parsed.OPENROUTER_API_KEY || parsed.OPENAI_API_KEY || parsed.ANTHROPIC_API_KEY),
  };

  return {
    ...parsed,
    origins: originList,
    integrations,
  };
}

/**
 * Returns a sanitized representation of the configuration for health checks or debugging,
 * guaranteeing no secrets or private keys are ever leaked in output.
 */
export function getSanitizedConfig(config) {
  return {
    nodeEnv: config.NODE_ENV,
    port: config.PORT,
    appUrl: config.APP_URL,
    apiUrl: config.API_URL,
    allowedOrigins: config.origins,
    version: config.npm_package_version,
    gitSha: config.GIT_SHA,
    integrations: config.integrations,
  };
}

export const env = validateEnv();
