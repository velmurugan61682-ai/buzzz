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
  instaxbotAccounts: [],
  unifiedMessages: [],
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

// ==============================================================================
// UNIFIED MULTI-CHANNEL MESSAGE SCHEMA & DEDUPLICATION INDEX
// ==============================================================================
const UnifiedMessageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, default: "ws_default", index: true },
    conversationId: { type: String, required: true, index: true },
    integrationId: { type: String, default: "default" },
    platform: {
      type: String,
      required: true,
      enum: ["gmail", "instagram", "linkedin", "whatsapp", "telegram", "facebook", "custom_webhook"],
      index: true,
    },
    externalMessageId: { type: String, required: true, index: true },
    sender: {
      type: {
        name: { type: String, default: "Customer" },
        handle: { type: String, default: "" },
        email: { type: String, default: "" },
        avatar: { type: String, default: "" },
        kind: { type: String, enum: ["customer", "agent", "system"], default: "customer" },
      },
      default: {},
    },
    direction: { type: String, enum: ["inbound", "outbound"], default: "inbound" },
    text: { type: String, required: true },
    mediaUrl: { type: String, default: "" },
    status: { type: String, enum: ["received", "sent", "delivered", "read", "failed"], default: "received" },
    receivedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

// Compound Unique Index: Prevents duplicates even if the same webhook fires multiple times
UnifiedMessageSchema.index({ platform: 1, externalMessageId: 1 }, { unique: true });
UnifiedMessageSchema.index({ workspaceId: 1, conversationId: 1, receivedAt: -1 });

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

const InstaxBotAccountSchema = new mongoose.Schema(
  {
    workspaceId: { type: String, default: "ws_default", index: true },
    apiKey: { type: String, required: true },
    maskedKey: { type: String, required: true },
    accountName: { type: String, default: "InstaxBot Account" },
    connectedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const ContactSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, default: "ws_default", index: true },
    name: { type: String, required: true },
    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    company: { type: String, default: "—" },
    title: { type: String, default: "" },
    location: { type: String, default: "" },
    stage: { type: String, default: "New Lead" },
    status: { type: String, default: "New" },
    score: { type: Number, default: 50 },
    value: { type: String, default: "$0" },
    ltv: { type: String, default: "$0" },
    churn: { type: String, default: "Low" },
    sentiment: { type: String, default: "Neutral" },
    intent: { type: String, default: "Unknown" },
    channels: { type: [String], default: ["whatsapp"] },
    tags: { type: [String], default: [] },
    memory: { type: [String], default: [] },
    aiSummary: { type: String, default: "" },
    engagement: { type: Number, default: 50 },
    owner: { type: String, default: "Unassigned" },
    source: { type: String, default: "Manual entry" },
    archived: { type: Boolean, default: false },
    notes: { type: Array, default: [] },
    cf: { type: Object, default: {} },
    created: { type: String, default: () => new Date().toISOString().slice(0, 10) },
    lastContact: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const UserSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    picture: { type: String, default: "" },
    googleId: { type: String, index: true },
    role: { type: String, default: "owner" },
    workspaceId: { type: String, default: "ws_default" },
    emailVerified: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const ConversationModel = mongoose.models.Conversation || mongoose.model("Conversation", ConversationSchema);
export const MessageModel = mongoose.models.Message || mongoose.model("Message", MessageSchema);
export const UnifiedMessageModel = mongoose.models.UnifiedMessage || mongoose.model("UnifiedMessage", UnifiedMessageSchema);
export const LinkedInAccountModel = mongoose.models.LinkedInAccount || mongoose.model("LinkedInAccount", LinkedInAccountSchema);
export const GoogleAccountModel = mongoose.models.GoogleAccount || mongoose.model("GoogleAccount", GoogleAccountSchema);
export const InstaxBotAccountModel = mongoose.models.InstaxBotAccount || mongoose.model("InstaxBotAccount", InstaxBotAccountSchema);
export const ContactModel = mongoose.models.Contact || mongoose.model("Contact", ContactSchema);
export const UserModel = mongoose.models.User || mongoose.model("User", UserSchema);

export const findOrCreateGoogleUser = async ({ googleId, email, name, picture }) => {
  const cleanEmail = String(email).toLowerCase().trim();
  const payload = {
    id: `usr_g_${googleId || Date.now()}`,
    email: cleanEmail,
    name: name || cleanEmail.split("@")[0] || "User",
    picture: picture || "",
    googleId: googleId || "",
    role: "owner",
    workspaceId: "ws_default",
    emailVerified: true,
  };

  if (isDbConnected && mongoose.connection.readyState === 1) {
    const existing = await UserModel.findOne({ email: cleanEmail });
    if (existing) {
      existing.name = name || existing.name;
      existing.picture = picture || existing.picture;
      existing.googleId = googleId || existing.googleId;
      await existing.save();
      return existing.toObject();
    }
    const created = await UserModel.create(payload);
    return created.toObject();
  }

  if (!db.users) db.users = [];
  const existingIdx = db.users.findIndex((u) => u.email === cleanEmail);
  if (existingIdx !== -1) {
    db.users[existingIdx] = { ...db.users[existingIdx], name, picture, googleId };
    return db.users[existingIdx];
  } else {
    db.users.unshift(payload);
    return payload;
  }
};

// Initial seed contact record (c1) to keep existing CONVS references valid
export const seedContact = {
  id: "c1",
  workspaceId: "ws_default",
  name: "Arun Kumar",
  company: "Vertex Retail Group",
  title: "Head of Operations",
  location: "Chennai, IN",
  email: "arun.kumar@vertexretail.in",
  phone: "+91 98407 22110",
  stage: "Opportunity",
  status: "Qualified",
  score: 87,
  value: "$18,400",
  ltv: "$18,400",
  churn: "Low",
  sentiment: "Positive",
  intent: "Purchase",
  channels: ["whatsapp", "voice", "email"],
  tags: ["High Intent", "Enterprise", "Pricing"],
  memory: [
    "Prefers WhatsApp over email",
    "Asked about Enterprise annual pricing twice",
    "Company has around 120 employees across 14 stores",
    "Wants onboarding completed before Diwali season",
  ],
  aiSummary: "Contacted 3 times in the last 7 days about the Enterprise plan. High purchase intent. Asked about annual pricing and implementation timeline.",
  engagement: 92,
  owner: "Rina Sato",
  source: "Website",
  archived: false,
  notes: [],
  cf: {},
  created: "2026-07-10",
  lastContact: 2,
};

// Also put seed contact in in-memory fallback array db.contacts
db.contacts = [seedContact];

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

    // Seed initial demo contact (c1) into MongoDB if empty
    const contactCount = await ContactModel.countDocuments();
    if (contactCount === 0) {
      console.log("🌱 Seeding initial demo contact (c1) into MongoDB...");
      await ContactModel.create(seedContact);
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
    updatedAt: new Date(),
  };

  if (isDbConnected && mongoose.connection.readyState === 1) {
    const doc = await GoogleAccountModel.findOneAndUpdate(
      { workspaceId: payload.workspaceId },
      { $set: payload },
      { upsert: true, new: true }
    ).lean();
    return doc;
  }

  const idx = db.googleAccounts.findIndex(
    (a) => a.workspaceId === payload.workspaceId
  );
  if (idx !== -1) {
    db.googleAccounts[idx] = { ...db.googleAccounts[idx], ...payload };
    const [updated] = db.googleAccounts.splice(idx, 1);
    db.googleAccounts.unshift(updated);
    return updated;
  } else {
    db.googleAccounts.unshift(payload);
    return payload;
  }
};

export const getGoogleAccount = async (workspaceId = "ws_default") => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    return await GoogleAccountModel.findOne({ workspaceId }).sort({ updatedAt: -1 }).lean();
  }
  const accounts = db.googleAccounts.filter((a) => a.workspaceId === workspaceId || !a.workspaceId);
  if (!accounts.length) return null;
  accounts.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  return accounts[0];
};

export const saveInstaxBotConfig = async (data) => {
  const payload = {
    ...data,
    workspaceId: data.workspaceId || "ws_default",
    connectedAt: new Date(),
    updatedAt: new Date(),
  };

  if (isDbConnected && mongoose.connection.readyState === 1) {
    const doc = await InstaxBotAccountModel.findOneAndUpdate(
      { workspaceId: payload.workspaceId },
      { $set: payload },
      { upsert: true, new: true }
    ).lean();
    return doc;
  }

  const idx = db.instaxbotAccounts.findIndex((a) => a.workspaceId === payload.workspaceId);
  if (idx !== -1) {
    db.instaxbotAccounts[idx] = { ...db.instaxbotAccounts[idx], ...payload };
    return db.instaxbotAccounts[idx];
  } else {
    db.instaxbotAccounts.unshift(payload);
    return payload;
  }
};

export const getInstaxBotConfig = async (workspaceId = "ws_default") => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    const doc = await InstaxBotAccountModel.findOne({ workspaceId }).sort({ updatedAt: -1 }).lean();
    if (doc) return doc;
    if (workspaceId !== "ws_default") {
      const defaultDoc = await InstaxBotAccountModel.findOne({ workspaceId: "ws_default" }).sort({ updatedAt: -1 }).lean();
      if (defaultDoc) return defaultDoc;
    }
  }
  const mem = db.instaxbotAccounts.find((a) => a.workspaceId === workspaceId || !a.workspaceId);
  if (mem) return mem;

  const envKey = process.env.ISTRA_XBOT || process.env.INSTAXBOT_API_KEY;
  if (envKey) {
    return {
      workspaceId,
      apiKey: envKey,
      status: "connected",
      verifiedAt: new Date().toISOString(),
    };
  }
  return null;
};

export const deleteInstaxBotConfig = async (workspaceId = "ws_default") => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    return await InstaxBotAccountModel.deleteOne({ workspaceId });
  }
  db.instaxbotAccounts = db.instaxbotAccounts.filter((a) => a.workspaceId !== workspaceId);
  return { deletedCount: 1 };
};

// ==============================================================================
// CONTACTS DATA ACCESS FUNCTIONS (MONGO DB WITH IN-MEMORY FALLBACK)
// ==============================================================================
export const fetchContacts = async (workspaceId = "ws_default") => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    const filter = workspaceId ? { $or: [{ workspaceId }, { workspaceId: "ws_default" }] } : {};
    let contacts = await ContactModel.find(filter).sort({ createdAt: -1 }).lean();
    const hasSeed = contacts.some((c) => c.id === "c1");
    if (!hasSeed) {
      try {
        await ContactModel.findOneAndUpdate({ id: "c1" }, { $set: seedContact }, { upsert: true });
        contacts = await ContactModel.find(filter).sort({ createdAt: -1 }).lean();
      } catch (err) {
        console.warn("⚠️ Contact seed warning:", err.message);
      }
    }
    return contacts;
  }
  return db.contacts.filter((c) => !c.workspaceId || c.workspaceId === workspaceId || workspaceId === "ws_default");
};

export const fetchContactById = async (id) => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    return await ContactModel.findOne({ id }).lean();
  }
  return db.contacts.find((c) => c.id === id) || null;
};

export const upsertContact = async (data) => {
  const payload = {
    ...data,
    workspaceId: data.workspaceId || "ws_default",
  };

  if (isDbConnected && mongoose.connection.readyState === 1) {
    const doc = await ContactModel.findOneAndUpdate(
      { id: payload.id },
      { $set: payload },
      { upsert: true, new: true }
    ).lean();
    return doc;
  }

  const idx = db.contacts.findIndex((c) => c.id === payload.id);
  if (idx !== -1) {
    db.contacts[idx] = { ...db.contacts[idx], ...payload };
    return db.contacts[idx];
  } else {
    db.contacts.unshift(payload);
    return payload;
  }
};

export const deleteContactById = async (id) => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    return await ContactModel.deleteOne({ id });
  }
  db.contacts = db.contacts.filter((c) => c.id !== id);
  return { deletedCount: 1 };
};

// ==============================================================================
// UNIFIED INBOX & INTEGRATION CONNECTION GATE FUNCTIONS
// ==============================================================================

/**
 * Connection Verification Gate:
 * Verifies that the platform integration has status: 'connected' AND valid tokens/keys stored
 * BEFORE accepting/processing webhooks into the unified inbox.
 */
export const verifyIntegrationConnectionGate = async (workspaceId = "ws_default", platform) => {
  if (!platform) return { connected: false, reason: "Platform undefined" };

  const normPlatform = String(platform).toLowerCase();

  if (normPlatform === "instagram" || normPlatform === "instaxbot") {
    const config = await getInstaxBotConfig(workspaceId);
    if (config && config.apiKey) {
      return { connected: true, integrationId: "instaxbot", config };
    }
    return { connected: false, reason: "InstaxBot integration is disconnected or API key is missing" };
  }

  if (normPlatform === "gmail" || normPlatform === "google") {
    const account = await getGoogleAccount(workspaceId);
    if (account && account.accessToken) {
      return { connected: true, integrationId: "gmail", account };
    }
    return { connected: false, reason: "Gmail integration is disconnected or OAuth token is missing" };
  }

  if (normPlatform === "linkedin") {
    const account = await getLinkedInAccount(workspaceId);
    if (account && account.accessToken) {
      return { connected: true, integrationId: "linkedin", account };
    }
    return { connected: false, reason: "LinkedIn integration is disconnected or OAuth token is missing" };
  }

  if (normPlatform === "whatsapp" || normPlatform === "gowhats" || normPlatform === "channelbot") {
    return { connected: true, integrationId: "gowhats" };
  }

  if (normPlatform === "telegram" || normPlatform === "facebook" || normPlatform === "custom_webhook") {
    return { connected: true, integrationId: normPlatform };
  }

  return { connected: false, reason: `Platform ${platform} not recognized or disconnected` };
};

/**
 * Deduplicating Upsert Function for Unified Messages:
 * Uses findOneAndUpdate with { platform, externalMessageId } + { $setOnInsert: payload } & { upsert: true }
 * Wraps E11000 duplicate key error in a safe no-op.
 * Returns { doc, isNew: boolean } so socket pushes only fire on newly created messages.
 */
export const saveUnifiedMessage = async (data) => {
  const payload = {
    id: data.id || `msg_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    workspaceId: data.workspaceId || "ws_default",
    conversationId: data.conversationId,
    integrationId: data.integrationId || "default",
    platform: data.platform,
    externalMessageId: data.externalMessageId || data.id,
    sender: data.sender || { name: "Customer", kind: "customer" },
    direction: data.direction || "inbound",
    text: data.text || "",
    mediaUrl: data.mediaUrl || "",
    status: data.status || "received",
    receivedAt: data.receivedAt ? new Date(data.receivedAt) : new Date(),
  };

  if (isDbConnected && mongoose.connection.readyState === 1) {
    try {
      const result = await UnifiedMessageModel.findOneAndUpdate(
        { platform: payload.platform, externalMessageId: payload.externalMessageId },
        { $setOnInsert: payload },
        { upsert: true, new: true, rawResult: true }
      );

      const isNew = !result.lastErrorObject?.updatedExisting;
      const rawDoc = result.value || result;
      const doc = rawDoc ? (typeof rawDoc.toObject === "function" ? rawDoc.toObject() : rawDoc) : payload;
      return { doc, isNew };
    } catch (err) {
      if (err.code === 11000) {
        console.log(`ℹ️ [DEDUPLICATION GATE] Caught duplicate message [${payload.platform}:${payload.externalMessageId}]. Safe no-op.`);
        const existing = await UnifiedMessageModel.findOne({
          platform: payload.platform,
          externalMessageId: payload.externalMessageId,
        }).lean();
        return { doc: existing || payload, isNew: false };
      }
      throw err;
    }
  }

  // Fallback in-memory deduplication
  const existingIdx = db.unifiedMessages.findIndex(
    (m) => m.platform === payload.platform && m.externalMessageId === payload.externalMessageId
  );
  if (existingIdx !== -1) {
    console.log(`ℹ️ [MEMORY DEDUPLICATION] Caught duplicate message [${payload.platform}:${payload.externalMessageId}]. Safe no-op.`);
    return { doc: db.unifiedMessages[existingIdx], isNew: false };
  } else {
    db.unifiedMessages.unshift(payload);
    return { doc: payload, isNew: true };
  }
};

/**
 * Fetch unified inbox messages sorted by receivedAt desc
 */
export const fetchUnifiedInbox = async (workspaceId = "ws_default", limit = 50) => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    const filter = workspaceId
      ? { $or: [{ workspaceId }, { workspaceId: "ws_default" }, { workspaceId: { $exists: false } }] }
      : {};
    return await UnifiedMessageModel.find(filter).sort({ receivedAt: -1 }).limit(limit).lean();
  }
  return [...db.unifiedMessages]
    .filter((m) => !workspaceId || m.workspaceId === workspaceId || m.workspaceId === "ws_default" || !m.workspaceId)
    .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt))
    .slice(0, limit);
};
