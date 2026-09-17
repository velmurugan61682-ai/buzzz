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
  orders: [],
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
      enum: ["gmail", "instagram", "instaxbot", "linkedin", "whatsapp", "telegram", "facebook", "custom_webhook", "missed_call", "youtube", "channelbot"],
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
    status: { type: String, enum: ["received", "sent", "delivered", "read", "failed", "approved", "rejected", "pending", "flagged"], default: "received" },
    receivedAt: { type: Date, default: Date.now, index: true },
    metadata: { type: Object, default: {} },
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
    needsReauth: { type: Boolean, default: false },
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
    value: { type: String, default: "₹0" },
    ltv: { type: String, default: "₹0" },
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

const OrderSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, default: "ws_default", index: true },
    conversationId: { type: String, required: true, index: true },
    platform: { type: String, default: "whatsapp", index: true },
    externalOrderId: { type: String, required: true, index: true },
    orderId: { type: String, index: true },
    customerPhone: { type: String, required: true, index: true },
    customerName: { type: String, default: "WhatsApp Customer" },
    totalAmount: { type: Number, default: 0 },
    currency: { type: String, default: "INR" },
    status: { type: String, default: "pending" },
    paymentMethod: { type: String, default: "online" },
    paymentStatus: { type: String, default: "pending" },
    items: {
      type: [
        {
          name: { type: String, default: "Item" },
          quantity: { type: Number, default: 1 },
          price: { type: Number, default: 0 },
          totalPrice: { type: Number, default: 0 },
        },
      ],
      default: [],
    },
    flowToken: { type: String, default: "" },
    isPrinted: { type: Boolean, default: false },
    isPacked: { type: Boolean, default: false },
    metadata: { type: Object, default: {} },
    trackingHistory: { type: Array, default: [] },
  },
  { timestamps: true }
);

OrderSchema.index({ platform: 1, externalOrderId: 1 }, { unique: true });
OrderSchema.index({ customerPhone: 1, createdAt: -1 });

const SystemSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

const DealSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, default: "ws_default", index: true },
    name: { type: String, required: true },
    contactId: { type: String, default: "", index: true },
    pipelineId: { type: String, default: "p1" },
    stage: { type: String, default: "New Lead", index: true },
    value: { type: Number, default: 0 },
    prob: { type: Number, default: 50 },
    owner: { type: String, default: "Jordan Lee" },
    close: { type: String, default: "" },
    next: { type: String, default: "" },
    source: { type: String, default: "manual" },
    orderId: { type: String, default: "" },
  },
  { timestamps: true }
);

DealSchema.index({ workspaceId: 1, stage: 1 });
DealSchema.index({ workspaceId: 1, contactId: 1 });

export const ConversationModel = mongoose.models.Conversation || mongoose.model("Conversation", ConversationSchema);
export const MessageModel = mongoose.models.Message || mongoose.model("Message", MessageSchema);
export const UnifiedMessageModel = mongoose.models.UnifiedMessage || mongoose.model("UnifiedMessage", UnifiedMessageSchema);
export const LinkedInAccountModel = mongoose.models.LinkedInAccount || mongoose.model("LinkedInAccount", LinkedInAccountSchema);
export const GoogleAccountModel = mongoose.models.GoogleAccount || mongoose.model("GoogleAccount", GoogleAccountSchema);
export const InstaxBotAccountModel = mongoose.models.InstaxBotAccount || mongoose.model("InstaxBotAccount", InstaxBotAccountSchema);
export const ContactModel = mongoose.models.Contact || mongoose.model("Contact", ContactSchema);
export const DealModel = mongoose.models.Deal || mongoose.model("Deal", DealSchema);
export const MissedCallModel = mongoose.models.MissedCall || mongoose.model("MissedCall", MissedCallSchema);
export const UserModel = mongoose.models.User || mongoose.model("User", UserSchema);
export const OrderModel = mongoose.models.Order || mongoose.model("Order", OrderSchema);
export const SystemSettingModel = mongoose.models.SystemSetting || mongoose.model("SystemSetting", SystemSettingSchema);

export const getSystemSetting = async (key, defaultValue = null) => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    const doc = await SystemSettingModel.findOne({ key }).lean();
    return doc ? doc.value : defaultValue;
  }
  if (!db.systemSettings) db.systemSettings = {};
  return db.systemSettings[key] !== undefined ? db.systemSettings[key] : defaultValue;
};

export const setSystemSetting = async (key, value) => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    const doc = await SystemSettingModel.findOneAndUpdate(
      { key },
      { $set: { key, value } },
      { upsert: true, new: true }
    ).lean();
    return doc ? doc.value : value;
  }
  if (!db.systemSettings) db.systemSettings = {};
  db.systemSettings[key] = value;
  return value;
};


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
  value: "₹18,400",
  ltv: "₹18,400",
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

export const mergeDuplicateWhatsAppConversations = async () => {
  const canonicalPhone = String(process.env.WHATSAPP_PHONE_NUMBER || "919047484484").replace(/\D/g, "");
  const targetConvId = `conv_wa_${canonicalPhone}`;

  if (isDbConnected && mongoose.connection.readyState === 1) {
    try {
      const allConvs = await ConversationModel.find({
        $or: [{ channel: "WhatsApp" }, { channel: "whatsapp" }, { channel: "WHATSAPP" }],
      }).lean();

      const dupes = allConvs.filter(
        (c) =>
          c.id !== targetConvId &&
          (c.phone === "804376366097834" ||
            c.id === "conv_wa_804376366097834" ||
            (c.phone && c.phone.replace(/\D/g, "") === canonicalPhone) ||
            c.id === "conv_1")
      );

      if (dupes.length > 0) {
        const dupeIds = dupes.map((d) => d.id);
        console.log(`🧹 [DATA MIGRATION] Merging ${dupes.length} duplicate WhatsApp conversation(s) [${dupeIds.join(", ")}] into '${targetConvId}'...`);

        await UnifiedMessageModel.updateMany(
          { conversationId: { $in: dupeIds } },
          { $set: { conversationId: targetConvId } }
        );

        await MessageModel.updateMany(
          { conversationId: { $in: dupeIds } },
          { $set: { conversationId: targetConvId } }
        );

        await ConversationModel.deleteMany({ id: { $in: dupeIds } });

        const latestMsg = await UnifiedMessageModel.findOne({ conversationId: targetConvId }).sort({ receivedAt: -1 }).lean();
        await ConversationModel.findOneAndUpdate(
          { id: targetConvId },
          {
            $set: {
              id: targetConvId,
              workspaceId: "ws_default",
              customerName: `WhatsApp User (+${canonicalPhone})`,
              channel: "WhatsApp",
              phone: canonicalPhone,
              unreadCount: 0,
              lastMessage: latestMsg?.text || "WhatsApp conversation",
              updatedAt: latestMsg?.receivedAt || new Date(),
            },
          },
          { upsert: true }
        );
        console.log(`✅ [DATA MIGRATION] Duplicate WhatsApp conversations successfully merged into '${targetConvId}'.`);
      }
    } catch (err) {
      console.warn("⚠️ WhatsApp conversation merge warning:", err.message);
    }
    return;
  }

  const dupes = db.conversations.filter(
    (c) =>
      c.id !== targetConvId &&
      (c.phone === "804376366097834" ||
        c.id === "conv_wa_804376366097834" ||
        (c.phone && c.phone.replace(/\D/g, "") === canonicalPhone) ||
        c.id === "conv_1")
  );

  if (dupes.length > 0) {
    const dupeIds = new Set(dupes.map((d) => d.id));
    db.unifiedMessages.forEach((m) => {
      if (dupeIds.has(m.conversationId)) {
        m.conversationId = targetConvId;
      }
    });

    db.conversations = db.conversations.filter((c) => !dupeIds.has(c.id));

    const existing = db.conversations.find((c) => c.id === targetConvId);
    if (!existing) {
      db.conversations.unshift({
        id: targetConvId,
        workspaceId: "ws_default",
        customerName: `WhatsApp User (+${canonicalPhone})`,
        channel: "WhatsApp",
        phone: canonicalPhone,
        unreadCount: 0,
        lastMessage: "WhatsApp conversation",
        updatedAt: new Date().toISOString(),
      });
    }
  }
};

export const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("⚠️ MONGODB_URI is not defined in environment. Using in-memory dataset.");
    await mergeDuplicateWhatsAppConversations();
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

    // Merge any duplicate WhatsApp conversations created by legacy WABA ID bug
    await mergeDuplicateWhatsAppConversations();

    return true;
  } catch (err) {
    console.error(`❌ MongoDB connection failed: ${err.message}`);
    console.warn("⚠️ Falling back to in-memory dataset.");
    isDbConnected = false;
    await mergeDuplicateWhatsAppConversations();
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
    const legacyMsgs = await MessageModel.find({ conversationId }).sort({ createdAt: 1 }).lean();
    const unifiedMsgs = await UnifiedMessageModel.find({ conversationId }).sort({ receivedAt: 1, createdAt: 1 }).lean();

    const normalizedUnified = (unifiedMsgs || []).map((m) => ({
      id: m.id || String(m._id),
      conversationId: m.conversationId,
      sender: typeof m.sender === "object" ? (m.sender?.kind || (m.direction === "inbound" ? "customer" : "agent")) : (m.sender || (m.direction === "inbound" ? "customer" : "agent")),
      text: m.text || "",
      timestamp: m.receivedAt || m.createdAt || new Date().toISOString(),
      status: m.status || "received",
      platform: m.platform,
      externalMessageId: m.externalMessageId,
    }));

    const normalizedLegacy = (legacyMsgs || []).map((m) => ({
      id: m.id || String(m._id),
      conversationId: m.conversationId,
      sender: m.sender || "customer",
      text: m.text || "",
      timestamp: m.timestamp || m.createdAt || new Date().toISOString(),
      status: m.status || "received",
      platform: m.platform || "whatsapp",
      gowhatsMessageId: m.gowhatsMessageId,
      externalMessageId: m.gowhatsMessageId || m.id,
    }));

    // Deduplicate by externalMessageId / gowhatsMessageId / id / text+timestamp
    const seenKeys = new Set();
    const combined = [];

    for (const m of [...normalizedUnified, ...normalizedLegacy]) {
      const key = m.externalMessageId || m.gowhatsMessageId || m.id;
      if (key && seenKeys.has(key)) continue;
      if (key) seenKeys.add(key);
      combined.push(m);
    }

    combined.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    if (combined.length > 0) {
      return combined;
    }

    const conv = await ConversationModel.findOne({ id: conversationId }).lean();
    if (conv && conv.lastMessage) {
      return [
        {
          id: `msg_conv_${conv.id}`,
          conversationId: conv.id,
          sender: "customer",
          text: conv.lastMessage,
          timestamp: conv.updatedAt || new Date().toISOString(),
          status: "received",
          platform: conv.platform || (conv.channel || "").toLowerCase(),
        },
      ];
    }
    return [];
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
  const { _id, ...cleanData } = data || {};
  const payload = {
    ...cleanData,
    workspaceId: cleanData.workspaceId || "ws_default",
    expiresAt: cleanData.expiresAt ? new Date(cleanData.expiresAt) : new Date(Date.now() + 3600000),
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
    if (workspaceId === "ws_default") {
      const defaultDoc = await InstaxBotAccountModel.findOne({ workspaceId: "ws_default" }).sort({ updatedAt: -1 }).lean();
      if (defaultDoc) return defaultDoc;
    } else {
      return null;
    }
  }
  const mem = db.instaxbotAccounts.find((a) => a.workspaceId === workspaceId);
  if (mem) return mem;

  if ((workspaceId === "ws_default" || !workspaceId) && process.env.INSTAXBOT_API_KEY) {
    const clean = String(process.env.INSTAXBOT_API_KEY).trim();
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
    if (cleanStr.startsWith("conv_")) {
      const conv = await ConversationModel.findOne({ id: cleanStr }).lean();
      if (conv) {
        const handleOrPhone = conv.phone || conv.customerName || cleanStr.replace(/^conv_[a-z0-9]+_/, "");
        const cleanHandlePhone = String(handleOrPhone).replace(/\D/g, "");
        const orConds = [
          { name: conv.customerName },
          { "identities.value": handleOrPhone },
        ];
        if (cleanHandlePhone && cleanHandlePhone.length >= 7) {
          orConds.push({ phone: cleanHandlePhone });
          orConds.push({ "identities.value": cleanHandlePhone });
        }
        const contactByConv = await ContactModel.findOne({ $or: orConds }).lean();
        if (contactByConv) return normalizeMongoDoc(contactByConv);

        return {
          id: `c_${conv.id}`,
          workspaceId: conv.workspaceId || "ws_default",
          name: conv.customerName || handleOrPhone,
          phone: conv.phone || "",
          channels: [conv.channel?.toLowerCase() || "whatsapp"],
          stage: "Lead",
          status: "Active",
          source: conv.channel || "Unified Inbox",
          engagement: 75,
          score: 60,
        };
      }
    }

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
    if (doc) return normalizeMongoDoc(doc);
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
    try {
      const doc = await ContactModel.findOneAndUpdate(
        { id: payload.id },
        { $set: payload },
        { upsert: true, new: true }
      ).lean();
      return normalizeMongoDoc(doc);
    } catch (err) {
      if (err.code === 11000) {
        // Handle duplicate key error e.g. on workspaceId + phone or workspaceId + identities.value
        const conflictQueries = [];
        if (Array.isArray(payload.identities) && payload.identities.length > 0) {
          for (const idObj of payload.identities) {
            if (idObj && idObj.value) {
              conflictQueries.push({ "identities.value": idObj.value });
            }
          }
        }
        if (payload.phone) {
          conflictQueries.push({ phone: payload.phone });
          conflictQueries.push({ "identities.value": payload.phone });
        }
        if (payload.email) {
          conflictQueries.push({ email: payload.email });
        }

        let existing = null;
        if (conflictQueries.length > 0) {
          existing = await ContactModel.findOne({
            workspaceId: payload.workspaceId,
            $or: conflictQueries,
          });
        }

        if (existing) {
          let changed = false;
          if (
            (!existing.name || existing.name.toLowerCase().includes("unknown") || existing.name === existing.phone) &&
            payload.name &&
            !payload.name.toLowerCase().includes("unknown")
          ) {
            existing.name = payload.name;
            changed = true;
          }
          if (payload.channels && Array.isArray(payload.channels)) {
            for (const ch of payload.channels) {
              if (!existing.channels.includes(ch)) {
                existing.channels.push(ch);
                changed = true;
              }
            }
          }
          if (payload.phone && !existing.phone) {
            existing.phone = payload.phone;
            changed = true;
          }
          if (payload.email && !existing.email) {
            existing.email = payload.email;
            changed = true;
          }
          if (changed) {
            try {
              await existing.save();
            } catch (_sErr) {}
          }
          return normalizeMongoDoc(typeof existing.toObject === "function" ? existing.toObject() : existing);
        }
      }
      throw err;
    }
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
// DEALS DATA ACCESS FUNCTIONS (MONGO DB WITH IN-MEMORY FALLBACK)
// ==============================================================================
export const fetchDeals = async (workspaceId = "ws_default") => {
  if (isDbConnected && mongoose.connection.readyState === 1) {
    const filter = workspaceId ? { $or: [{ workspaceId }, { workspaceId: "ws_default" }] } : {};
    let deals = await DealModel.find(filter).sort({ createdAt: -1 }).lean();
    return deals.map(normalizeMongoDoc);
  }
  if (!db.deals) db.deals = [];
  return db.deals.filter((d) => !d.workspaceId || d.workspaceId === workspaceId || workspaceId === "ws_default").map(normalizeMongoDoc);
};

export const createDealRecord = async (dealData) => {
  const id = dealData.id || `deal_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const payload = {
    ...dealData,
    id,
    workspaceId: dealData.workspaceId || "ws_default",
    name: dealData.name || "Opportunity",
    contactId: dealData.contactId || "",
    pipelineId: dealData.pipelineId || "p1",
    stage: dealData.stage || "New Lead",
    value: Number(dealData.value) || 0,
    prob: Number(dealData.prob) !== undefined ? Number(dealData.prob) : 50,
    owner: dealData.owner || "Jordan Lee",
    close: dealData.close || "",
    next: dealData.next || "",
    source: dealData.source || "manual",
    orderId: dealData.orderId || "",
  };

  if (isDbConnected && mongoose.connection.readyState === 1) {
    const created = await DealModel.findOneAndUpdate(
      { id },
      { $set: payload },
      { upsert: true, new: true }
    ).lean();
    return normalizeMongoDoc(created);
  }

  if (!db.deals) db.deals = [];
  const idx = db.deals.findIndex((d) => d.id === id);
  if (idx !== -1) {
    db.deals[idx] = { ...db.deals[idx], ...payload };
    return db.deals[idx];
  }
  db.deals.unshift(payload);
  return payload;
};

export const updateDealRecord = async (id, updates, workspaceId = "ws_default") => {
  if (!id) return null;
  const cleanUpdates = { ...updates };
  if (cleanUpdates.value !== undefined) cleanUpdates.value = Number(cleanUpdates.value) || 0;
  if (cleanUpdates.prob !== undefined) cleanUpdates.prob = Number(cleanUpdates.prob) || 0;

  if (isDbConnected && mongoose.connection.readyState === 1) {
    const updated = await DealModel.findOneAndUpdate(
      { id },
      { $set: cleanUpdates },
      { new: true }
    ).lean();
    return updated ? normalizeMongoDoc(updated) : null;
  }

  if (!db.deals) db.deals = [];
  const idx = db.deals.findIndex((d) => d.id === id);
  if (idx !== -1) {
    db.deals[idx] = { ...db.deals[idx], ...cleanUpdates };
    return db.deals[idx];
  }
  return null;
};

export const deleteDealRecord = async (id, workspaceId = "ws_default") => {
  if (!id) return false;
  if (isDbConnected && mongoose.connection.readyState === 1) {
    const res = await DealModel.deleteOne({ id });
    return res.deletedCount > 0;
  }
  if (!db.deals) db.deals = [];
  const initialLen = db.deals.length;
  db.deals = db.deals.filter((d) => d.id !== id);
  return db.deals.length < initialLen;
};

export const syncDealsFromOrders = async (workspaceId = "ws_default") => {
  try {
    let orders = [];
    if (isDbConnected && mongoose.connection.readyState === 1) {
      orders = await OrderModel.find({ workspaceId: { $in: [workspaceId, "ws_default"] } }).lean();
    } else {
      orders = (db.orders || []).filter((o) => !o.workspaceId || o.workspaceId === workspaceId || workspaceId === "ws_default");
    }

    if (!orders || orders.length === 0) return [];

    const existingDeals = await fetchDeals(workspaceId);
    const existingOrderIds = new Set(existingDeals.map((d) => d.orderId).filter(Boolean));

    const createdDeals = [];
    for (const order of orders) {
      const extId = order.externalOrderId || order.id;
      if (existingOrderIds.has(extId)) continue;

      const isWon = order.paymentStatus === "paid" || order.status === "delivered" || order.status === "completed";
      const isNegotiation = order.status === "confirmed" || order.status === "processing";
      const stage = isWon ? "Won" : isNegotiation ? "Negotiation" : "Proposal Sent";

      const dealName = `${order.customerName || "Customer"} - Order #${order.orderId || extId.slice(-6)}`;
      const orderPlatform = order.platform || "order";
      const contactId = order.conversationId || (order.customerPhone ? `conv_wa_${String(order.customerPhone).replace(/\D/g, "")}` : "");
      const dealData = {
        id: `deal_order_${extId}`,
        workspaceId,
        name: dealName,
        contactId,
        pipelineId: "p1",
        stage,
        value: Number(order.totalAmount) || 0,
        prob: isWon ? 100 : 70,
        owner: "Sales Agent",
        close: order.createdAt ? new Date(order.createdAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
        next: `${orderPlatform === "instaxbot" ? "InstaxBot Instagram" : "WhatsApp"} Order status: ${order.status || "pending"}`,
        source: orderPlatform,
        orderId: extId,
      };

      const created = await createDealRecord(dealData);
      createdDeals.push(created);
    }
    return createdDeals;
  } catch (err) {
    console.warn("⚠️ syncDealsFromOrders warning:", err.message);
    return [];
  }
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
    metadata: data.metadata || {},
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
      // BUG 2 FIX: Skip 'custom' type identities as search keys.
      // 'custom' entries are internal routing duplicates (e.g. phone stored
      // again, or YouTube handle stored twice). Using them as lookup keys
      // caused cross-channel contact merges (YouTube lead resolving to
      // a WhatsApp contact that happened to also store its phone as 'custom').
      if (!idObj || !idObj.value) continue;
      const idType = String(idObj.type || "").toLowerCase();
      if (idType === "custom") continue;
      const rawVal = String(idObj.value).trim();
      const esc = rawVal.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
      searchConditions.push({ "identities.value": rawVal });
      searchConditions.push({ "identities.value": new RegExp(`^${esc}$`, "i") });
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
    // BUG 1 FIX: Build normalized value set for dedup — treats phone numbers
    // with different formatting (+91... vs 91...) as the same value.
    const existingNormValues = new Set(
      existingContact.identities.map((i) => {
        const v = String(i.value || "");
        // Normalize phone-like values by stripping non-digits
        return (i.type === "phone" || i.type === "whatsapp") ? v.replace(/\D/g, "") : v.toLowerCase();
      })
    );
    const isPhoneType = (t) => t === "phone" || t === "whatsapp";

    if (cleanPhone && !existingNormValues.has(cleanPhone)) {
      existingContact.identities.push({ type: "phone", value: cleanPhone });
      updated = true;
    }
    if (cleanEmail && !existingNormValues.has(cleanEmail)) {
      existingContact.identities.push({ type: "email", value: cleanEmail });
      updated = true;
    }
    if (Array.isArray(identities)) {
      for (const idObj of identities) {
        if (!idObj || !idObj.value) continue;
        const idType = String(idObj.type || "").toLowerCase();
        // Skip 'custom' identities — they are internal routing duplicates
        // and must not be stored as linked channel entries on the contact.
        if (idType === "custom") continue;
        const normVal = isPhoneType(idType)
          ? String(idObj.value).replace(/\D/g, "")
          : String(idObj.value).toLowerCase();
        if (!existingNormValues.has(normVal)) {
          existingContact.identities.push({ type: idType || "custom", value: idObj.value });
          existingNormValues.add(normVal);
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
        try {
          await existingContact.save();
          return normalizeMongoDoc(existingContact.toObject ? existingContact.toObject() : existingContact);
        } catch (saveErr) {
          if (saveErr.code === 11000) {
            const fresh = await ContactModel.findOne({ id: existingContact.id }).lean();
            if (fresh) return normalizeMongoDoc(fresh);
          } else {
            console.warn("⚠️ [resolveOrCreateContact] existingContact.save error:", saveErr.message);
          }
        }
      }
    }
    return normalizeMongoDoc(typeof existingContact.toObject === "function" ? existingContact.toObject() : existingContact);
  }

  // Create new contact if no existing record matched
  const newId = `cnt_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const initialIdentities = [];
  if (cleanPhone) initialIdentities.push({ type: "phone", value: cleanPhone });
  if (cleanEmail) initialIdentities.push({ type: "email", value: cleanEmail });
  if (Array.isArray(identities)) {
    const initNormVals = new Set(initialIdentities.map((i) => String(i.value).replace(/\D/g, "") || String(i.value).toLowerCase()));
    for (const idObj of identities) {
      if (!idObj || !idObj.value) continue;
      const idType = String(idObj.type || "").toLowerCase();
      // Skip 'custom' typed identities — do not store them as linked channel entries
      if (idType === "custom") continue;
      const normVal = (idType === "phone" || idType === "whatsapp")
        ? String(idObj.value).replace(/\D/g, "")
        : String(idObj.value).toLowerCase();
      if (!initNormVals.has(normVal)) {
        initialIdentities.push({ type: idType, value: idObj.value });
        initNormVals.add(normVal);
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

/**
 * Save / Update GoWhats WhatsApp Order with Strict Deduplication:
 * Pre-checks existence by [platform: "whatsapp", externalOrderId].
 * If existing: Updates fields (status, paymentStatus, items, totalAmount, etc.) if changed.
 * If new: Inserts order.
 * Returns { doc, isNew: boolean, isUpdated: boolean }.
 */
export const saveGoWhatsOrder = async (data) => {
  if (!data || typeof data !== "object") {
    return { doc: null, isNew: false, isUpdated: false };
  }

  const extId = String(data.externalOrderId || data._id || data.orderId || "").trim();
  if (!extId) {
    return { doc: null, isNew: false, isUpdated: false };
  }

  const cleanPhone = String(data.customerPhone || data.customerDetails?.phone || data.phone || "919047484484").replace(/\D/g, "");
  const convId = data.conversationId || `conv_wa_${cleanPhone}`;

  const payload = {
    id: data.id || `ord_${extId}`,
    workspaceId: data.workspaceId || "ws_default",
    conversationId: convId,
    platform: data.platform || "whatsapp",
    externalOrderId: extId,
    orderId: data.orderId || extId,
    customerPhone: cleanPhone,
    customerName: data.customerName || data.customerDetails?.name || `Customer (+${cleanPhone})`,
    totalAmount: typeof data.totalAmount === "number" ? data.totalAmount : parseFloat(data.totalAmount || 0),
    currency: data.currency || "INR",
    status: data.status || "pending",
    paymentMethod: data.paymentMethod || "online",
    paymentStatus: data.paymentStatus || "pending",
    items: Array.isArray(data.items)
      ? data.items.map((i) => ({
          name: i.name || i.title || "Product Item",
          quantity: typeof i.quantity === "number" ? i.quantity : parseInt(i.quantity || 1, 10),
          price: typeof i.price === "number" ? i.price : parseFloat(i.price || 0),
          totalPrice: typeof i.totalPrice === "number" ? i.totalPrice : parseFloat(i.totalPrice || 0),
        }))
      : [],
    flowToken: data.flowToken || "",
    isPrinted: Boolean(data.isPrinted),
    isPacked: Boolean(data.isPacked),
    metadata: data.metadata || {},
    trackingHistory: Array.isArray(data.trackingHistory) ? data.trackingHistory : [],
  };

  const compareItems = (a, b) => {
    const normA = (a || []).map((x) => ({ name: x.name, quantity: x.quantity, price: x.price, totalPrice: x.totalPrice }));
    const normB = (b || []).map((x) => ({ name: x.name, quantity: x.quantity, price: x.price, totalPrice: x.totalPrice }));
    return JSON.stringify(normA) === JSON.stringify(normB);
  };

  const orderPlatform = payload.platform || "whatsapp";

  if (isDbConnected && mongoose.connection.readyState === 1) {
    try {
      const existing = await OrderModel.findOne({
        platform: orderPlatform,
        externalOrderId: extId,
      }).lean();

      if (existing) {
        const isChanged =
          existing.status !== payload.status ||
          existing.paymentStatus !== payload.paymentStatus ||
          existing.totalAmount !== payload.totalAmount ||
          !compareItems(existing.items, payload.items);

        if (isChanged) {
          const updatedDoc = await OrderModel.findOneAndUpdate(
            { platform: orderPlatform, externalOrderId: extId },
            { $set: { ...payload, updatedAt: new Date() } },
            { new: true }
          ).lean();
          return { doc: normalizeMongoDoc(updatedDoc), isNew: false, isUpdated: true };
        }
        return { doc: normalizeMongoDoc(existing), isNew: false, isUpdated: false };
      }

      const created = await OrderModel.create({
        ...payload,
        createdAt: data.createdAt ? new Date(data.createdAt) : new Date(),
      });
      return { doc: normalizeMongoDoc(created.toObject()), isNew: true, isUpdated: false };
    } catch (err) {
      if (err.code === 11000) {
        const existing = await OrderModel.findOne({
          platform: orderPlatform,
          externalOrderId: extId,
        }).lean();
        return { doc: normalizeMongoDoc(existing || payload), isNew: false, isUpdated: false };
      }
      throw err;
    }
  }

  // Fallback in-memory deduplication
  if (!db.orders) db.orders = [];
  const existingIdx = db.orders.findIndex(
    (o) => o.platform === orderPlatform && o.externalOrderId === extId
  );

  if (existingIdx !== -1) {
    const existing = db.orders[existingIdx];
    const isChanged =
      existing.status !== payload.status ||
      existing.paymentStatus !== payload.paymentStatus ||
      existing.totalAmount !== payload.totalAmount ||
      !compareItems(existing.items, payload.items);

    if (isChanged) {
      db.orders[existingIdx] = { ...existing, ...payload, updatedAt: new Date().toISOString() };
      return { doc: db.orders[existingIdx], isNew: false, isUpdated: true };
    }
    return { doc: existing, isNew: false, isUpdated: false };
  } else {
    const newDoc = { ...payload, createdAt: new Date().toISOString() };
    db.orders.unshift(newDoc);
    return { doc: newDoc, isNew: true, isUpdated: false };
  }
};

export const saveOrderRecord = saveGoWhatsOrder;

/**
 * Fetch stored orders by customer phone number or conversation ID
 */
export const fetchOrdersByPhone = async (phone) => {
  const cleanPhone = String(phone || "").replace(/\D/g, "");
  const targetConvId = `conv_wa_${cleanPhone}`;

  if (isDbConnected && mongoose.connection.readyState === 1) {
    const docs = await OrderModel.find({
      $or: [
        { customerPhone: cleanPhone },
        { conversationId: targetConvId },
        ...(phone ? [{ customerPhone: phone }] : []),
      ],
    })
      .sort({ createdAt: -1 })
      .lean();
    return docs.map(normalizeMongoDoc);
  }

  if (!db.orders) db.orders = [];
  return db.orders
    .filter(
      (o) =>
        o.customerPhone === cleanPhone ||
        o.conversationId === targetConvId ||
        (phone && o.customerPhone === phone)
    )
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
};


