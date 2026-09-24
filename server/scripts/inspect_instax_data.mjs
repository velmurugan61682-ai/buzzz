import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { connectDB, ConversationModel, UnifiedMessageModel, OrderModel } from "../src/data/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

await connectDB();

const igConvs = await ConversationModel.find({
  $or: [
    { channel: { $regex: /instagram/i } },
    { platform: { $regex: /instax|instagram/i } },
    { "metadata.account": "@techvaseegrah" }
  ]
}).lean();

console.log(`\nFound ${igConvs.length} Instagram / InstaxBot conversations:`);
igConvs.forEach((c) => {
  console.log(`- [${c.id}] customerName="${c.customerName}" channel="${c.channel}" platform="${c.platform}" lastMsg="${c.lastMessage?.slice(0, 60)}" type="${c.metadata?.lastMessageType || c.metadata?.type || 'N/A'}"`);
});

const igMessages = await UnifiedMessageModel.find({
  $or: [
    { platform: { $regex: /instax|instagram/i } },
    { integrationId: "instaxbot" }
  ]
}).lean();

console.log(`\nFound ${igMessages.length} Instagram / InstaxBot UnifiedMessages:`);
igMessages.slice(0, 15).forEach((m) => {
  console.log(`- [${m.id}] convId="${m.conversationId}" sender="${m.sender?.handle || m.sender?.name}" text="${m.text?.slice(0, 60)}" type="${m.metadata?.messageType}" extId="${m.externalMessageId}"`);
});

process.exit(0);
