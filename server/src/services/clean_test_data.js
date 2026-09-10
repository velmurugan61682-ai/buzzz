import { connectDB, UnifiedMessageModel, ConversationModel } from "../data/db.js";

async function cleanTestData() {
  await connectDB();
  console.log("🧹 Starting MongoDB Test Data Cleanup...\n");

  const testMessageFilter = {
    $or: [
      { text: { $regex: /live test message|live proof|meta instagram graph api|flat simulation|vanakkam! channelbot|custom workspace live test|awesome video on ai agents/i } },
      { externalMessageId: { $regex: /mid_test_|mid_live_proof_|sim_flat_|custom_ws_msg_|yt_comm_/i } },
      { id: { $regex: /msg_mid_test_|msg_mid_live_proof_|msg_sim_flat_|msg_custom_ws_|msg_yt_comm_/i } },
    ],
  };

  const testMessages = await UnifiedMessageModel.find(testMessageFilter).lean();
  console.log(`Found ${testMessages.length} test messages matching test patterns:`);
  testMessages.forEach((m) => console.log(`  - [${m.id}] (${m.platform}): "${m.text?.substring(0, 80)}"`));

  const deleteMsgResult = await UnifiedMessageModel.deleteMany(testMessageFilter);
  console.log(`\n✅ Deleted ${deleteMsgResult.deletedCount} test messages from UnifiedMessageModel.`);

  const testConvFilter = {
    $or: [
      { id: { $in: ["conv_ig_custom_user_1", "conv_ig_test_user_1", "conv_ig_live_proof_user", "conv_ig_meta_user_99", "conv_ig_flat_sim_handle", "conv_ig_1788850293428", "conv_ig_1788850292900", "conv_ig_1788756144709", "conv_1788519310914_353", "conv_yt_@TechEnthusiast99"] } },
      { id: undefined },
      { channel: undefined },
      { customerName: "undefined" },
      { lastMessage: { $regex: /live test message|live proof|meta instagram graph api|flat simulation|vanakkam! channelbot|custom workspace live test/i } },
    ],
  };

  const testConvs = await ConversationModel.find(testConvFilter).lean();
  console.log(`Found ${testConvs.length} test/undefined conversations matching test patterns:`);
  testConvs.forEach((c) => console.log(`  - [${c.id}] (${c.channel}): "${c.lastMessage?.substring(0, 80)}"`));

  const deleteConvResult = await ConversationModel.deleteMany(testConvFilter);
  console.log(`\n✅ Deleted ${deleteConvResult.deletedCount} test/undefined conversations from ConversationModel.`);

  console.log("\n🎉 MongoDB Cleanup Completed Cleanly!");
  process.exit(0);
}

cleanTestData().catch((err) => {
  console.error("Cleanup error:", err);
  process.exit(1);
});
