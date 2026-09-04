import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
  workspaceId: { type: String, required: true, index: true },
  conversationId: { type: String, required: true, index: true },
  direction: { type: String, enum: ["inbound", "outbound"], required: true },
  author: { type: String, required: true },
  body: { type: String, required: true },
  media: { type: mongoose.Schema.Types.Mixed },
  providerMessageId: { type: String, index: true },
  deliveryStatus: { type: String, default: "sent" },
  createdAt: { type: Date, default: Date.now }
});

messageSchema.index({ workspaceId: 1, providerMessageId: 1 });

export const MessageModel = mongoose.models.Message || mongoose.model("Message", messageSchema);
