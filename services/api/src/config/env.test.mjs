/**
 * Tests for BUZZZ Environment Validation Module
 */
import assert from "node:assert/strict";
import { validateEnv, getSanitizedConfig } from "./env.js";

// Test 1: Default development configuration parses cleanly
{
  const config = validateEnv({
    NODE_ENV: "development",
  });
  assert.equal(config.NODE_ENV, "development");
  assert.equal(config.PORT, 4000);
  assert.equal(config.integrations.stripe, false);
  assert.equal(config.integrations.googleCalendar, false);
  assert.ok(Array.isArray(config.origins));
  assert.ok(config.origins.includes("http://localhost:5173"));
}

// Test 2: Custom origins and port parsing
{
  const config = validateEnv({
    NODE_ENV: "development",
    PORT: "5050",
    ALLOWED_ORIGINS: "https://custom.app,https://admin.custom.app",
    OPENAI_API_KEY: "sk-test-key",
  });
  assert.equal(config.PORT, 5050);
  assert.deepEqual(config.origins, ["https://custom.app", "https://admin.custom.app"]);
  assert.equal(config.integrations.llm, true);
  assert.equal(config.integrations.stripe, false);
}

// Test 3: Optional integrations activate flags when provided
{
  const config = validateEnv({
    NODE_ENV: "development",
    GOOGLE_CLIENT_ID: "g-id",
    GOOGLE_CLIENT_SECRET: "g-secret",
    STRIPE_SECRET_KEY: "sk_test_123",
    GOWHATS_API_KEY: "gowhats_key",
    REDIS_URL: "redis://localhost:6379",
    MONGODB_URI: "mongodb://localhost:27017/buzzz",
  });
  assert.equal(config.integrations.googleCalendar, true);
  assert.equal(config.integrations.stripe, true);
  assert.equal(config.integrations.goWhats, true);
  assert.equal(config.integrations.redis, true);
  assert.equal(config.integrations.mongodb, true);
  assert.equal(config.integrations.appleOAuth, false);
}

// Test 4: Production enforcement throws on missing critical secrets
{
  assert.throws(
    () => {
      validateEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://localhost/buzzz", // localhost rejected in prod
      });
    },
    (err) => err.message.includes("[BUZZZ Config Error]")
  );
}

// Test 5: Sanitized config never includes secret keys
{
  const config = validateEnv({
    NODE_ENV: "development",
    OPENAI_API_KEY: "super-secret-key",
    TOKEN_ENCRYPTION_KEY: "hex-token-secret",
    STRIPE_SECRET_KEY: "sk_live_12345",
  });
  const sanitized = getSanitizedConfig(config);
  const jsonStr = JSON.stringify(sanitized);
  assert.ok(!jsonStr.includes("super-secret-key"));
  assert.ok(!jsonStr.includes("hex-token-secret"));
  assert.ok(!jsonStr.includes("sk_live_12345"));
  assert.equal(sanitized.integrations.stripe, true);
  assert.equal(sanitized.integrations.llm, true);
}

console.log("env validation: all checks passed");
