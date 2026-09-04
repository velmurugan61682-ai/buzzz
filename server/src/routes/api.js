import { Router } from "express";
import {
  db,
  getDbStatus,
  fetchConversations,
  fetchConversationById,
  findConversationByPhone,
  upsertConversation,
  fetchMessagesByConversationId,
  saveMessage,
  updateMessageStatus,
} from "../data/db.js";
import { getGoWhatsConfigStatus, sendWhatsAppMessage } from "../services/gowhats.js";

export const apiRouter = Router();

// Helper to extract workspace context
const getWorkspaceId = (req) => req.headers["x-workspace-id"] || "ws_default";

// Server-Sent Events (SSE) clients set for real-time push updates
const sseClients = new Set();

const broadcastSseEvent = (type, payload) => {
  const data = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
};

// Real-Time Events Streaming Endpoint (SSE)
apiRouter.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

// Health Endpoint (Includes DB & gowhats.in status)
apiRouter.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "buzzz-backend-api",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    database: getDbStatus(),
    gowhats: getGoWhatsConfigStatus(),
    activeSseSubscribers: sseClients.size,
  });
});

// Status helper endpoints
apiRouter.get("/gowhats/status", (req, res) => {
  res.json(getGoWhatsConfigStatus());
});

apiRouter.get("/channelbot/status", (req, res) => {
  res.json({
    service: "ChannelBot.in API Gateway",
    ...getGoWhatsConfigStatus(),
  });
});

// Helper function to process incoming webhooks from channelbot.in / gowhats.in
const processIncomingWebhook = async (body, channelName = "channelbot") => {
  const rawPhone =
    body.from ||
    body.sender ||
    body.phone ||
    body.number ||
    body.remoteJid ||
    body.key?.remoteJid ||
    body.data?.from ||
    body.data?.phone ||
    body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;

  if (!rawPhone) {
    throw new Error("Missing sender phone number in webhook payload");
  }

  const cleanPhone = String(rawPhone).replace(/\D/g, "");

  let textBody =
    (typeof body.text === "string" ? body.text : null) ||
    (typeof body.message === "string" ? body.message : null) ||
    body.body ||
    body.message?.conversation ||
    body.message?.extendedTextMessage?.text ||
    body.data?.message ||
    body.data?.text ||
    body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body ||
    "[Media / Attachment]";

  const gwMsgId = body.id || body.message_id || body.msg_id || body.key?.id || body.data?.id || `cb_${Date.now()}`;
  const profileName = body.name || body.pushName || body.sender_name || body.data?.name || body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name || `+${cleanPhone}`;
  const isoTimestamp = body.timestamp ? new Date(body.timestamp).toISOString() : new Date().toISOString();

  let conv = (await findConversationByPhone(cleanPhone, "channelbot")) || (await findConversationByPhone(cleanPhone, "WhatsApp"));

  if (!conv) {
    const convId = `conv_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    conv = {
      id: convId,
      workspaceId: "ws_default",
      customerName: profileName,
      channel: "channelbot",
      phone: cleanPhone,
      unreadCount: 1,
      lastMessage: textBody,
      updatedAt: isoTimestamp,
    };
  } else {
    conv = {
      ...conv,
      customerName: profileName || conv.customerName,
      lastMessage: textBody,
      unreadCount: (conv.unreadCount || 0) + 1,
      updatedAt: isoTimestamp,
    };
  }

  await upsertConversation(conv);

  const msgDoc = {
    id: `msg_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    conversationId: conv.id,
    sender: "customer",
    text: textBody,
    timestamp: isoTimestamp,
    gowhatsMessageId: gwMsgId,
    status: "received",
  };

  await saveMessage(msgDoc);

  // Broadcast SSE event for instant real-time frontend inbox update
  broadcastSseEvent("message:new", { conversation: conv, message: msgDoc });

  console.log(`📩 Incoming ChannelBot.in message processed from ${cleanPhone} (${profileName}): "${textBody}"`);
  return { conv, msgDoc };
};

// ==============================================================================
// INCOMING CHANNELBOT.IN WEBHOOK (POST /api/v1/webhooks/channelbot)
// ==============================================================================
apiRouter.post("/webhooks/channelbot", async (req, res) => {
  const expectedSecret = process.env.CHANNELBOT_WEBHOOK_VERIFY_SECRET || process.env.GOWHATS_WEBHOOK_VERIFY_SECRET;
  if (expectedSecret) {
    const providedSecret =
      req.headers["x-channelbot-secret"] ||
      req.headers["x-gowhats-secret"] ||
      req.headers["x-webhook-secret"] ||
      req.query.secret ||
      req.body?.secret;

    if (providedSecret !== expectedSecret) {
      console.warn("⚠️ Rejecting unauthorized channelbot.in webhook request (secret mismatch)");
      return res.status(401).json({ error: "Unauthorized webhook payload: secret mismatch" });
    }
  }

  res.status(200).json({ status: "received" });

  try {
    await processIncomingWebhook(req.body || {}, "channelbot");
  } catch (err) {
    console.error("❌ Error processing incoming channelbot.in webhook:", err.message);
  }
});

// Legacy / alias route
apiRouter.post("/webhooks/gowhats", async (req, res) => {
  res.status(200).json({ status: "received" });
  try {
    await processIncomingWebhook(req.body || {}, "channelbot");
  } catch (err) {
    console.error("❌ Error processing incoming gowhats.in webhook:", err.message);
  }
});

// Simulator endpoint to test incoming channelbot.in messages landing directly in Inbox
apiRouter.post("/channelbot/simulate-incoming", async (req, res) => {
  try {
    const payload = req.body || {};
    const defaultPayload = {
      from: payload.phone || payload.from || "919047484484",
      name: payload.name || "Velmurugan",
      message: payload.message || payload.text || "Vanakkam! New message from ChannelBot.in API test",
      timestamp: new Date().toISOString(),
    };
    const result = await processIncomingWebhook(defaultPayload, "channelbot");
    res.status(200).json({ success: true, message: "ChannelBot message created and pushed to Inbox", ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==============================================================================
// INBOX & CONVERSATIONS (STEP 2 & STEP 4)
// ==============================================================================
apiRouter.get("/conversations", async (req, res, next) => {
  try {
    const wsId = getWorkspaceId(req);
    const conversations = await fetchConversations(wsId);
    res.json(conversations);
  } catch (err) {
    next(err);
  }
});

apiRouter.get("/conversations/:convId/messages", async (req, res, next) => {
  try {
    const { convId } = req.params;
    const messages = await fetchMessagesByConversationId(convId);
    res.json(messages);
  } catch (err) {
    next(err);
  }
});

apiRouter.post("/conversations/:convId/messages", async (req, res, next) => {
  try {
    const { convId } = req.params;
    const { text, sender = "agent" } = req.body || {};

    if (!text) {
      return res.status(400).json({
        code: "bad_request",
        message: "Message text is required",
        field: "text",
      });
    }

    const conv = await fetchConversationById(convId);
    if (!conv) {
      return res.status(404).json({
        code: "not_found",
        message: `Conversation with id ${convId} not found`,
      });
    }

    let gowhatsMessageId = null;
    let initialStatus = sender === "agent" ? "sent" : "received";
    let gowhatsSendError = null;

    // STEP 4: Outbound gowhats.in Sending for Agent replies
    if (conv.channel === "WhatsApp" && sender === "agent" && conv.phone) {
      try {
        const sendResult = await sendWhatsAppMessage({ to: conv.phone, text });
        gowhatsMessageId = sendResult.gowhatsMessageId;
        initialStatus = "sent";
        console.log(`📤 Outbound WhatsApp message sent via gowhats.in to ${conv.phone} (id: ${gowhatsMessageId})`);
      } catch (err) {
        console.error(`❌ Failed to send WhatsApp message via gowhats.in to ${conv.phone}:`, err.message);
        initialStatus = "failed";
        gowhatsSendError = err.message;
      }
    }

    // Save message doc to MongoDB
    const newMsg = {
      id: `msg_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      conversationId: convId,
      sender,
      text,
      timestamp: new Date().toISOString(),
      gowhatsMessageId,
      status: initialStatus,
    };

    const savedMsg = await saveMessage(newMsg);

    // Update conversation lastMessage & reset unreadCount if agent replied
    const updatedConv = {
      ...conv,
      lastMessage: text,
      unreadCount: sender === "agent" ? 0 : conv.unreadCount,
      updatedAt: new Date().toISOString(),
    };
    await upsertConversation(updatedConv);

    // Broadcast SSE event for real-time UI updates
    broadcastSseEvent("message:new", { conversation: updatedConv, message: savedMsg });

    if (gowhatsSendError) {
      return res.status(502).json({
        code: "gowhats_send_failed",
        message: `Saved message locally, but gowhats.in delivery failed: ${gowhatsSendError}`,
        savedMessage: savedMsg,
      });
    }

    res.status(201).json(savedMsg);
  } catch (err) {
    next(err);
  }
});

// ==========================================
// OTHER CRM ROUTES (CONTACTS, DEALS, TASKS, ETC.)
// ==========================================
apiRouter.get("/contacts", (req, res) => {
  const wsId = getWorkspaceId(req);
  const contacts = db.contacts.filter((c) => !c.workspaceId || c.workspaceId === wsId);
  res.json(contacts);
});

apiRouter.post("/contacts", (req, res) => {
  const wsId = getWorkspaceId(req);
  const { name, email, phone, company, status, score } = req.body || {};

  if (!name && !email && !phone) {
    return res.status(400).json({
      code: "bad_request",
      message: "At least one of name, email, or phone is required",
    });
  }

  const cleanPhone = phone ? String(phone).replace(/\D/g, "") : "";
  const cleanEmail = email ? String(email).toLowerCase().trim() : "";
  const cleanName = name ? String(name).trim() : "";

  // Check if contact already exists to avoid duplicates
  const existingIndex = db.contacts.findIndex(
    (c) =>
      (cleanEmail && c.email && c.email.toLowerCase().trim() === cleanEmail) ||
      (cleanPhone && c.phone && c.phone.replace(/\D/g, "") === cleanPhone) ||
      (cleanName && c.name && c.name.toLowerCase().trim() === cleanName.toLowerCase())
  );

  if (existingIndex !== -1) {
    const existing = db.contacts[existingIndex];
    if (cleanEmail && !existing.email) existing.email = cleanEmail;
    if (cleanPhone && !existing.phone) existing.phone = cleanPhone;
    if (company && (!existing.company || existing.company === "—")) existing.company = company;
    if (status) existing.status = status;
    return res.status(200).json({ ...existing, deduplicated: true, message: "Matched & merged existing contact" });
  }

  const newContact = {
    id: `cnt_${Date.now()}`,
    workspaceId: wsId,
    name: cleanName || cleanPhone || "New Contact",
    email: cleanEmail,
    phone: cleanPhone || phone || "",
    company: company || "—",
    status: status || "Lead",
    score: score || 50,
    createdAt: new Date().toISOString(),
  };

  db.contacts.unshift(newContact);
  res.status(201).json(newContact);
});

// Endpoint to automatically deduplicate & remove duplicate contacts
apiRouter.post("/contacts/deduplicate", (req, res) => {
  const wsId = getWorkspaceId(req);
  let removedCount = 0;
  const toRemove = new Set();

  for (let i = 0; i < db.contacts.length; i++) {
    if (toRemove.has(db.contacts[i].id)) continue;
    for (let j = i + 1; j < db.contacts.length; j++) {
      if (toRemove.has(db.contacts[j].id)) continue;
      const a = db.contacts[i];
      const b = db.contacts[j];

      const matchEmail = a.email && b.email && a.email.toLowerCase().trim() === b.email.toLowerCase().trim();
      const matchPhone = a.phone && b.phone && a.phone.replace(/\D/g, "") === b.phone.replace(/\D/g, "") && a.phone.replace(/\D/g, "").length >= 7;
      const matchName = a.name && b.name && a.name.toLowerCase().trim() === b.name.toLowerCase().trim();

      if (matchEmail || matchPhone || matchName) {
        if (!a.phone && b.phone) a.phone = b.phone;
        if (!a.email && b.email) a.email = b.email;
        if (!a.company && b.company) a.company = b.company;
        toRemove.add(b.id);
        removedCount++;
      }
    }
  }

  db.contacts = db.contacts.filter((c) => !toRemove.has(c.id));

  res.json({
    success: true,
    message: `Successfully deduplicated contacts. Removed ${removedCount} duplicate record(s).`,
    removedCount,
    remainingCount: db.contacts.length,
  });
});

apiRouter.get("/companies", (req, res) => {
  const wsId = getWorkspaceId(req);
  const companies = db.companies.filter((c) => !c.workspaceId || c.workspaceId === wsId);
  res.json(companies);
});

apiRouter.get("/deals", (req, res) => {
  const wsId = getWorkspaceId(req);
  const deals = db.deals.filter((d) => !d.workspaceId || d.workspaceId === wsId);
  res.json(deals);
});

apiRouter.get("/tasks", (req, res) => {
  const wsId = getWorkspaceId(req);
  const tasks = db.tasks.filter((t) => !t.workspaceId || t.workspaceId === wsId);
  res.json(tasks);
});

apiRouter.get("/appointments", (req, res) => {
  const wsId = getWorkspaceId(req);
  const appointments = db.appointments.filter((a) => !a.workspaceId || a.workspaceId === wsId);
  res.json(appointments);
});

apiRouter.get("/agents", (req, res) => {
  const wsId = getWorkspaceId(req);
  const agents = db.agents.filter((a) => !a.workspaceId || a.workspaceId === wsId);
  res.json(agents);
});

apiRouter.get("/workflows", (req, res) => {
  const wsId = getWorkspaceId(req);
  const workflows = db.workflows.filter((w) => !w.workspaceId || w.workspaceId === wsId);
  res.json(workflows);
});
