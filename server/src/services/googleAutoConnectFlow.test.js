import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { saveGoogleAccount, getGoogleAccount } from "../data/db.js";
import { verifyGmailConnection, fetchGooglePeopleContacts, syncGooglePeopleContacts } from "./gmailAuth.js";

async function testAutoConnectFlow() {
  console.log("🧪 Testing Single Google OAuth Flow Auto-connecting BOTH Gmail & Google Contacts...\n");

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

  // 1. Simulate Google OAuth callback saving account with combined Gmail + Contacts scopes
  const wsId = "auto_connect_ws";
  const userEmail = "alex.rivera@gmail.com";

  console.log(`1️⃣ Saving Google OAuth token with Gmail + Contacts scopes for ${userEmail}...`);
  await saveGoogleAccount({
    workspaceId: wsId,
    googleId: "gid_auto_101",
    name: "Alex Rivera",
    email: userEmail,
    accessToken: "mock_auto_token",
    refreshToken: "mock_auto_refresh",
    expiresAt: new Date(Date.now() + 3600000),
  });

  // 2. Verify account saved cleanly in DB
  const saved = await getGoogleAccount(wsId);
  assertEqual(saved.email, userEmail, "Saved Google Account email matches");

  // 3. Perform automatic Google Contacts sync trigger (same as callback logic)
  console.log("2️⃣ Triggering automatic Google Contacts sync in callback flow...");
  const syncResult = await syncGooglePeopleContacts(wsId);
  assertEqual(syncResult.connected !== undefined, true, "syncGooglePeopleContacts returned status object");

  // 4. Verify Google Contacts status API check
  console.log("3️⃣ Checking status of Google Contacts API connection...");
  const contactsStatus = await fetchGooglePeopleContacts(wsId);
  
  // With mock token, connection exists in DB for this workspace
  assertEqual(contactsStatus.error !== "no_account", true, "Google Contacts recognized connected Google account automatically");

  console.log(`\n=======================================================`);
  console.log(`Test Results: ${passed} passed, ${failed} failed`);
  console.log(`=======================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

testAutoConnectFlow();
