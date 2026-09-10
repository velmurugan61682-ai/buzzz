import {
  isChannelBotInConfigured,
  getChannelBotInConfigStatus,
  verifyChannelBotInConnection,
  fetchYouTubeComments,
  syncChannelBotLeads,
  updateChannelBotLeadStatus,
} from "./channelbot.js";

async function testChannelBotInIntegration() {
  console.log("🧪 Testing ChannelBot.in (YouTube Comment & Lead Automation) Integration...\n");

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

  // 1. Configuration & Key Safety Check
  console.log("--- 1. Configuration & Key Safety Test ---");
  assertEqual(isChannelBotInConfigured(), true, "isChannelBotInConfigured returns true when process.env.CHANNELBOT_IN_API_KEY is present");
  const configStatus = getChannelBotInConfigStatus();
  assertEqual(configStatus.configured, true, "getChannelBotInConfigStatus reports configured: true");
  assertEqual(configStatus.keyPrefix, "yt_", "getChannelBotInConfigStatus reports prefix: yt_");

  // 2. Connection Health & Usage Tracker Test
  console.log("\n--- 2. Connection Health & Dashboard Call Counter Test ---");
  const health = await verifyChannelBotInConnection();
  assertEqual(health.connected, true, "verifyChannelBotInConnection connects successfully using CHANNELBOT_IN_API_KEY");

  // 3. Scope: comments:read (YouTube Comments)
  console.log("\n--- 3. Scope: comments:read Test ---");
  const commentsRes = await fetchYouTubeComments({ limit: 10 });
  assertEqual(commentsRes.success, true, "fetchYouTubeComments returns success: true");
  assertTruthy(Array.isArray(commentsRes.comments), "fetchYouTubeComments returns array of comments");

  // 4. Scope: leads:read / customers:read (Lead Sync)
  console.log("\n--- 4. Scope: leads:read / customers:read Sync Test ---");
  const leadSync = await syncChannelBotLeads({ workspaceId: "test_ws" });
  assertEqual(leadSync.success, true, "syncChannelBotLeads returns success: true");
  assertTruthy(typeof leadSync.syncedCount === "number", "syncChannelBotLeads returns numeric syncedCount");

  // 5. Scope: leads:write (Lead Qualification Status Update)
  console.log("\n--- 5. Scope: leads:write Test ---");
  const leadUpdate = await updateChannelBotLeadStatus({ leadId: "lead_test_123", status: "qualified" });
  assertEqual(leadUpdate.success, true, "updateChannelBotLeadStatus returns success: true");

  console.log(`\n=======================================================`);
  console.log(`Test Results: ${passed} passed, ${failed} failed`);
  console.log(`=======================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

testChannelBotInIntegration();
