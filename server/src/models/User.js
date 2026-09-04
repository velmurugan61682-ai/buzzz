import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, trim: true },
  passwordHash: { type: String, required: true },
  emailVerified: { type: Boolean, default: true },
  status: { type: String, enum: ["active", "suspended"], default: "active" },
  createdAt: { type: Date, default: Date.now }
});

export const UserModel = mongoose.models.User || mongoose.model("User", userSchema);
