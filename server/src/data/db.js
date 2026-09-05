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

export const ConversationModel = mongoose.models.Conversation || mongoose.model("Conversation", ConversationSchema);
export const MessageModel = mongoose.models.Message || mongoose.model("Message", MessageSchema);
export const LinkedInAccountModel = mongoose.models.LinkedInAccount || mongoose.model("LinkedInAccount", LinkedInAccountSchema);
export const GoogleAccountModel = mongoose.models.GoogleAccount || mongoose.model("GoogleAccount", GoogleAccountSchema);
export const InstaxBotAccountModel = mongoose.models.InstaxBotAccount || mongoose.model("InstaxBotAccount", InstaxBotAccountSchema);
export const ContactModel = mongoose.models.Contact || mongoose.model("Contact", ContactSchema);

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
    return await InstaxBotAccountModel.findOne({ workspaceId }).sort({ updatedAt: -1 }).lean();
  }
  return db.instaxbotAccounts.find((a) => a.workspaceId === workspaceId || !a.workspaceId) || null;
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
