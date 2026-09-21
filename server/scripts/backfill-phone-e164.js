#!/usr/bin/env node
/**
 * scripts/backfill-phone-e164.js
 *
 * One-shot migration: sets `phone_e164` (E.164 canonical) on all Contact
 * documents that have a non-empty `phone` but no `phone_e164` yet.
 *
 * Usage:
 *   node scripts/backfill-phone-e164.js
 *
 * Requires MONGODB_URI in server/.env (uses dotenv).
 *
 * Safe to re-run multiple times — uses { phone_e164: null } guard.
 */

import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

import { connectDB, backfillPhoneE164 } from "../src/data/db.js";

console.log("🔧 [BACKFILL] Starting phone_e164 backfill migration...");

try {
  await connectDB();
  const result = await backfillPhoneE164();
  console.log(`✅ [BACKFILL] Done: ${result.processed} processed, ${result.updated} updated.`);
  process.exit(0);
} catch (err) {
  console.error("❌ [BACKFILL] Error:", err.message);
  process.exit(1);
}
