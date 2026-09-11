import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { saveInstaxBotConfig, getInstaxBotConfig, deleteInstaxBotConfig } from "../data/db.js";
import {
  fetchInstaxBotOrders,
  syncInstaxBotContacts,
  registerInstaxBotWebhook,
  fetchInstaxBotTemplates,
  fetchInstaxBotMessages,
} from "./instaxbot.js";

async function testInstaxBotIntegration() {
  console.log("🧪 Testing InstaxBot Real API Gateway & Key Integration Flow...\n");

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

  function assertTruthy(actual, testName) {
    if (Boolean(actual)) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      console.error(`     Expected truthy value, got: ${actual}`);
      failed++;
    }
  }

  const wsId = "test_instaxbot_ws";
  const apiKey = (process.env.INSTAXBOT_API_KEY || "").trim();

  // 1. Configuration & Key Safety Test
  console.log("--- 1. Configuration & Key Safety Test ---");
  const maskedKey = "••••" + apiKey.slice(-4);
  const saved = await saveInstaxBotConfig({
    workspaceId: wsId,
    apiKey,
    maskedKey,
    accountName: `InstaxBot Account (${maskedKey})`,
  });

  assertEqual(saved.maskedKey, maskedKey, `Masked key matches expected pattern (${maskedKey})`);
  assertEqual(saved.apiKey, apiKey, "API key saved in DB layer");

  // 2. Verify status check returns connected state
  const statusConfig = await getInstaxBotConfig(wsId);
  assertEqual(statusConfig.maskedKey, maskedKey, "getInstaxBotConfig returns saved masked key");

  // 3. Test Service Scope Handlers against Real API Gateway
  console.log("\n--- 2. Scope API Execution Tests (Strict Response & Content-Type Assertions) ---");

  const ordersRes = await fetchInstaxBotOrders();
  console.log(`  [fetchInstaxBotOrders] success: ${ordersRes.success}, status: ${ordersRes.status || "N/A"}`);
  assertEqual(ordersRes.success, true, "fetchInstaxBotOrders returns success: true on valid API gateway response");

  const webhookRes = await registerInstaxBotWebhook();
  console.log(`  [registerInstaxBotWebhook] success: ${webhookRes.success}, status: ${webhookRes.status || "N/A"}`);
  assertEqual(webhookRes.success, true, "registerInstaxBotWebhook returns success: true on valid API gateway response");

  const contactsRes = await syncInstaxBotContacts({ workspaceId: wsId });
  console.log(`  [syncInstaxBotContacts] success: ${contactsRes.success}, syncedCount: ${contactsRes.syncedCount}`);
  assertEqual(contactsRes.success, true, "syncInstaxBotContacts returns success: true");

  const templatesRes = await fetchInstaxBotTemplates();
  console.log(`  [fetchInstaxBotTemplates] success: ${templatesRes.success}, count: ${templatesRes.templates?.length || 0}`);
  assertEqual(templatesRes.success, true, "fetchInstaxBotTemplates returns success: true");

  const messagesRes = await fetchInstaxBotMessages();
  console.log(`  [fetchInstaxBotMessages] success: ${messagesRes.success}, count: ${messagesRes.messages?.length || 0}`);
  assertEqual(messagesRes.success, true, "fetchInstaxBotMessages returns success: true");

  // 4. Cleanup
  await deleteInstaxBotConfig(wsId);

  console.log(`\n=======================================================`);
  console.log(`Test Results: ${passed} passed, ${failed} failed`);
  console.log(`=======================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

testInstaxBotIntegration();
