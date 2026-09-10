import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { sanitizeMessage, getValidGoogleAccount } from "./gmailAuth.js";

async function runTests() {
  console.log("🧪 Running Gmail OAuth integration service unit tests...\n");

  let passed = 0;
  let failed = 0;

  function assertEqual(actual, expected, testName) {
    if (actual === expected) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      console.error(`     Expected: ${expected}`);
      console.error(`     Actual:   ${actual}`);
      failed++;
    }
  }

  // Test 1: Sanitize message redacts secrets
  const secretString = "Failed token exchange for secret GOCSPX-1234567890abcdef and access_token=ya29.abcdef1234567890";
  const sanitized = sanitizeMessage(secretString);
  assertEqual(
    sanitized.includes("GOCSPX-1234567890abcdef"),
    false,
    "sanitizeMessage redacts GOCSPX client secret"
  );
  assertEqual(
    sanitized.includes("ya29.abcdef1234567890"),
    false,
    "sanitizeMessage redacts ya29 access token"
  );

  // Test 2: getValidGoogleAccount handles null account gracefully
  const nullAccount = await getValidGoogleAccount("non_existent_ws");
  assertEqual(nullAccount, null, "getValidGoogleAccount returns null for unknown workspace");

  console.log(`\n=======================================================`);
  console.log(`Test Results: ${passed} passed, ${failed} failed`);
  console.log(`=======================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
