import mongoose from "mongoose";

// ==============================================================================
// 1. IN-MEMORY FALLBACK DATASET
// ==============================================================================
export const db = {
  conversations: [
    {
      id: "conv_1",
      workspaceId: "ws_default",
      customerName: "Alex Rivera",
      channel: "WhatsApp",
      phone: "919047484484",
      unreadCount: 0,
      lastMessage: "Looking forward to our demo tomorrow!",
      updatedAt: new Date().toISOString(),
    },
  ],
  messages: {
    conv_1: [
      {
        id: "msg_101",
        conversationId: "conv_1",
        sender: "customer",
        text: "Hi there! I'm interested in BUZZZ Platform enterprise features.",
        timestamp: new Date(Date.now() - 3600000 * 24).toISOString(),
        whatsappMessageId: "wamid.HBgLOTE5MDQ3NDg0NDg0FQIAERgSRTc1RjM1MzE0RTE1NkQyNzAwAA==",
        status: "received",
      },
    ],
  },
  contacts: [],
  companies: [],
  deals: [],
  tasks: [],
  appointments: [],
  agents: [],
  workflows: [],
  linkedinAccounts: [],
  googleAccounts: [],
};

// ==============================================================================
// 2. MONGOOSE SCHEMAS & MODELS
// ==============================================================================
const ConversationSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, default: "ws_default" },
    customerName: { type: String, required: true },
    channel: { type: String, default: "WhatsApp" },
    phone: { type: String, index: true },
    unreadCount: { type: Number, default: 0 },
    lastMessage: { type: String, default: "" },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const MessageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    conversationId: { type: String, required: true, index: true },
    sender: { type: String, enum: ["customer", "agent", "system"], default: "customer" },
    text: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    gowhatsMessageId: { type: String, index: true },
    whatsappMessageId: { type: String, index: true },
    status: { type: String, enum: ["received", "sent", "delivered", "read", "failed"], default: "received" },
  },
  { timestamps: true }
);

const LinkedInAccountSchema = new mongoose.Schema(
  {
    workspaceId: { type: String, default: "ws_default", index: true },
    linkedinId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    email: { type: String },
    picture: { type: String },
    accessToken: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

const GoogleAccountSchema = new mongoose.Schema(
  {
    workspaceId: { type: String, default: "ws_default", index: true },
    googleId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    email: { type: String, required: true, index: true },
    picture: { type: String },
    accessToken: { type: String, required: true },
    refreshToken: { type: String },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

export const ConversationModel = mongoose.models.Conversation || mongoose.model("Conversation", ConversationSchema);
export const MessageModel = mongoose.models.Message || mongoose.model("Message", MessageSchema);
export const LinkedInAccountModel = mongoose.models.LinkedInAccount || mongoose.model("LinkedInAccount", LinkedInAccountSchema);
export const GoogleAccountModel = mongoose.models.GoogleAccount || mongoose.model("GoogleAccount", GoogleAccountSchema);

// ==============================================================================
// 3. MONGODB CONNECTION SETUP & SEEDING
// ==============================================================================
let isDbConnected = false;

export const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("⚠️ MONGODB_URI is not defined in environment. Using in-memory dataset.");
    return false;
  }

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    isDbConnected = true;
    console.log(`✅ MongoDB connected successfully to host: ${mongoose.connection.host}`);

    // Seed initial conversations if database is empty
    const count = await ConversationModel.countDocuments();
    if (count === 0) {
      console.log("🌱 Seeding initial conversations into MongoDB...");
      for (const conv of db.conversations) {
        await ConversationModel.create(conv);
        const msgs = db.messages[conv.id] || [];
        for (const msg of msgs) {
          await MessageModel.create(msg);
        }
      }
    }

    return true;
  } catch (err) {
    console.error(`❌ MongoDB connection failed: ${err.message}`);
    console.warn("⚠️ Falling back to in-memory dataset.");
    isDbConnected = false;
    return false;
  }
};

export const getDbStatus = () => ({
  connected: isDbConnected && mongoose.connection.readyState === 1,
  host: mongoose.connection.host || null,
  name: mongoose.connection.name || null,
});

// ==============================================================================
// 4. DATA ACCESS FUNCTIONS (MONGO DB WITH IN-MEMORY FALLBACK)
// ==============================================================================
export const fetchConversations = async (workspaceId = "ws_default") => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    const filter = workspaceId ? { $or: [{ workspaceId }, { workspaceId: "ws_default" }] } : {};
    return await ConversationModel.find(filter).sort({ updatedAt: -1 }).lean();
  }
  return db.conversations.filter((c) => !c.workspaceId || c.workspaceId === workspaceId || workspaceId === "ws_default");
};

export const fetchConversationById = async (id) => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    return await ConversationModel.findOne({ id }).lean();
  }
  return db.conversations.find((c) => c.id === id) || null;
};

export const findConversationByPhone = async (phone, channel = "WhatsApp") => {
  const cleanPhone = String(phone).replace(/\D/g, "");
  if (isDbConnected && mongoose.connection.readyState === 1) {
    return await ConversationModel.findOne({ phone: cleanPhone, channel }).lean();
  }
  return db.conversations.find((c) => c.phone && c.phone.replace(/\D/g, "") === cleanPhone && c.channel === channel) || null;
};

export const upsertConversation = async (data) => {
  const cleanPhone = data.phone ? String(data.phone).replace(/\D/g, "") : "";
  const payload = {
    ...data,
    phone: cleanPhone || data.phone,
    updatedAt: data.updatedAt ? new Date(data.updatedAt) : new Date(),
  };

  if (isDbConnected && mongoose.connection.readyState === 1) {
    const doc = await ConversationModel.findOneAndUpdate(
      { id: payload.id },
      { $set: payload },
      { upsert: true, new: true }
    ).lean();
    return doc;
  }

  const idx = db.conversations.findIndex((c) => c.id === payload.id);
  if (idx !== -1) {
    db.conversations[idx] = { ...db.conversations[idx], ...payload };
    return db.conversations[idx];
  } else {
    db.conversations.unshift(payload);
    return payload;
  }
};

export const fetchMessagesByConversationId = async (conversationId) => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    return await MessageModel.find({ conversationId }).sort({ createdAt: 1 }).lean();
  }
  return db.messages[conversationId] || [];
};

export const saveMessage = async (msgData) => {
  const payload = {
    ...msgData,
    timestamp: msgData.timestamp ? new Date(msgData.timestamp) : new Date(),
  };

  if (isDbConnected && mongoose.connection.readyState === 1) {
    const doc = await MessageModel.create(payload);
    return doc.toObject();
  }

  if (!db.messages[payload.conversationId]) {
    db.messages[payload.conversationId] = [];
  }
  db.messages[payload.conversationId].push(payload);
  return payload;
};

export const updateMessageStatus = async (whatsappMessageId, status) => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    return await MessageModel.findOneAndUpdate(
      { whatsappMessageId },
      { $set: { status } },
      { new: true }
    ).lean();
  }

  for (const convId of Object.keys(db.messages)) {
    const msg = db.messages[convId].find((m) => m.whatsappMessageId === whatsappMessageId);
    if (msg) {
      msg.status = status;
      return msg;
    }
  }
  return null;
};

export const saveLinkedInAccount = async (data) => {
  const payload = {
    ...data,
    workspaceId: data.workspaceId || "ws_default",
    expiresAt: data.expiresAt ? new Date(data.expiresAt) : new Date(Date.now() + 5184000000),
  };

  if (isDbConnected && mongoose.connection.readyState === 1) {
    const doc = await LinkedInAccountModel.findOneAndUpdate(
      { workspaceId: payload.workspaceId, linkedinId: payload.linkedinId },
      { $set: payload },
      { upsert: true, new: true }
    ).lean();
    return doc;
  }

  const idx = db.linkedinAccounts.findIndex(
    (a) => a.workspaceId === payload.workspaceId && a.linkedinId === payload.linkedinId
  );
  if (idx !== -1) {
    db.linkedinAccounts[idx] = { ...db.linkedinAccounts[idx], ...payload };
    return db.linkedinAccounts[idx];
  } else {
    db.linkedinAccounts.unshift(payload);
    return payload;
  }
};

export const getLinkedInAccount = async (workspaceId = "ws_default") => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    return await LinkedInAccountModel.findOne({ workspaceId }).sort({ updatedAt: -1 }).lean();
  }
  return db.linkedinAccounts.find((a) => a.workspaceId === workspaceId || !a.workspaceId) || null;
};

export const saveGoogleAccount = async (data) => {
  const payload = {
    ...data,
    workspaceId: data.workspaceId || "ws_default",
    expiresAt: data.expiresAt ? new Date(data.expiresAt) : new Date(Date.now() + 3600000),
  };

  if (isDbConnected && mongoose.connection.readyState === 1) {
    const doc = await GoogleAccountModel.findOneAndUpdate(
      { workspaceId: payload.workspaceId, email: payload.email },
      { $set: payload },
      { upsert: true, new: true }
    ).lean();
    return doc;
  }

  const idx = db.googleAccounts.findIndex(
    (a) => a.workspaceId === payload.workspaceId && a.email === payload.email
  );
  if (idx !== -1) {
    db.googleAccounts[idx] = { ...db.googleAccounts[idx], ...payload };
    return db.googleAccounts[idx];
  } else {
    db.googleAccounts.unshift(payload);
    return payload;
  }
};

export const getGoogleAccount = async (workspaceId = "ws_default") => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    return await GoogleAccountModel.findOne({ workspaceId }).sort({ updatedAt: -1 }).lean();
  }
  return db.googleAccounts.find((a) => a.workspaceId === workspaceId || !a.workspaceId) || null;
};
