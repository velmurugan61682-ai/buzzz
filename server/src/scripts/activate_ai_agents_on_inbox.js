import dotenv from "dotenv";
dotenv.config();

import { connectDB, ConversationModel, upsertConversation } from "../data/db.js";
import { determineAgentForConv } from "../routes/api.js";

async function runMigration() {
  console.log("Connecting to database...");
  await connectDB();

  const convs = await ConversationModel.find({}).lean();
  console.log(`Found ${convs.length} total conversations in MongoDB.`);

  const distribution = {
    Sarah: 0,
    Kai: 0,
    Ana: 0,
    Voz: 0,
    Mira: 0,
    Sky: 0,
  };

  let updatedCount = 0;

  for (const c of convs) {
    const agent = determineAgentForConv(c);
    distribution[agent.name] = (distribution[agent.name] || 0) + 1;

    const payload = {
      ...c,
      ai: true,
      agent: `${agent.name} — ${agent.title}`,
      agentId: agent.id,
      assigned: `${agent.name} (AI)`,
      intent:
        agent.type === "sales"
          ? "sales"
          : agent.type === "support"
          ? "support"
          : agent.type === "appointment"
          ? "booking"
          : agent.type === "social"
          ? "social"
          : "general",
      state: c.state || "Open",
      updatedAt: c.updatedAt || new Date().toISOString(),
    };

    await upsertConversation(payload);
    updatedCount++;
  }

  console.log(`✅ Successfully activated AI Agents on ${updatedCount} conversations!`);
  console.log("📊 Agent Distribution:", distribution);
  process.exit(0);
}

runMigration().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
