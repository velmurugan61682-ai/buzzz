import "dotenv/config";
import { connectDB, ConversationModel, MessageModel, UnifiedMessageModel, getGoogleAccount } from "../data/db.js";

async function runTest() {
  console.log("🧪 Starting Email Fetch All & Outbound Reply Integration Test...\n");
  await connectDB();

  // Test 1: Verify Google / Gmail account is active in DB
  const acc = await getGoogleAccount("ws_default");
  if (!acc || !acc.accessToken) {
    throw new Error("No active Google account connected for ws_default in DB.");
  }
  console.log(`Test 1: Verified Google account connected: ${acc.email}`);

  // Test 2: Call POST /api/gmail/messages/sync with fetchAll: true
  console.log("\nTest 2: Calling POST http://localhost:5000/api/gmail/messages/sync with fetchAll: true...");
  const syncRes = await fetch("http://localhost:5000/api/gmail/messages/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: "ws_default", fetchAll: true, limit: 60 }),
  });
  const syncData = await syncRes.json();
  console.log("  Sync Response:", syncData);
  if (!syncData || (!syncData.success && !syncData.connected)) {
    throw new Error("Email sync endpoint failed: " + JSON.stringify(syncData));
  }
  console.log(`  ✓ Email fetchAll completed. Total checked: ${syncData.totalChecked}, New ingested: ${syncData.count}`);

  // Test 3: Verify email conversation exists with a valid email field
  console.log("\nTest 3: Finding an email conversation in MongoDB to test reply sending...");
  const conv = await ConversationModel.findOne({
    $or: [{ channel: "Email" }, { platform: "gmail" }],
    email: { $exists: true, $regex: /@/ },
  }).lean();

  if (!conv) {
    throw new Error("No email conversation found with valid email in DB!");
  }
  console.log(`  ✓ Found Conversation: id=${conv.id}, customerName=${conv.customerName}, email=${conv.email}`);

  // Test 4: Post reply via POST http://localhost:5000/api/conversations/:convId/messages
  console.log(`\nTest 4: Sending outbound reply to conversation ${conv.id} via API...`);
  const replyText = `Test reply from BUZZZ automated test suite (${new Date().toLocaleTimeString()})`;
  const replyRes = await fetch(`http://localhost:5000/api/conversations/${encodeURIComponent(conv.id)}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-workspace-id": "ws_default",
    },
    body: JSON.stringify({
      text: replyText,
      sender: "agent",
    }),
  });

  const replyData = await replyRes.json();
  console.log("  Reply Response:", replyData);

  if (!replyRes.ok || replyData.status !== "sent") {
    throw new Error(`Reply endpoint failed or status not 'sent': HTTP ${replyRes.status} ${JSON.stringify(replyData)}`);
  }
  console.log(`  ✓ Reply successfully sent and recorded as status: ${replyData.status}`);

  // Test 5: Verify saved in UnifiedMessageModel
  const uMsg = await UnifiedMessageModel.findOne({
    conversationId: conv.id,
    text: replyText,
    direction: "outbound",
  }).lean();

  if (!uMsg) {
    throw new Error("Outbound message not found in UnifiedMessageModel!");
  }
  console.log(`  ✓ Outbound message confirmed in UnifiedMessageModel (id: ${uMsg.id}, status: ${uMsg.status})`);

  console.log("\n✅ ALL EMAIL FETCH & REPLY TESTS PASSED PERFECTLY!\n");
  await (await import("mongoose")).default.disconnect();
  process.exit(0);
}

runTest().catch(async (err) => {
  console.error("❌ Test Failed:", err);
  try { await (await import("mongoose")).default.disconnect(); } catch (_) {}
  process.exit(1);
});
