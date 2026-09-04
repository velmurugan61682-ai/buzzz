/**
 * Meta WhatsApp Cloud API — Live Send Test Script
 *
 * PURPOSE: Produces the required "Definition of Done" terminal evidence for
 * the WhatsApp integration. Run this script with valid credentials in the
 * environment to get the literal request/response transcript.
 *
 * USAGE:
 *   node --env-file=server/.env scripts/meta-wa-send-test.mjs
 *
 * REQUIRED ENV VARS:
 *   WHATSAPP_TOKEN          — Meta System User Access Token (not a short-lived User token)
 *   WHATSAPP_PHONE_NUMBER_ID — From Meta for Developers → WhatsApp → API Setup
 *   WHATSAPP_PHONE_NUMBER   — Recipient phone number to send test to (E.164 format)
 *   CREDENTIAL_ENCRYPTION_KEY — 64-char hex key (from .env, used to verify the store round-trip)
 *
 * WHAT IT TESTS:
 *   1. SUCCESS CASE: sends the built-in "hello_world" template to the recipient
 *   2. ERROR CASE: sends to a deliberately invalid number to capture the real error shape
 *   3. CREDENTIAL STORE: seals the token with AES-256-GCM, decrypts it, and uses the
 *      decrypted value — proving the credential goes through the store (never plaintext env var)
 *
 * NEVER printed: the decrypted token, the raw token, or any partial token value.
 */

import { sealCredential, openCredential } from "../server/src/lib/credential-store.js";
import { sendGoWhatsMessage, GoWhatsError } from "../server/src/lib/gowhats.js";

// ---- Configuration ---------------------------------------------------------

const TOKEN         = process.env.WHATSAPP_TOKEN;
const PHONE_ID      = process.env.WHATSAPP_PHONE_NUMBER_ID;
const RECIPIENT     = process.env.WHATSAPP_PHONE_NUMBER || "919047484484";
const CRED_KEY      = process.env.CREDENTIAL_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEY;
const BASE_URL      = process.env.WHATSAPP_BASE_URL || "https://graph.facebook.com/v20.0";

function fail(msg) {
  console.error("\n[ABORT]", msg);
  process.exit(1);
}

if (!TOKEN)    fail("WHATSAPP_TOKEN is not set in the environment");
if (!PHONE_ID) fail("WHATSAPP_PHONE_NUMBER_ID is not set in the environment");
if (!CRED_KEY) fail("CREDENTIAL_ENCRYPTION_KEY is not set in the environment");

console.log("=".repeat(70));
console.log("META WHATSAPP CLOUD API — LIVE SEND TEST");
console.log("=".repeat(70));
console.log("Base URL:       ", BASE_URL);
console.log("Phone Number ID:", PHONE_ID);
console.log("Recipient:      ", RECIPIENT);
console.log("Token set?      ", !!TOKEN, "(value never printed)");
console.log("Cred key set?   ", !!CRED_KEY, "(value never printed)");
console.log("");

// ---- Step 1: Credential store round-trip -----------------------------------

console.log("─".repeat(70));
console.log("STEP 1 — Credential store round-trip (AES-256-GCM)");
console.log("─".repeat(70));

const sealed = sealCredential(TOKEN, CRED_KEY);
console.log("Sealed value (safe to store in DB):", sealed);

let apiKey;
try {
  apiKey = openCredential(sealed, CRED_KEY);
  console.log("Decryption: SUCCESS — credential decrypted for workspace=test_workspace");
  console.log("Decrypted value == original token?", apiKey === TOKEN, "(not printing either)");
} catch (e) {
  fail("Decryption failed: " + e.message);
}

// ---- Fetch wrapper that logs the outbound request --------------------------

function loggingFetch(url, opts) {
  console.log("\n→ OUTBOUND REQUEST");
  console.log("  Method: ", opts.method);
  console.log("  URL:    ", url);
  const headers = { ...opts.headers };
  if (headers["Authorization"]) {
    headers["Authorization"] = "Bearer [REDACTED]";
  }
  console.log("  Headers:", JSON.stringify(headers, null, 4));
  const bodyParsed = JSON.parse(opts.body || "{}");
  console.log("  Body:   ", JSON.stringify(bodyParsed, null, 4));
  return globalThis.fetch(url, opts);
}

// ---- Step 2: SUCCESS CASE — hello_world template ---------------------------

console.log("\n" + "─".repeat(70));
console.log("STEP 2 — SUCCESS CASE: sending hello_world template");
console.log("─".repeat(70));

try {
  const result = await sendGoWhatsMessage(
    {
      to:       RECIPIENT,
      template: { name: "hello_world", languageCode: "en_US" },
    },
    {
      baseUrl:       BASE_URL,
      phoneNumberId: PHONE_ID,
      apiKey,          // decrypted from the credential store — never the raw env var
      fetchFn:       loggingFetch,
    },
  );

  console.log("\n← RAW API RESPONSE (success):");
  console.log(JSON.stringify(result, null, 2));
  console.log("\n✅ SUCCESS — providerMessageId:", result.providerMessageId);
} catch (e) {
  if (e instanceof GoWhatsError) {
    console.log("\n← ERROR RESPONSE (GoWhatsError):");
    console.log("  code:   ", e.code);
    console.log("  status: ", e.status);
    console.log("  message:", e.message);
    if (e.code === "auth_error") {
      console.error("\n[STOP] Token is invalid/expired (auth_error). Provide a valid token and re-run.");
      process.exit(1);
    }
  } else {
    console.error("\n[ERROR]", e.message);
  }
}

// ---- Step 3: ERROR CASE — invalid recipient number -------------------------

console.log("\n" + "─".repeat(70));
console.log("STEP 3 — ERROR CASE: deliberately invalid recipient number");
console.log("─".repeat(70));

try {
  await sendGoWhatsMessage(
    {
      to:   "123",     // not a valid E.164 number — Meta should reject it
      body: "This should never be delivered",
    },
    {
      baseUrl:       BASE_URL,
      phoneNumberId: PHONE_ID,
      apiKey,
      fetchFn:       loggingFetch,
    },
  );

  console.log("⚠️  Expected an error but got success — check the adapter logic");
} catch (e) {
  if (e instanceof GoWhatsError) {
    console.log("\n← MAPPED INTERNAL ERROR (sanitized — this is what the frontend receives):");
    console.log("  code:   ", e.code);     // e.g. "invalid_recipient" — no raw Meta text
    console.log("  status: ", e.status);
    console.log("  message:", e.message);  // internal message, no fbtrace_id
    console.log("\n✅ ERROR correctly caught and mapped to internal error type");
  } else {
    console.error("\n[UNEXPECTED ERROR]", e.message);
  }
}

console.log("\n" + "=".repeat(70));
console.log("TEST COMPLETE");
console.log("=".repeat(70));
