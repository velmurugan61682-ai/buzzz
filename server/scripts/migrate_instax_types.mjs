/**
 * Migration: Set root-level `type` field on existing InstaxBot conversations
 * that only have it in metadata.lastMessageType or metadata.messageType
 * Also fixes emoji corrupted order text (??? → 🛍️)
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) { console.error("No MONGO_URI"); process.exit(1); }

await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
console.log("✅ Connected to MongoDB");

const ConvCol = mongoose.connection.collection("conversations");
const MsgCol  = mongoose.connection.collection("unifiedmessages");

// 1. Fix conversations that have metadata.lastMessageType but no root-level type
const convs = await ConvCol.find({
  $or: [
    { platform: "instaxbot" },
    { channel: "Instagram" },
    { channel: "InstaxBot" }
  ]
}).toArray();

let updatedConvs = 0;
for (const c of convs) {
  const mType = c.metadata?.lastMessageType || c.metadata?.messageType || null;
  const needsType = !c.type && mType;
  const needsEmojifix = c.lastMessage && c.lastMessage.startsWith("???");
  
  if (needsType || needsEmojifix) {
    const upd = {};
    if (needsType) upd.type = mType;
    if (needsEmojifix) upd.lastMessage = c.lastMessage.replace(/^\?\?\?/, "🛍️");
    
    await ConvCol.updateOne({ _id: c._id }, { $set: upd });
    updatedConvs++;
    console.log(`  ✅ Conv [${c.id}]: set type="${upd.type || c.type}", fixed emoji=${needsEmojifix}`);
  }
}

// 2. Fix unified messages with corrupted emoji (??? → 🛍️)
const badMsgs = await MsgCol.find({
  text: { $regex: /^\?\?\?/ }
}).toArray();

let updatedMsgs = 0;
for (const m of badMsgs) {
  const fixedText = m.text.replace(/^\?\?\?/, "🛍️");
  await MsgCol.updateOne({ _id: m._id }, { $set: { text: fixedText } });
  updatedMsgs++;
}

console.log(`\n✅ Migration complete:`);
console.log(`  - ${updatedConvs} conversations updated (type set / emoji fixed)`);
console.log(`  - ${updatedMsgs} unified messages emoji fixed`);

await mongoose.disconnect();
process.exit(0);
