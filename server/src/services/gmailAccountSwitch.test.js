import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { saveGoogleAccount, getGoogleAccount } from "../data/db.js";

async function testAccountSwitching() {
  console.log("🧪 Running Gmail Account Switching & Email Sync Test...\n");

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

  // 1. Connect Account A (userA@gmail.com)
  const accA = await saveGoogleAccount({
    workspaceId: "test_ws",
    googleId: "gid_userA",
    name: "User Alpha",
    email: "userA@gmail.com",
    accessToken: "mock_token_A",
    refreshToken: "mock_refresh_A",
    expiresAt: new Date(Date.now() + 3600000),
  });

  assertEqual(accA.email, "userA@gmail.com", "Save Account A returns userA@gmail.com");

  // 2. Fetch active account from DB
  const fetchedA = await getGoogleAccount("test_ws");
  assertEqual(fetchedA.email, "userA@gmail.com", "getGoogleAccount returns Account A email");

  // Wait 10ms to ensure timestamp difference
  await new Promise((r) => setTimeout(r, 10));

  // 3. Connect Account B (userB@gmail.com)
  const accB = await saveGoogleAccount({
    workspaceId: "test_ws",
    googleId: "gid_userB",
    name: "User Beta",
    email: "userB@gmail.com",
    accessToken: "mock_token_B",
    refreshToken: "mock_refresh_B",
    expiresAt: new Date(Date.now() + 3600000),
  });

  assertEqual(accB.email, "userB@gmail.com", "Save Account B returns userB@gmail.com");

  // 4. Verify DB now returns Account B as the most recent active account (no stale Account A email)
  const fetchedB = await getGoogleAccount("test_ws");
  assertEqual(
    fetchedB.email,
    "userB@gmail.com",
    "getGoogleAccount returns Account B email as most recent (no stale Account A data)"
  );

  console.log(`\n=======================================================`);
  console.log(`Test Results: ${passed} passed, ${failed} failed`);
  console.log(`=======================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

testAccountSwitching();
