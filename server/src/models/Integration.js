import mongoose from "mongoose";

const integrationSchema = new mongoose.Schema({
  workspaceId: { type: String, required: true, index: true },
  provider: { type: String, required: true },
  state: { type: String, default: "connected" },
  credentialRef: { type: String },
  config: { type: mongoose.Schema.Types.Mixed, default: {} },
  lastCheckAt: { type: Date, default: Date.now },
  errorCount: { type: Number, default: 0 }
});

integrationSchema.index({ workspaceId: 1, provider: 1 }, { unique: true });

export const IntegrationModel = mongoose.models.Integration || mongoose.model("Integration", integrationSchema);
