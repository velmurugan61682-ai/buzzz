import mongoose from "mongoose";

const contactSchema = new mongoose.Schema({
  workspaceId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  phoneNorm: { type: String, trim: true, index: true },
  title: { type: String },
  company: { type: String },
  status: { type: String, default: "New" },
  source: { type: String, default: "manual" },
  archived: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

contactSchema.index({ workspaceId: 1, email: 1 });
contactSchema.index({ workspaceId: 1, phoneNorm: 1 });

export const ContactModel = mongoose.models.Contact || mongoose.model("Contact", contactSchema);
