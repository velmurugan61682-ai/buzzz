import mongoose from "mongoose";

const workspaceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, lowercase: true, trim: true },
  ownerId: { type: String, required: true },
  members: [{
    userId: { type: String, required: true },
    role: { type: String, enum: ["owner", "admin", "agent"], default: "agent" }
  }],
  status: { type: String, enum: ["active", "suspended"], default: "active" },
  createdAt: { type: Date, default: Date.now }
});

export const WorkspaceModel = mongoose.models.Workspace || mongoose.model("Workspace", workspaceSchema);
