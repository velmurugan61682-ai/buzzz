import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema({
  workspaceId: { type: String, required: true, index: true },
  contactId: { type: String, index: true },
  channel: { type: String, enum: ["whatsapp", "email", "instagram", "voice", "telegram", "youtube"], required: true },
  accountExternalId: { type: String },
  state: { type: String, enum: ["open", "pending", "resolved"], default: "open" },
  assigneeId: { type: String },
  agentId: { type: String },
  aiEnabled: { type: Boolean, default: true },
  lastCustomerMessageAt: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

conversationSchema.index({ workspaceId: 1, contactId: 1, channel: 1 });

export const ConversationModel = mongoose.models.Conversation || mongoose.model("Conversation", conversationSchema);
