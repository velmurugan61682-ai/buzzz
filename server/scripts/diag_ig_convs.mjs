/**
 * Diagnostic: Print all Instagram conversations and their type/platform/channel fields
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });

const col = mongoose.connection.collection("conversations");
const all = await col.find({}).toArray();
const ig  = all.filter(c =>
  c.platform === "instaxbot" || c.channel === "Instagram" ||
  c.channel === "instaxbot"  || (c.id && c.id.startsWith("conv_ig_"))
);
console.log("Total IG convs:", ig.length);
ig.forEach(c => console.log(JSON.stringify({
  id:        c.id,
  type:      c.type,
  platform:  c.platform,
  channel:   c.channel,
  meta_type: c.metadata?.lastMessageType || c.metadata?.messageType || null
})));

await mongoose.disconnect();
process.exit(0);
