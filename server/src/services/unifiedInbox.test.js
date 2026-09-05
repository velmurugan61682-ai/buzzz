import {
  saveUnifiedMessage,
  verifyIntegrationConnectionGate,
  fetchUnifiedInbox,
  saveInstaxBotConfig,
  deleteInstaxBotConfig,
  saveGoogleAccount,
  saveLinkedInAccount,
  UnifiedMessageModel,
} from "../data/db.js";
import { PLATFORM_META } from "../constants/platformMeta.js";

async function runUnifiedInboxTests() {
  console.log("🧪 Running Production Unified Inbox Test Suite...\n");

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  function assertEqual(actual, expected, message) {
    if (actual === expected) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      console.error(`     Expected: ${JSON.stringify(expected)}`);
      console.error(`     Actual:   ${JSON.stringify(actual)}`);
      failed++;
    }
  }

  const testWorkspace = `ws_test_${Date.now()}`;

  try {
    // ==============================================================================
    // TEST 1: Send the same InstaxBot webhook payload twice -> confirm ONLY 1 message created
    // ==============================================================================
    console.log("▶ TEST 1: Deduplication on duplicate InstaxBot webhook payload");

    const instaxPayload = {
      workspaceId: testWorkspace,
      conversationId: "conv_ig_test_1",
      integrationId: "instaxbot",
      platform: "instagram",
      externalMessageId: `ig_msg_dup_test_${Date.now()}`,
      sender: { name: "Test User", handle: "test_ig_user", kind: "customer" },
      direction: "inbound",
      text: "Hello from Instagram DM test payload",
      receivedAt: new Date().toISOString(),
    };

    // First insertion
    const res1 = await saveUnifiedMessage(instaxPayload);
    assert(res1.isNew === true, "First webhook delivery creates a new message (isNew: true)");

    // Second insertion (duplicate webhook retry)
    const res2 = await saveUnifiedMessage(instaxPayload);
    assert(res2.isNew === false, "Duplicate webhook delivery is deduplicated (isNew: false)");
    assertEqual(res2.doc.externalMessageId, instaxPayload.externalMessageId, "Duplicate doc returns existing message record");

    // Fetch inbox to verify count
    const inboxCount1 = await fetchUnifiedInbox(testWorkspace, 50);
    const instaxMsgs = inboxCount1.filter((m) => m.externalMessageId === instaxPayload.externalMessageId);
    assertEqual(instaxMsgs.length, 1, "Only ONE message exists in inbox for duplicate externalMessageId");

    // ==============================================================================
    // TEST 2: Disconnected platform gate -> confirm connection gate rejects
    // ==============================================================================
    console.log("\n▶ TEST 2: Connection Verification Gate rejection when disconnected");

    const disconnWs = `ws_disconn_${Date.now()}`;
    // Ensure InstaxBot is disconnected for disconnWs
    await deleteInstaxBotConfig(disconnWs);

    const gateResult = await verifyIntegrationConnectionGate(disconnWs, "instagram");
    assertEqual(gateResult.connected, false, "Connection gate rejects disconnected InstaxBot integration");
    assert(gateResult.reason.includes("disconnected"), "Rejection reason indicates disconnected state");

    // ==============================================================================
    // TEST 3: Multi-platform integration (Gmail + InstaxBot + LinkedIn) -> correct platform icon mapping
    // ==============================================================================
    console.log("\n▶ TEST 3: Multi-platform messages show correct distinct platform icons");

    // Connect all three integrations for test workspace
    await saveInstaxBotConfig({ workspaceId: testWorkspace, apiKey: "ib_live_12345", maskedKey: "••••2345" });
    await saveGoogleAccount({ workspaceId: testWorkspace, googleId: "g_123", email: "test@gmail.com", accessToken: "ya29.test" });
    await saveLinkedInAccount({ workspaceId: testWorkspace, linkedinId: "li_123", name: "LinkedIn User", accessToken: "li_tok_test" });

    // Send one message from each platform
    const gmailMsg = await saveUnifiedMessage({
      workspaceId: testWorkspace,
      conversationId: "conv_gmail_1",
      platform: "gmail",
      externalMessageId: `gmail_msg_${Date.now()}`,
      text: "Email inquiry about pricing",
    });

    const igMsg = await saveUnifiedMessage({
      workspaceId: testWorkspace,
      conversationId: "conv_ig_2",
      platform: "instagram",
      externalMessageId: `ig_msg_${Date.now()}`,
      text: "DM inquiry about product features",
    });

    const liMsg = await saveUnifiedMessage({
      workspaceId: testWorkspace,
      conversationId: "conv_li_1",
      platform: "linkedin",
      externalMessageId: `li_msg_${Date.now()}`,
      text: "InMail inquiry about enterprise demo",
    });

    // Check platform icon metadata lookup
    assertEqual(PLATFORM_META[gmailMsg.doc.platform].icon, "gmail", "Gmail message maps strictly to 'gmail' icon");
    assertEqual(PLATFORM_META[igMsg.doc.platform].icon, "instaxbot", "Instagram message maps strictly to 'instaxbot' icon");
    assertEqual(PLATFORM_META[liMsg.doc.platform].icon, "linkedin", "LinkedIn message maps strictly to 'linkedin' icon");

    // ==============================================================================
    // TEST 4: Rapid concurrent webhook retries -> confirm inbox count stays accurate
    // ==============================================================================
    console.log("\n▶ TEST 4: Rapid concurrent webhook retry simulation");

    const burstExtId = `burst_msg_${Date.now()}`;
    const burstPayload = {
      workspaceId: testWorkspace,
      conversationId: "conv_burst",
      platform: "whatsapp",
      externalMessageId: burstExtId,
      text: "Rapid retry message payload",
    };

    // Fire 5 concurrent insertion requests
    const promises = Array.from({ length: 5 }).map(() => saveUnifiedMessage(burstPayload));
    const burstResults = await Promise.all(promises);

    const newCounts = burstResults.filter((r) => r.isNew).length;
    assertEqual(newCounts, 1, "Exactly 1 out of 5 concurrent requests returned isNew: true");

    const finalInbox = await fetchUnifiedInbox(testWorkspace, 100);
    const burstMsgsInDb = finalInbox.filter((m) => m.externalMessageId === burstExtId);
    assertEqual(burstMsgsInDb.length, 1, "Inbox contains exactly 1 document despite 5 concurrent retries");

  } catch (err) {
    console.error("❌ Test suite encountered unhandled error:", err);
    failed++;
  }

  console.log(`\n=======================================================`);
  console.log(`Unified Inbox Test Results: ${passed} passed, ${failed} failed`);
  console.log(`=======================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runUnifiedInboxTests();
