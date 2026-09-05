import { saveInstaxBotConfig, getInstaxBotConfig, deleteInstaxBotConfig } from "../data/db.js";

async function testInstaxBotIntegration() {
  console.log("🧪 Testing InstaxBot API Key Integration Flow...\n");

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

  const wsId = "test_instaxbot_ws";
  const validKey = "ib_live_9f2a841d77e0";

  // 1. Initially no config exists
  const initial = await getInstaxBotConfig(wsId);
  assertEqual(initial, null, "Initially no InstaxBot config exists");

  // 2. Connect with valid key
  const maskedKey = "••••" + validKey.slice(-4);
  const saved = await saveInstaxBotConfig({
    workspaceId: wsId,
    apiKey: validKey,
    maskedKey,
    accountName: `InstaxBot Account (${maskedKey})`,
  });

  assertEqual(saved.maskedKey, "••••77e0", "Masked key matches last 4 characters");
  assertEqual(saved.apiKey, validKey, "API key saved in DB layer");

  // 3. Verify status check returns connected state
  const statusConfig = await getInstaxBotConfig(wsId);
  assertEqual(statusConfig.maskedKey, "••••77e0", "getInstaxBotConfig returns saved masked key");

  // 4. Disconnect InstaxBot
  await deleteInstaxBotConfig(wsId);
  const disconnected = await getInstaxBotConfig(wsId);
  assertEqual(disconnected, null, "After disconnect, InstaxBot config is removed");

  console.log(`\n=======================================================`);
  console.log(`Test Results: ${passed} passed, ${failed} failed`);
  console.log(`=======================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

testInstaxBotIntegration();
