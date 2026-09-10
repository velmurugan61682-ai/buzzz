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
      enum: ["gmail", "instagram", "linkedin", "whatsapp", "telegram", "facebook", "custom_webhook", "missed_call", "youtube", "channelbot"],
      index: true,
    },
    externalMessageId: { type: String, required: true, index: true },
    sender: {
      type: {
        name: { type: String, default: "Customer" },
        handle: { type: String, default: "" },
        email: { type: String, default: "" },
        phone: { type: String, default: "" },
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
    scopes: { type: [String], default: ["openid", "profile", "email", "w_member_social"] },
    connectedAt: { type: Date, default: Date.now },
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
    identities: {
      type: [
        {
          type: { type: String, required: true },
          value: { type: String, required: true, index: true },
        },
      ],
      default: [],
    },
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

// Database-level Unique Indexes: Prevent duplicate phone numbers & identities per workspace
ContactSchema.index(
  { workspaceId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: "string", $gt: "" } }, name: "uniq_workspace_phone" }
);
ContactSchema.index(
  { workspaceId: 1, "identities.type": 1, "identities.value": 1 },
  { unique: true, partialFilterExpression: { "identities.value": { $type: "string", $gt: "" } }, name: "uniq_workspace_identity" }
);

const MissedCallSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    deviceId: { type: String, required: true, index: true },
    phoneNumber: { type: String, required: true, index: true },
    contactName: { type: String, default: "Unknown Caller" },
    email: { type: String, default: "" },
    type: { type: String, default: "MISSED" },
    calledAt: { type: Date, required: true, index: true },
    createdAt: { type: Date, default: Date.now },
    syncSource: { type: String, default: "android_companion" },
    externalCallId: { type: String, required: true, unique: true, index: true },
    contactId: { type: String, index: true },
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
export const MissedCallModel = mongoose.models.MissedCall || mongoose.model("MissedCall", MissedCallSchema);
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

// Helper to normalize MongoDB documents (ensures id and required defaults)
const normalizeMongoDoc = (doc) => {
  if (!doc) return doc;
  const id = doc.id || (doc._id ? String(doc._id) : undefined);
  return {
    ...doc,
    id,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
  };
};

// ==============================================================================
// 4. DATA ACCESS FUNCTIONS (MONGO DB WITH IN-MEMORY FALLBACK)
// ==============================================================================
export const fetchConversations = async (workspaceId = "ws_default") => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    const filter = workspaceId ? { $or: [{ workspaceId }, { workspaceId: "ws_default" }] } : {};
    const docs = await ConversationModel.find(filter).sort({ updatedAt: -1 }).lean();
    return docs.map(normalizeMongoDoc);
  }
  return db.conversations.filter((c) => !c.workspaceId || c.workspaceId === workspaceId || workspaceId === "ws_default").map(normalizeMongoDoc);
};

export const fetchConversationById = async (id) => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    const doc = await ConversationModel.findOne({ $or: [{ id }, { _id: mongoose.isValidObjectId(id) ? id : null }] }).lean();
    return normalizeMongoDoc(doc);
  }
  return normalizeMongoDoc(db.conversations.find((c) => c.id === id) || null);
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
    scopes: data.scopes || ["openid", "profile", "email", "w_member_social"],
    connectedAt: data.connectedAt ? new Date(data.connectedAt) : new Date(),
  };

  if (isDbConnected && mongoose.connection.readyState === 1) {
    const doc = await LinkedInAccountModel.findOneAndUpdate(
      { workspaceId: payload.workspaceId },
      { $set: payload },
      { upsert: true, new: true }
    ).lean();
    return doc;
  }

  const idx = db.linkedinAccounts.findIndex(
    (a) => a.workspaceId === payload.workspaceId
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

export const deleteLinkedInAccount = async (workspaceId = "ws_default") => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    return await LinkedInAccountModel.deleteMany({ workspaceId });
  }
  db.linkedinAccounts = db.linkedinAccounts.filter((a) => a.workspaceId !== workspaceId);
  return { deletedCount: 1 };
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
  const mem = db.instaxbotAccounts.find(
    (a) => a.workspaceId === workspaceId || a.workspaceId === "ws_default" || !a.workspaceId
  );
  if (mem) return mem;

  const envKey = process.env.INSTAXBOT_API_KEY;
  if (envKey) {
    const clean = String(envKey).trim();
    const maskedKey = "••••" + clean.slice(-4);
    return {
      workspaceId,
      apiKey: clean,
      maskedKey,
      accountName: `InstaxBot Account (${maskedKey})`,
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
    const hasSeed = contacts.some((c) => c.id === "c1" || String(c._id) === "c1");
    if (!hasSeed) {
      try {
        await ContactModel.findOneAndUpdate({ id: "c1" }, { $set: seedContact }, { upsert: true });
        contacts = await ContactModel.find(filter).sort({ createdAt: -1 }).lean();
      } catch (err) {
        console.warn("⚠️ Contact seed warning:", err.message);
      }
    }
    return contacts.map(normalizeMongoDoc);
  }
  return db.contacts.filter((c) => !c.workspaceId || c.workspaceId === workspaceId || workspaceId === "ws_default").map(normalizeMongoDoc);
};

export const fetchContactById = async (id) => {
  if (!id) return null;
  const cleanStr = String(id).trim();
  const cleanPhone = cleanStr.replace(/\D/g, "");
  const cleanEmail = cleanStr.toLowerCase();

  if (isDbConnected && mongoose.connection.readyState === 1) {
    const orConditions = [
      { id: cleanStr },
      ...(mongoose.isValidObjectId(cleanStr) ? [{ _id: cleanStr }] : []),
      { email: cleanEmail },
      { "identities.value": cleanStr },
    ];
    if (cleanPhone && cleanPhone.length >= 7) {
      orConditions.push({ phone: cleanPhone });
      orConditions.push({ "identities.value": cleanPhone });
    }

    const doc = await ContactModel.findOne({ $or: orConditions }).lean();
    return normalizeMongoDoc(doc);
  }

  const found = db.contacts.find(
    (c) =>
      c.id === cleanStr ||
      (c._id && String(c._id) === cleanStr) ||
      (cleanPhone && cleanPhone.length >= 7 && c.phone && String(c.phone).replace(/\D/g, "") === cleanPhone) ||
      (c.email && c.email.toLowerCase() === cleanEmail) ||
      (Array.isArray(c.identities) && c.identities.some((i) => i && i.value === cleanStr))
  );
  return normalizeMongoDoc(found || null);
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
      const existing = await UnifiedMessageModel.findOne({
        platform: payload.platform,
        externalMessageId: payload.externalMessageId,
      }).lean();

      if (existing) {
        return { doc: existing, isNew: false };
      }

      const doc = await UnifiedMessageModel.create(payload);
      return { doc: doc.toObject(), isNew: true };
    } catch (err) {
      if (err.code === 11000) {
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
    if (process.env.DEBUG) {
      console.log(`ℹ️ [MEMORY DEDUPLICATION] Caught duplicate message [${payload.platform}:${payload.externalMessageId}]. Safe no-op.`);
    }
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

// ==============================================================================
// CENTRAL UNIFIED CONTACT RESOLUTION ENGINE & MISSED CALL DATA ACCESS
// ==============================================================================

/**
 * Shared Central Contact Resolution Engine across ALL channels:
 * Cross-matches incoming phone number, email, or linked identities against existing Contact records.
 * If a match is found on ANY identity (phone OR email OR linked identities), links to that SAME Contact,
 * merges new identities, updates name/channels, and returns the unified Contact object.
 * If no match is found, creates a new unified Contact record.
 */
export const resolveOrCreateContact = async ({
  workspaceId = "ws_default",
  name = "",
  phone = "",
  email = "",
  identities = [],
  source = "Manual entry",
  channel = null,
}) => {
  const cleanPhone = phone ? String(phone).replace(/\D/g, "") : "";
  const cleanEmail = email ? String(email).trim().toLowerCase() : "";
  const cleanName = name && !name.toLowerCase().includes("unknown") ? name.trim() : "";

  const searchConditions = [];
  if (cleanPhone) {
    searchConditions.push({ phone: cleanPhone });
    searchConditions.push({ "identities.value": cleanPhone });
  }
  if (cleanEmail) {
    searchConditions.push({ email: cleanEmail });
    searchConditions.push({ "identities.value": cleanEmail });
  }
  if (Array.isArray(identities) && identities.length > 0) {
    for (const idObj of identities) {
      if (idObj && idObj.value) {
        const rawVal = String(idObj.value).trim();
        const esc = rawVal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        searchConditions.push({ "identities.value": rawVal });
        searchConditions.push({ "identities.value": new RegExp(`^${esc}$`, "i") });
      }
    }
  }

  let existingContact = null;

  if (isDbConnected && mongoose.connection.readyState === 1 && searchConditions.length > 0) {
    existingContact = await ContactModel.findOne({
      workspaceId: workspaceId || "ws_default",
      $or: searchConditions,
    });
  } else if (!isDbConnected && db.contacts && searchConditions.length > 0) {
    existingContact = db.contacts.find((c) => {
      const cPhone = c.phone ? String(c.phone).replace(/\D/g, "") : "";
      const cEmail = c.email ? String(c.email).trim().toLowerCase() : "";
      const hasPhoneMatch = cleanPhone && (cPhone === cleanPhone || (c.identities || []).some((i) => i.value === cleanPhone));
      const hasEmailMatch = cleanEmail && (cEmail === cleanEmail || (c.identities || []).some((i) => i.value === cleanEmail));
      return hasPhoneMatch || hasEmailMatch;
    });
  }

  if (existingContact) {
    let updated = false;
    if (cleanName && (!existingContact.name || existingContact.name.toLowerCase().includes("unknown") || existingContact.name === existingContact.phone || existingContact.name === existingContact.email)) {
      existingContact.name = cleanName;
      updated = true;
    }
    if (cleanPhone && !existingContact.phone) {
      existingContact.phone = cleanPhone;
      updated = true;
    }
    if (cleanEmail && !existingContact.email) {
      existingContact.email = cleanEmail;
      updated = true;
    }

    if (!existingContact.identities) existingContact.identities = [];
    const currentValues = new Set(existingContact.identities.map((i) => i.value));

    if (cleanPhone && !currentValues.has(cleanPhone)) {
      existingContact.identities.push({ type: "phone", value: cleanPhone });
      updated = true;
    }
    if (cleanEmail && !currentValues.has(cleanEmail)) {
      existingContact.identities.push({ type: "email", value: cleanEmail });
      updated = true;
    }
    if (Array.isArray(identities)) {
      for (const idObj of identities) {
        if (idObj && idObj.value && !currentValues.has(idObj.value)) {
          existingContact.identities.push({ type: idObj.type || "custom", value: idObj.value });
          updated = true;
        }
      }
    }

    if (channel && Array.isArray(existingContact.channels) && !existingContact.channels.includes(channel)) {
      existingContact.channels.push(channel);
      updated = true;
    }

    if (updated) {
      if (isDbConnected && mongoose.connection.readyState === 1 && typeof existingContact.save === "function") {
        await existingContact.save();
        return existingContact.toObject();
      }
    }
    return typeof existingContact.toObject === "function" ? existingContact.toObject() : existingContact;
  }

  // Create new contact if no existing record matched
  const newId = `cnt_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const initialIdentities = [];
  if (cleanPhone) initialIdentities.push({ type: "phone", value: cleanPhone });
  if (cleanEmail) initialIdentities.push({ type: "email", value: cleanEmail });
  if (Array.isArray(identities)) {
    for (const idObj of identities) {
      if (idObj && idObj.value && !initialIdentities.some((i) => i.value === idObj.value)) {
        initialIdentities.push({ type: idObj.type || "custom", value: idObj.value });
      }
    }
  }

  const payload = {
    id: newId,
    workspaceId: workspaceId || "ws_default",
    name: cleanName || cleanPhone || cleanEmail || "Unknown Contact",
    phone: cleanPhone,
    email: cleanEmail,
    identities: initialIdentities,
    source,
    channels: channel ? [channel] : ["email", "whatsapp"],
    stage: "New Lead",
    status: "Lead",
  };

  return await upsertContact(payload);
};

export const saveMissedCall = async (data) => {
  const payload = {
    id: data.id || `mc_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    userId: data.userId || "usr_default",
    deviceId: data.deviceId || "dev_default",
    phoneNumber: data.phoneNumber,
    contactName: data.contactName || "Unknown Caller",
    email: data.email || "",
    type: data.type || "MISSED",
    calledAt: data.calledAt ? new Date(data.calledAt) : new Date(),
    createdAt: new Date(),
    syncSource: data.syncSource || "android_companion",
    externalCallId: data.externalCallId,
    contactId: data.contactId || "",
  };

  if (isDbConnected && mongoose.connection.readyState === 1) {
    try {
      const existing = await MissedCallModel.findOne({ externalCallId: payload.externalCallId }).lean();
      if (existing) {
        if (process.env.DEBUG) console.log(`ℹ️ [MISSED CALL DEDUPE] Found existing duplicate missed call [${payload.externalCallId}]. Skipping creation.`);
        return { doc: existing, isNew: false };
      }
      const doc = await MissedCallModel.create(payload);
      return { doc: doc.toObject(), isNew: true };
    } catch (err) {
      if (err.code === 11000) {
        if (process.env.DEBUG) console.log(`ℹ️ [MISSED CALL DEDUPE] Caught duplicate missed call [${payload.externalCallId}]. Safe no-op.`);
        const existing = await MissedCallModel.findOne({ externalCallId: payload.externalCallId }).lean();
        return { doc: existing || payload, isNew: false };
      }
      throw err;
    }
  }

  if (!db.missedCalls) db.missedCalls = [];
  const existingIdx = db.missedCalls.findIndex((m) => m.externalCallId === payload.externalCallId);
  if (existingIdx !== -1) {
    return { doc: db.missedCalls[existingIdx], isNew: false };
  } else {
    db.missedCalls.unshift(payload);
    return { doc: payload, isNew: true };
  }
};

export const fetchMissedCalls = async (userId = null, limit = 20, page = 1) => {
  const skip = (page - 1) * limit;
  if (isDbConnected && mongoose.connection.readyState === 1) {
    const filter = userId ? { userId } : {};
    const docs = await MissedCallModel.find(filter).sort({ calledAt: -1 }).skip(skip).limit(limit).lean();
    const total = await MissedCallModel.countDocuments(filter);
    return { docs, total, page, limit };
  }
  if (!db.missedCalls) db.missedCalls = [];
  const filtered = userId ? db.missedCalls.filter((m) => m.userId === userId) : db.missedCalls;
  const docs = filtered.slice(skip, skip + limit);
  return { docs, total: filtered.length, page, limit };
};

