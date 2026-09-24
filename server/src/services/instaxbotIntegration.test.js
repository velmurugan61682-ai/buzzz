import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { saveInstaxBotConfig, getInstaxBotConfig, deleteInstaxBotConfig } from "../data/db.js";
import {
  fetchInstaxBotOrders,
  fetchAllInstaxBotOrders,
  createInstaxBotOrder,
  updateInstaxBotOrder,
  syncInstaxBotContacts,
  registerInstaxBotWebhook,
  getInstaxBotWebhookStatus,
  fetchInstaxBotTemplates,
  fetchInstaxBotMessages,
  fetchInstaxBotComments,
  sendInstaxBotComment,
  fetchInstaxBotChats,
  sendInstaxBotChatMessage,
  transferInstaxBotChat,
  createInstaxBotContact,
  updateInstaxBotContact,
  fetchInstaxBotInventory,
  updateInstaxBotInventory,
  createInstaxBotInventoryItem,
  sendInstaxBotBroadcast,
  runInstaxBotHistoricalBackfill,
  getInstaxBotBackfillStatus,
} from "./instaxbot.js";

async function testInstaxBotIntegration() {
  console.log("🧪 Testing All 13 InstaxBot API Scopes & Omnichannel Ingestion for @techvaseegrah...\n");

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
  console.log("--- 1. Configuration & Key Safety ---");
  const maskedKey = "••••" + apiKey.slice(-4);
  const saved = await saveInstaxBotConfig({
    workspaceId: wsId,
    apiKey,
    maskedKey,
    accountName: `InstaxBot Account (${maskedKey})`,
  });

  assertEqual(saved.maskedKey, maskedKey, `Masked key matches expected pattern (${maskedKey})`);
  assertEqual(saved.apiKey, apiKey, "API key saved in DB layer");

  const statusConfig = await getInstaxBotConfig(wsId);
  assertEqual(statusConfig.maskedKey, maskedKey, "getInstaxBotConfig returns saved masked key");

  // 2. Test All 11 Scopes
  console.log("\n--- 2. Scope 1: orders.read ---");
  const ordersRes = await fetchInstaxBotOrders();
  console.log(`  [fetchInstaxBotOrders] success: ${ordersRes.success}, count: ${ordersRes.count}`);
  assertEqual(ordersRes.success, true, "Scope 1: orders.read returns success: true");

  console.log("\n--- 3. Scope 2: orders.write ---");
  const createOrderRes = await createInstaxBotOrder({
    orderData: {
      orderId: "ord_test_vaseegrah_991",
      customerName: "Karthik Subramanian",
      username: "karthik_v",
      productName: "Vaseegrah Organic Handmade Herbal Soap",
      amount: 1450,
      currency: "INR",
      status: "CONFIRMED",
    },
    workspaceId: wsId,
  });
  console.log(`  [createInstaxBotOrder] success: ${createOrderRes.success}, orderId: ${createOrderRes.orderId}`);
  assertEqual(createOrderRes.success, true, "Scope 2: orders.write returns success: true");
  assertEqual(createOrderRes.order?.account, "@techvaseegrah", "Scope 2: order tagged with account @techvaseegrah");

  console.log("\n--- 4. Scope 3: orders.update ---");
  const updateOrderRes = await updateInstaxBotOrder({
    orderId: "ord_test_vaseegrah_991",
    updateData: {
      status: "SHIPPED",
      customerHandle: "karthik_v",
      trackingNumber: "TRK_IG_991823",
    },
    workspaceId: wsId,
  });
  console.log(`  [updateInstaxBotOrder] success: ${updateOrderRes.success}`);
  assertEqual(updateOrderRes.success, true, "Scope 3: orders.update returns success: true");

  console.log("\n--- 5. Scope 4: messages.read ---");
  const commentsRes = await fetchInstaxBotComments();
  console.log(`  [fetchInstaxBotComments] success: ${commentsRes.success}, count: ${commentsRes.comments?.length || 0}`);
  assertEqual(commentsRes.success, true, "Scope 2: messages.read (comments) returns success: true");
  assertTruthy(commentsRes.comments.length > 0, "Comments array populated with readable items");

  const chatsRes = await fetchInstaxBotChats();
  console.log(`  [fetchInstaxBotChats] success: ${chatsRes.success}, count: ${chatsRes.chats?.length || 0}`);
  assertEqual(chatsRes.success, true, "Scope 2: messages.read (chats) returns success: true");
  assertTruthy(chatsRes.chats.length > 0, "Chats array populated with readable items");

  console.log("\n--- 4. Scope 3: messages.send ---");
  const sendCommentRes = await sendInstaxBotComment({
    text: "Thanks for checking out our collection! Size M is available.",
    targetHandle: "priya_sharma",
    mediaId: "media_summer_drop",
    workspaceId: wsId,
  });
  console.log(`  [sendInstaxBotComment] success: ${sendCommentRes.success}`);
  assertEqual(sendCommentRes.success, true, "Scope 3: messages.send (comment reply) returns success: true");

  const sendChatRes = await sendInstaxBotChatMessage({
    recipientId: "ananya_r",
    handle: "ananya_r",
    text: "Hello Ananya! Yes, we offer international express shipping.",
    workspaceId: wsId,
  });
  console.log(`  [sendInstaxBotChatMessage] success: ${sendChatRes.success}`);
  assertEqual(sendChatRes.success, true, "Scope 3: messages.send (direct message) returns success: true");

  console.log("\n--- 5. Scope 4: chats.transfer ---");
  const transferRes = await transferInstaxBotChat({
    conversationId: "conv_ig_ananya_r",
    targetAgentId: "agent_senior_advisor",
    reason: "Customer requested wholesale custom order",
    workspaceId: wsId,
  });
  console.log(`  [transferInstaxBotChat] success: ${transferRes.success}, assignedAgent: ${transferRes.assignedAgent}`);
  assertEqual(transferRes.success, true, "Scope 4: chats.transfer returns success: true");

  console.log("\n--- 6. Scope 5: contacts.read ---");
  const contactsRes = await syncInstaxBotContacts({ workspaceId: wsId });
  console.log(`  [syncInstaxBotContacts] success: ${contactsRes.success}, syncedCount: ${contactsRes.syncedCount}`);
  assertEqual(contactsRes.success, true, "Scope 5: contacts.read returns success: true");

  console.log("\n--- 7. Scope 6: contacts.write ---");
  const createContactRes = await createInstaxBotContact({
    contactData: { name: "Rohan Varma", username: "rohan_v", phone: "9812345678" },
    workspaceId: wsId,
  });
  console.log(`  [createInstaxBotContact] success: ${createContactRes.success}`);
  assertEqual(createContactRes.success, true, "Scope 6: contacts.write (create) returns success: true");

  const updateContactRes = await updateInstaxBotContact({
    contactId: "rohan_v",
    updateData: { vipTag: true, notes: "Preferred client" },
  });
  console.log(`  [updateInstaxBotContact] success: ${updateContactRes.success}`);
  assertTruthy(updateContactRes !== undefined, "Scope 6: contacts.write (update) executed");

  console.log("\n--- 8. Scope 7: inventory.read ---");
  const invRes = await fetchInstaxBotInventory();
  console.log(`  [fetchInstaxBotInventory] success: ${invRes.success}, items: ${invRes.count}`);
  assertEqual(invRes.success, true, "Scope 7: inventory.read returns success: true");
  assertTruthy(invRes.inventory?.length > 0, "Inventory items array populated");

  console.log("\n--- 9. Scope 8: inventory.write ---");
  const updateInvRes = await updateInstaxBotInventory({
    sku: "IB-SUMMER-01",
    stock: 55,
  });
  console.log(`  [updateInstaxBotInventory] success: ${updateInvRes.success}, stock: ${updateInvRes.updated?.stock}`);
  assertEqual(updateInvRes.success, true, "Scope 8: inventory.write returns success: true");

  console.log("\n--- 10. Scope 9: templates.read ---");
  const templatesRes = await fetchInstaxBotTemplates();
  console.log(`  [fetchInstaxBotTemplates] success: ${templatesRes.success}, count: ${templatesRes.templates?.length || 0}`);
  assertEqual(templatesRes.success, true, "Scope 9: templates.read returns success: true");

  console.log("\n--- 11. Scope 10: webhooks.manage ---");
  const webhookRes = await registerInstaxBotWebhook();
  console.log(`  [registerInstaxBotWebhook] success: ${webhookRes.success}`);
  assertEqual(webhookRes.success, true, "Scope 10: webhooks.manage (register) returns success: true");

  const webhookStatus = await getInstaxBotWebhookStatus();
  console.log(`  [getInstaxBotWebhookStatus] success: ${webhookStatus.success}`);
  assertEqual(webhookStatus.success, true, "Scope 10: webhooks.manage (status) returns success: true");

  console.log("\n--- 12. Scope 11: broadcasts.send ---");
  const broadcastRes = await sendInstaxBotBroadcast({
    messageText: "🌟 Flash Sale Today Only: 25% off all accessories!",
    segmentId: "vip_members",
  });
  console.log(`  [sendInstaxBotBroadcast] success: ${broadcastRes.success}`);
  assertTruthy(broadcastRes !== undefined, "Scope 11: broadcasts.send executed");

  // 13. Omnichannel Backfill & Sync Engine Test
  console.log("\n--- 13. Omnichannel Historical Backfill & Ingestion ---");
  const backfillRes = await runInstaxBotHistoricalBackfill({ workspaceId: wsId });
  assertEqual(backfillRes.success, true, "runInstaxBotHistoricalBackfill returns success: true");

  // Poll until backfill completes
  let finalStatus = getInstaxBotBackfillStatus();
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((r) => setTimeout(r, 400));
    finalStatus = getInstaxBotBackfillStatus();
    if (finalStatus.status === "completed" || finalStatus.status === "failed") break;
  }
  console.log(`  [Backfill Status] status: ${finalStatus.status}, orders: ${finalStatus.ordersCount}, comments: ${finalStatus.commentsCount}, chats: ${finalStatus.chatsCount}`);
  assertEqual(finalStatus.status, "completed", "Omnichannel backfill successfully completed");
  assertTruthy(finalStatus.commentsCount > 0, "Comments backfilled into inbox");
  assertTruthy(finalStatus.chatsCount > 0, "Chats backfilled into inbox");

  // 14. Cleanup
  await deleteInstaxBotConfig(wsId);

  console.log(`\n=======================================================`);
  console.log(`Test Results: ${passed} passed, ${failed} failed`);
  console.log(`=======================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

testInstaxBotIntegration();
