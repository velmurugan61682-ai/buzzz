import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { connectDB, UnifiedMessageModel, ConversationModel } from "../data/db.js";

async function auditMongo() {
  await connectDB();
  console.log("=== MONGODB DATA AUDIT ===");

  const messages = await UnifiedMessageModel.find({}).sort({ receivedAt: -1 }).lean();
  console.log(`Total messages in UnifiedMessageModel: ${messages.length}\n`);

  console.log("--- MESSAGES BY PLATFORM ---");
  const platformCounts = {};
  messages.forEach((m) => {
    platformCounts[m.platform] = (platformCounts[m.platform] || 0) + 1;
  });
  console.log("Counts per platform:", JSON.stringify(platformCounts));
  const targetPlatforms = ["whatsapp", "instagram", "youtube", "gowhats", "instaxbot", "channelbot"];
  const targetMessages = messages.filter((m) => targetPlatforms.includes(m.platform) || targetPlatforms.includes(m.integrationId));

  console.log(`\n=======================================================`);
  console.log(`TARGET MESSAGES IN MONGO (${targetMessages.length} total):`);
  console.log(`=======================================================`);
  targetMessages.forEach((m, idx) => {
    console.log(`[${idx + 1}] ID: ${m.id || m._id} | Platform: ${m.platform} | Integration: ${m.integrationId}`);
    console.log(`    Sender: ${m.sender?.name} (${m.sender?.handle || m.sender?.email || m.sender?.phone || "N/A"})`);
    console.log(`    Direction: ${m.direction} | ExternalID: ${m.externalMessageId || "N/A"}`);
    console.log(`    Text: "${m.text}"`);
    console.log(`    ReceivedAt: ${m.receivedAt}`);
    console.log("--------------------------------------------------------------------------------");
  });

  const conversations = await ConversationModel.find({}).sort({ updatedAt: -1 }).lean();
  const targetConvs = conversations.filter((c) => ["WhatsApp", "Instagram", "YouTube", "whatsapp", "instagram", "youtube", "InstaxBot", "gowhats", "instaxbot"].includes(c.channel) || ["instaxbot", "gowhats", "channelbot"].includes(c.platform));
  console.log(`\n=======================================================`);
  console.log(`TARGET CONVERSATIONS IN MONGO (${targetConvs.length} total):`);
  console.log(`=======================================================`);
  targetConvs.slice(0, 30).forEach((c, idx) => {
    console.log(`[${idx + 1}] ID: ${c.id} | Channel: ${c.channel} | Platform: ${c.platform} | Customer: ${c.customerName} | Phone/Email: ${c.phone || c.email || "N/A"}`);
    console.log(`    LastMsg: "${c.lastMessage}" | UpdatedAt: ${c.updatedAt}`);
  });

  const { OrderModel } = await import("../data/db.js");
  const orders = await OrderModel.find({}).sort({ createdAt: -1 }).lean();
  console.log(`\n=======================================================`);
  console.log(`TOTAL ORDERS IN MONGO (${orders.length} total):`);
  console.log(`=======================================================`);
  orders.slice(0, 10).forEach((o, idx) => {
    console.log(`[${idx + 1}] ID: ${o.id || o.orderId} | Platform: ${o.platform} | Customer: ${o.customerName} (${o.customerPhone}) | Amount: ${o.totalAmount} ${o.currency}`);
  });

  process.exit(0);
}

auditMongo().catch((err) => {
  console.error("Audit error:", err);
  process.exit(1);
});
