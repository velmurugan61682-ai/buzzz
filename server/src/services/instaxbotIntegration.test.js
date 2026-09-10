import { saveInstaxBotConfig, getInstaxBotConfig, deleteInstaxBotConfig } from "../data/db.js";
import { fetchInstaxBotOrders, syncInstaxBotContacts, registerInstaxBotWebhook, fetchInstaxBotTemplates, fetchInstaxBotMessages } from "./instaxbot.js";

async function testInstaxBotIntegration() {
  console.log("🧪 Testing InstaxBot API Key Integration Flow & 8 Permission Scopes...\n");

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
  const validKey = "ib_live_9f2a841d77e0";

  // 1. Connect with valid key
  const maskedKey = "••••" + validKey.slice(-4);
  const saved = await saveInstaxBotConfig({
    workspaceId: wsId,
    apiKey: validKey,
    maskedKey,
    accountName: `InstaxBot Account (${maskedKey})`,
  });

  assertEqual(saved.maskedKey, "••••77e0", "Masked key matches last 4 characters");
  assertEqual(saved.apiKey, validKey, "API key saved in DB layer");

  // 2. Verify status check returns connected state
  const statusConfig = await getInstaxBotConfig(wsId);
  assertEqual(statusConfig.maskedKey, "••••77e0", "getInstaxBotConfig returns saved masked key");

  // 3. Test Service Scope Handlers (webhooks.manage, orders.read, contacts.read, templates.read, messages.read)
  console.log("\n  --- Scope API Execution Tests ---");

  const ordersRes = await fetchInstaxBotOrders({ overrideKey: validKey });
  assertTruthy(ordersRes !== undefined, "fetchInstaxBotOrders executes without throwing");

  const webhookRes = await registerInstaxBotWebhook({ overrideKey: validKey });
  assertTruthy(webhookRes !== undefined, "registerInstaxBotWebhook executes without throwing");

  const contactsRes = await syncInstaxBotContacts({ workspaceId: wsId, overrideKey: validKey });
  assertTruthy(contactsRes.syncedCount !== undefined, "syncInstaxBotContacts returns synced count");

  const templatesRes = await fetchInstaxBotTemplates({ overrideKey: validKey });
  assertTruthy(Array.isArray(templatesRes.templates), "fetchInstaxBotTemplates returns templates array");

  const messagesRes = await fetchInstaxBotMessages({ overrideKey: validKey });
  assertTruthy(Array.isArray(messagesRes.messages), "fetchInstaxBotMessages returns messages array");

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
