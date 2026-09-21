import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { connectDB, fetchConversations, fetchMessagesByConversationId } from "../data/db.js";
import { verifyGmailConnection, syncGmailMessages } from "../services/gmailAuth.js";

async function runTests() {
  console.log("=========================================");
  console.log("RUNNING GMAIL & EMAIL INTEGRATION TESTS");
  console.log("=========================================");

  await connectDB();

  // Test 1: verifyGmailConnection returns connected with live email
  console.log("TEST 1: verifyGmailConnection live status...");
  const status = await verifyGmailConnection("ws_default");
  console.log("Live status:", status);
  if (!status.connected || !status.email) {
    throw new Error(`TEST 1 FAILED: Gmail not connected (${status.error || status.reason})`);
  }
  console.log("✅ TEST 1 PASSED: Gmail is verified and connected as", status.email);

  // Test 2: syncGmailMessages fetches and ingests without errors
  console.log("\nTEST 2: syncGmailMessages execution...");
  const syncResult = await syncGmailMessages("ws_default");
  console.log("Sync result:", syncResult);
  if (!syncResult.connected || !syncResult.success) {
    throw new Error(`TEST 2 FAILED: syncGmailMessages failed (${syncResult.error})`);
  }
  console.log("✅ TEST 2 PASSED: syncGmailMessages completed successfully, checked", syncResult.totalChecked, "messages.");

  // Test 3: Email conversations exist and can be retrieved
  console.log("\nTEST 3: Checking Email conversations in DB...");
  const convs = await fetchConversations("ws_default");
  const emailConvs = convs.filter((c) =>
    ["Email", "email", "Gmail", "gmail"].includes(c.channel) ||
    ["Email", "email", "Gmail", "gmail"].includes(c.platform)
  );
  console.log(`Found ${emailConvs.length} email conversations in unified inbox.`);
  if (emailConvs.length === 0) {
    throw new Error("TEST 3 FAILED: No email conversations found in DB.");
  }
  const sample = emailConvs[0];
  console.log(`Sample Conv ID: ${sample.id} | Customer: ${sample.customerName} | Email: ${sample.email || sample.phone}`);

  const msgs = await fetchMessagesByConversationId(sample.id);
  console.log(`Retrieved ${msgs.length} messages for sample conversation.`);
  console.log("✅ TEST 3 PASSED: Email conversation and message retrieval confirmed.");

  console.log("\n=========================================");
  console.log("ALL GMAIL & EMAIL INTEGRATION TESTS PASSED");
  console.log("=========================================");
  process.exit(0);
}

runTests().catch((e) => {
  console.error("❌ TEST FAILED:", e.message);
  process.exit(1);
});
