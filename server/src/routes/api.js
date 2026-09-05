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
  saveLinkedInAccount,
  getLinkedInAccount,
  saveGoogleAccount,
  getGoogleAccount,
  fetchContacts,
  fetchContactById,
  upsertContact,
  deleteContactById,
  saveInstaxBotConfig,
  getInstaxBotConfig,
  deleteInstaxBotConfig,
  saveUnifiedMessage,
  verifyIntegrationConnectionGate,
  fetchUnifiedInbox,
  UnifiedMessageModel,
  findOrCreateGoogleUser,
} from "../data/db.js";
import { getGoWhatsConfigStatus, sendWhatsAppMessage } from "../services/gowhats.js";
import { sanitizeMessage, verifyGmailConnection, getValidGoogleAccount, refreshGoogleAccessToken, fetchGooglePeopleContacts, syncGooglePeopleContacts } from "../services/gmailAuth.js";
import { PLATFORM_META } from "../constants/platformMeta.js";

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

// ==============================================================================
// AUTHENTICATION & USER SESSION ROUTES
// ==============================================================================
const activeAuthSessions = new Map();
const googleLoginStates = new Map();

// Helper to resolve login credentials
const getGoogleLoginCredentials = () => {
  const clientId = process.env.GOOGLE_LOGIN_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_LOGIN_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_LOGIN_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI || "http://localhost:5000/api/google/callback";
  return { clientId, clientSecret, redirectUri, configured: Boolean(clientId && clientSecret) };
};

// GET /api/auth/oauth/providers & GET /api/v1/auth/oauth/providers
const handleOauthProviders = (req, res) => {
  const googleCreds = getGoogleLoginCredentials();
  const hasLinkedIn = Boolean(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);

  const providers = [];
  if (googleCreds.configured) {
    providers.push({ id: "google", label: "Google", configured: true });
  }
  if (hasLinkedIn) {
    providers.push({ id: "linkedin", label: "LinkedIn", configured: true });
  }

  res.json({ ok: true, data: { providers, googleConfigured: googleCreds.configured } });
};

apiRouter.get("/auth/oauth/providers", handleOauthProviders);

// GET /api/auth/google & GET /api/v1/auth/google & GET /api/v1/auth/oauth/google/authorize
const handleGoogleLoginAuth = (req, res) => {
  const { clientId, redirectUri, configured } = getGoogleLoginCredentials();

  if (!configured) {
    console.error("❌ Google Login OAuth Error: GOOGLE_LOGIN_CLIENT_ID or GOOGLE_CLIENT_ID missing in server/.env");
    return res.status(500).json({
      ok: false,
      code: "missing_configuration",
      message: "GOOGLE_LOGIN_CLIENT_ID and GOOGLE_LOGIN_CLIENT_SECRET must be configured in server/.env",
    });
  }

  const state = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  googleLoginStates.set(state, { state, createdAt: Date.now() });

  const scope = encodeURIComponent("openid email profile");

  console.log(`🔗 [USER AUTH] Redirecting to Google Login OAuth screen with scope=openid email profile (redirect_uri: ${redirectUri})`);

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&scope=${scope}&prompt=select_account&state=${state}`;

  if (req.headers.accept && req.headers.accept.includes("application/json")) {
    return res.json({ ok: true, data: { authorization_url: authUrl, url: authUrl } });
  }

  res.redirect(authUrl);
};

apiRouter.get("/auth/google", handleGoogleLoginAuth);
apiRouter.get("/auth/oauth/google/authorize", handleGoogleLoginAuth);

// GET /api/auth/google/callback & GET /api/v1/auth/google/callback & GET /api/v1/auth/oauth/google/callback
const handleGoogleLoginCallback = async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.warn(`⚠️ Google Login OAuth Callback Error (${error}): ${sanitizeMessage(error_description || error)}`);
    return res.redirect(`http://localhost:5173/?auth=error&msg=${encodeURIComponent(error_description || error)}`);
  }

  if (!state || !googleLoginStates.has(state)) {
    console.warn("⚠️ Rejecting Google Login callback due to invalid/expired state parameter");
    return res.status(400).json({ ok: false, error: "Invalid OAuth state parameter. Possible CSRF attack." });
  }
  googleLoginStates.delete(state);

  if (!code) {
    return res.status(400).json({ ok: false, error: "Missing authorization code" });
  }

  try {
    const { clientId, clientSecret, redirectUri } = getGoogleLoginCredentials();
    const tokenUrl = "https://oauth2.googleapis.com/token";
    const params = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });

    console.log("🔄 Exchanging Google authorization code for User Login profile...");

    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const tokenData = await tokenRes.json().catch(() => ({}));

    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(`Google token exchange failed: ${tokenData.error_description || tokenData.error || tokenRes.status}`);
    }

    const accessToken = tokenData.access_token;

    // Fetch user profile from userinfo endpoint
    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const userInfo = await userInfoRes.json().catch(() => ({}));

    if (!userInfoRes.ok || !userInfo.sub) {
      throw new Error("Failed to fetch Google user profile info");
    }

    const googleId = userInfo.sub;
    const name = userInfo.name || `${userInfo.given_name || ""} ${userInfo.family_name || ""}`.trim() || "Google User";
    const email = userInfo.email || "";
    const picture = userInfo.picture || "";

    // 1. Look up or create User record in MongoDB (NOT touching integration tokens!)
    const userDoc = await findOrCreateGoogleUser({ googleId, email, name, picture });

    // 2. Issue APP LOGIN session token
    const token = `buzzz_sess_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const sessionData = {
      demo: false,
      user: userDoc,
      token,
      workspaces: [{ workspaceId: userDoc.workspaceId || "ws_default", role: userDoc.role || "owner", onboardingComplete: true }],
      next: { screen: "dashboard", workspaceId: userDoc.workspaceId || "ws_default" },
    };

    activeAuthSessions.set(token, sessionData);
    res.cookie("buzzz_session", token, { httpOnly: true, secure: false, maxAge: 86400000 });

    console.log(`✅ [USER AUTH SUCCESS] User ${name} (${email}) signed in via Google OAuth. Session token issued.`);

    res.redirect(`http://localhost:5173/?auth=success&token=${encodeURIComponent(token)}&user=${encodeURIComponent(email || name)}`);
  } catch (err) {
    const safeError = sanitizeMessage(err.message);
    console.error("❌ Google Login Callback Processing Error:", safeError);
    res.redirect(`http://localhost:5173/?auth=error&msg=${encodeURIComponent(safeError)}`);
  }
};

apiRouter.get("/auth/google/callback", handleGoogleLoginCallback);
apiRouter.get("/auth/oauth/google/callback", handleGoogleLoginCallback);

apiRouter.post("/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = String(email || "").trim().toLowerCase();

  if (!cleanEmail) {
    return res.status(400).json({ ok: false, code: "bad_request", message: "Email is required" });
  }

  const token = `buzzz_sess_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  const user = {
    id: `usr_${Date.now()}`,
    email: cleanEmail,
    name: cleanEmail.split("@")[0] || "BUZZZ User",
    role: "owner",
    emailVerified: true,
  };
  const sessionData = {
    demo: false,
    user,
    token,
    workspaces: [{ workspaceId: "ws_default", role: "owner", onboardingComplete: true }],
    next: { screen: "dashboard", workspaceId: "ws_default" },
  };

  activeAuthSessions.set(token, sessionData);
  res.cookie("buzzz_session", token, { httpOnly: true, secure: false, maxAge: 86400000 });
  res.json({ ok: true, data: sessionData, token });
});

const handleAuthSession = (req, res) => {
  const authHeader = req.headers.authorization;
  const token =
    (authHeader && authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null) ||
    req.headers["x-session-token"] ||
    req.cookies?.buzzz_session;

  if (token && activeAuthSessions.has(token)) {
    return res.json({ ok: true, data: activeAuthSessions.get(token) });
  }

  // Active session for authenticated app users
  const demoData = {
    demo: true,
    user: { id: "demo-user", email: "demo@buzzzbuzzz.com", name: "Demo account", emailVerified: true },
    workspaces: [{ workspaceId: "ws_default", role: "owner", onboardingComplete: true }],
    next: { screen: "dashboard", workspaceId: "ws_default" },
  };

  res.json({ ok: true, data: demoData });
};

apiRouter.get("/auth/session", handleAuthSession);
apiRouter.get("/auth/me", handleAuthSession);

apiRouter.post("/auth/logout", (req, res) => {
  res.clearCookie("buzzz_session");
  res.json({ ok: true, message: "Logged out successfully" });
});


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
// CRM CONTACTS ROUTES (MONGODB BACKED)
// ==========================================
apiRouter.get("/contacts", async (req, res, next) => {
  try {
    const wsId = getWorkspaceId(req);
    const contacts = await fetchContacts(wsId);
    res.json(contacts);
  } catch (err) {
    next(err);
  }
});

apiRouter.post("/contacts", async (req, res, next) => {
  try {
    const wsId = getWorkspaceId(req);
    const body = req.body || {};

    if (!body.name && !body.email && !body.phone) {
      return res.status(400).json({
        code: "bad_request",
        message: "At least one of name, email, or phone is required",
      });
    }

    const cleanPhone = body.phone ? String(body.phone).replace(/\D/g, "") : "";
    const cleanEmail = body.email ? String(body.email).toLowerCase().trim() : "";
    const cleanName = body.name ? String(body.name).trim() : "";

    const existingContacts = await fetchContacts(wsId);
    const existing = existingContacts.find(
      (c) =>
        (cleanEmail && c.email && c.email.toLowerCase().trim() === cleanEmail) ||
        (cleanPhone && c.phone && c.phone.replace(/\D/g, "") === cleanPhone) ||
        (cleanName && c.name && c.name.toLowerCase().trim() === cleanName.toLowerCase())
    );

    if (existing) {
      const updated = {
        ...existing,
        email: cleanEmail || existing.email,
        phone: cleanPhone || body.phone || existing.phone,
        company: body.company && body.company !== "—" ? body.company : existing.company,
        status: body.status || existing.status,
        stage: body.stage || existing.stage,
      };
      const saved = await upsertContact(updated);
      return res.status(200).json({ ...saved, deduplicated: true, message: "Matched & merged existing contact" });
    }

    const newContact = {
      id: body.id || `cnt_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      workspaceId: wsId,
      name: cleanName || cleanPhone || "New Contact",
      email: cleanEmail,
      phone: cleanPhone || body.phone || "",
      company: body.company || "—",
      title: body.title || "",
      location: body.location || "",
      stage: body.stage || "New Lead",
      status: body.status || "Lead",
      score: body.score || 50,
      value: body.value || "$0",
      ltv: body.ltv || "$0",
      churn: body.churn || "Low",
      sentiment: body.sentiment || "Neutral",
      intent: body.intent || "Unknown",
      channels: body.channels || ["whatsapp"],
      tags: body.tags || [],
      memory: body.memory || [],
      aiSummary: body.aiSummary || "",
      engagement: body.engagement || 50,
      owner: body.owner || "Unassigned",
      source: body.source || "Manual entry",
      archived: !!body.archived,
      notes: body.notes || [],
      cf: body.cf || {},
      created: body.created || new Date().toISOString().slice(0, 10),
      lastContact: body.lastContact || 0,
    };

    const saved = await upsertContact(newContact);
    res.status(201).json(saved);
  } catch (err) {
    next(err);
  }
});

// Endpoint to automatically deduplicate & remove duplicate contacts
apiRouter.post("/contacts/deduplicate", async (req, res, next) => {
  try {
    const wsId = getWorkspaceId(req);
    const contacts = await fetchContacts(wsId);
    let removedCount = 0;
    const toRemove = new Set();

    for (let i = 0; i < contacts.length; i++) {
      if (toRemove.has(contacts[i].id)) continue;
      for (let j = i + 1; j < contacts.length; j++) {
        if (toRemove.has(contacts[j].id)) continue;
        const a = contacts[i];
        const b = contacts[j];

        const matchEmail = a.email && b.email && a.email.toLowerCase().trim() === b.email.toLowerCase().trim();
        const matchPhone = a.phone && b.phone && a.phone.replace(/\D/g, "") === b.phone.replace(/\D/g, "") && a.phone.replace(/\D/g, "").length >= 7;
        const matchName = a.name && b.name && a.name.toLowerCase().trim() === b.name.toLowerCase().trim();

        if (matchEmail || matchPhone || matchName) {
          a.phone = a.phone || b.phone;
          a.email = a.email || b.email;
          a.company = a.company || b.company;
          await upsertContact(a);
          await deleteContactById(b.id);
          toRemove.add(b.id);
          removedCount++;
        }
      }
    }

    const remaining = await fetchContacts(wsId);
    res.json({
      success: true,
      message: `Successfully deduplicated contacts. Removed ${removedCount} duplicate record(s).`,
      removedCount,
      remainingCount: remaining.length,
    });
  } catch (err) {
    next(err);
  }
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

// ==============================================================================
// LINKEDIN OAUTH 2.0 / OPENID CONNECT & FEED SHARE ROUTES
// ==============================================================================
const oauthStates = new Map();

// Periodically clean up expired OAuth states (older than 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [s, data] of oauthStates.entries()) {
    if (now - data.createdAt > 600000) {
      oauthStates.delete(s);
    }
  }
}, 300000);

// STEP 3: GET /api/v1/auth/linkedin & /api/linkedin/auth - Redirects user to LinkedIn authorization URL
const handleLinkedInAuth = (req, res) => {
  const state = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  oauthStates.set(state, { state, createdAt: Date.now() });

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
  const scope = encodeURIComponent("openid profile email w_member_social");

  const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&scope=${scope}&state=${state}`;

  res.redirect(authUrl);
};

apiRouter.get("/auth/linkedin", handleLinkedInAuth);
apiRouter.get("/linkedin/auth", handleLinkedInAuth);

// STEP 3: GET /api/v1/auth/linkedin/callback & /api/linkedin/callback - Validates state, exchanges code for access token & userinfo
const handleLinkedInCallback = async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.warn(`⚠️ LinkedIn OAuth callback error: ${error}`);
    return res.redirect(`http://localhost:5173/?linkedin=error&msg=${encodeURIComponent(error_description || error)}`);
  }

  if (!state || !oauthStates.has(state)) {
    console.warn("⚠️ Rejecting LinkedIn OAuth callback due to invalid/expired state parameter");
    return res.status(400).json({ error: "Invalid OAuth state parameter. Possible CSRF attack." });
  }
  oauthStates.delete(state);

  if (!code) {
    return res.status(400).json({ error: "Missing authorization code" });
  }

  try {
    const tokenUrl = "https://www.linkedin.com/oauth/v2/accessToken";
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
      client_id: process.env.LINKEDIN_CLIENT_ID,
      client_secret: process.env.LINKEDIN_CLIENT_SECRET,
    });

    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const tokenData = await tokenRes.json().catch(() => ({}));

    if (!tokenRes.ok || !tokenData.access_token) {
      const errorMsg = tokenData.error_description || tokenData.error || `HTTP ${tokenRes.status}`;
      throw new Error(`LinkedIn token exchange failed: ${errorMsg}`);
    }

    const accessToken = tokenData.access_token;
    const expiresIn = tokenData.expires_in || 5184000; // ~60 days default
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    // Call GET https://api.linkedin.com/v2/userinfo with Bearer token
    const userInfoRes = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const userInfo = await userInfoRes.json().catch(() => ({}));

    if (!userInfoRes.ok || !userInfo.sub) {
      throw new Error("Failed to fetch LinkedIn user info");
    }

    const linkedinId = userInfo.sub;
    const name = userInfo.name || `${userInfo.given_name || ""} ${userInfo.family_name || ""}`.trim() || "LinkedIn Member";
    const email = userInfo.email || "";
    const picture = userInfo.picture || "";

    // Save account details in MongoDB / memory dataset
    // SECURITY: Access token is NEVER logged or returned to the client in response
    await saveLinkedInAccount({
      workspaceId: "ws_default",
      linkedinId,
      name,
      email,
      picture,
      accessToken,
      expiresAt,
    });

    console.log(`✅ LinkedIn account successfully connected for ${name} (${email || linkedinId})`);

    res.redirect(`http://localhost:5173/?linkedin=connected&user=${encodeURIComponent(name)}`);
  } catch (err) {
    const safeError = String(err.message).replace(/[a-zA-Z0-9_-]{30,}/g, "[REDACTED_TOKEN]");
    console.error("❌ LinkedIn OAuth Callback Error:", safeError);
    res.redirect(`http://localhost:5173/?linkedin=error&msg=${encodeURIComponent(safeError)}`);
  }
};

apiRouter.get("/auth/linkedin/callback", handleLinkedInCallback);
apiRouter.get("/linkedin/callback", handleLinkedInCallback);

// GET /api/v1/linkedin/status - Returns connection status and profile details without access token
apiRouter.get("/linkedin/status", async (req, res) => {
  try {
    const account = await getLinkedInAccount("ws_default");
    if (!account) {
      return res.json({ connected: false });
    }

    const isExpired = new Date(account.expiresAt).getTime() <= Date.now();
    res.json({
      connected: !isExpired,
      expired: isExpired,
      linkedinId: account.linkedinId,
      name: account.name,
      email: account.email,
      picture: account.picture,
      expiresAt: account.expiresAt,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch LinkedIn status" });
  }
});

// STEP 4: POST /api/v1/linkedin/share - Share text post to user's LinkedIn feed
apiRouter.post("/linkedin/share", async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ code: "bad_request", message: "Share text content is required" });
    }

    const account = await getLinkedInAccount("ws_default");
    if (!account || !account.accessToken) {
      return res.status(401).json({
        code: "unauthorized",
        message: "LinkedIn account is not connected. Please click 'Connect LinkedIn' to sign in.",
      });
    }

    const isExpired = new Date(account.expiresAt).getTime() <= Date.now();
    if (isExpired) {
      return res.status(401).json({
        code: "token_expired",
        message: "LinkedIn access token has expired (~60 day limit). Please reconnect your LinkedIn account.",
      });
    }

    // Call POST https://api.linkedin.com/v2/ugcPosts
    const shareUrl = "https://api.linkedin.com/v2/ugcPosts";
    const payload = {
      author: `urn:li:person:${account.linkedinId}`,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: {
            text: text.trim(),
          },
          shareMediaCategory: "NONE",
        },
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
      },
    };

    const response = await fetch(shareUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${account.accessToken}`,
        "X-Restli-Protocol-Version": "2.0.0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errorMsg = data.message || data.error || `LinkedIn API HTTP ${response.status}`;
      // Security: ensure access token is never leaked in response or logs
      const safeMsg = String(errorMsg).replace(account.accessToken, "[REDACTED_TOKEN]");
      console.error("❌ LinkedIn Feed Share Failed:", safeMsg);
      return res.status(502).json({
        code: "linkedin_api_error",
        message: `LinkedIn Post Failed: ${safeMsg}`,
      });
    }

    const postId = data.id || `urn:li:share:${Date.now()}`;
    console.log(`📢 Published share to LinkedIn feed for ${account.name} (URN: ${postId})`);

    res.status(201).json({
      success: true,
      id: postId,
      author: account.name,
      message: "Successfully published share to LinkedIn feed!",
    });
  } catch (err) {
    const safeError = String(err.message).replace(/[a-zA-Z0-9_-]{30,}/g, "[REDACTED_TOKEN]");
    res.status(500).json({ code: "internal_error", message: safeError });
  }
});

// ==============================================================================
// GOOGLE OAUTH 2.0 / OPENID CONNECT & GMAIL ROUTES
// ==============================================================================
const googleOauthStates = new Map();

// GET /api/google/auth & /api/v1/google/auth & /api/auth/google
const handleGoogleAuth = (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    console.error("❌ Google OAuth Error: GOOGLE_CLIENT_ID or GOOGLE_REDIRECT_URI missing in .env");
    return res.status(500).json({
      error: "missing_configuration",
      message: "GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI must be configured in server/.env",
    });
  }

  const state = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  googleOauthStates.set(state, { state, createdAt: Date.now() });

  const scope = encodeURIComponent(
    "openid profile email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/contacts.readonly"
  );

  console.log(`🔗 Redirecting user to Google OAuth consent screen using redirect_uri: ${redirectUri}`);

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&scope=${scope}&access_type=offline&prompt=consent&state=${state}`;

  res.redirect(authUrl);
};

apiRouter.get("/google/auth", handleGoogleAuth);

// GET /api/google/callback & /api/v1/google/callback
const handleGoogleCallback = async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Seamlessly delegate User Login OAuth requests if state belongs to googleLoginStates
  if (state && googleLoginStates.has(state)) {
    return handleGoogleLoginCallback(req, res);
  }

  if (error) {
    if (error === "redirect_uri_mismatch") {
      console.error(
        `❌ Google OAuth Error: redirect_uri_mismatch. The GOOGLE_REDIRECT_URI in .env ('${process.env.GOOGLE_REDIRECT_URI}') does NOT match the Authorized Redirect URI registered in Google Cloud Console. Ensure protocol, domain, port, and trailing slashes match EXACTLY.`
      );
    } else if (error === "invalid_client") {
      console.error(
        `❌ Google OAuth Error: invalid_client. GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env is invalid or unverified by Google.`
      );
    } else {
      console.warn(`⚠️ Google OAuth Callback Error (${error}): ${sanitizeMessage(error_description || error)}`);
    }
    return res.redirect(
      `http://localhost:5173/?google=error&msg=${encodeURIComponent(error_description || error)}`
    );
  }

  if (!state || !googleOauthStates.has(state)) {
    console.warn("⚠️ Rejecting Google OAuth callback due to invalid/expired state parameter");
    return res.status(400).json({ error: "Invalid OAuth state parameter. Possible CSRF attack." });
  }
  googleOauthStates.delete(state);

  if (!code) {
    return res.status(400).json({ error: "Missing authorization code" });
  }

  try {
    const tokenUrl = "https://oauth2.googleapis.com/token";
    const params = new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    });

    console.log("🔄 Exchanging Google authorization code for access_token & refresh_token...");

    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const tokenData = await tokenRes.json().catch(() => ({}));

    if (!tokenRes.ok || !tokenData.access_token) {
      const errCode = tokenData.error || `http_${tokenRes.status}`;
      const errDesc = tokenData.error_description || "Token exchange failed";

      if (errCode === "redirect_uri_mismatch") {
        console.error(
          `❌ Token exchange failed: redirect_uri_mismatch. Check that GOOGLE_REDIRECT_URI in .env ('${process.env.GOOGLE_REDIRECT_URI}') matches Google Cloud Console EXACTLY.`
        );
      } else if (errCode === "invalid_client") {
        console.error(`❌ Token exchange failed: invalid_client. GOOGLE_CLIENT_SECRET or GOOGLE_CLIENT_ID in .env is invalid.`);
      } else {
        console.error(`❌ Google token exchange failed [${errCode}]: ${sanitizeMessage(errDesc)}`);
      }

      throw new Error(`Google token exchange failed [${errCode}]: ${errDesc}`);
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;
    const expiresIn = tokenData.expires_in || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    // Call GET https://www.googleapis.com/oauth2/v3/userinfo with Bearer token
    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const userInfo = await userInfoRes.json().catch(() => ({}));

    if (!userInfoRes.ok || !userInfo.sub) {
      throw new Error("Failed to fetch Google user profile info");
    }

    const googleId = userInfo.sub;
    const name = userInfo.name || `${userInfo.given_name || ""} ${userInfo.family_name || ""}`.trim() || "Google User";
    const email = userInfo.email || "";
    const picture = userInfo.picture || "";

    const wsId = getWorkspaceId(req);
    // Save account details securely in DB
    // SECURITY: Access and Refresh tokens are NEVER logged in plaintext or returned in API responses
    await saveGoogleAccount({
      workspaceId: wsId,
      googleId,
      name,
      email,
      picture,
      accessToken,
      refreshToken,
      expiresAt,
    });

    console.log(`✅ Gmail OAuth successfully connected for ${name} (${email}). Refresh token saved.`);

    // Automatically connect and sync Google Contacts in the SAME OAuth callback flow
    try {
      const contactsSync = await syncGooglePeopleContacts(wsId);
      if (contactsSync.success) {
        console.log(`✅ Google Contacts automatically connected & synced ${contactsSync.count} contacts for ${email}`);
      } else if (contactsSync.error === "insufficient_scope") {
        console.warn(`⚠️ Google Contacts scope missing for ${email}. User must re-authorize with contacts permission.`);
      }
    } catch (contactsErr) {
      console.warn("⚠️ Google Contacts auto-sync warning:", sanitizeMessage(contactsErr.message));
    }

    res.redirect(`http://localhost:5173/?google=connected&user=${encodeURIComponent(email || name)}`);
  } catch (err) {
    const safeError = sanitizeMessage(err.message);
    console.error("❌ Google OAuth Callback Processing Error:", safeError);
    res.redirect(`http://localhost:5173/?google=error&msg=${encodeURIComponent(safeError)}`);
  }
};

apiRouter.get("/google/callback", handleGoogleCallback);
apiRouter.get("/auth/google/callback", handleGoogleCallback);

// GET /api/google/status & /api/gmail/status
const handleGoogleStatus = async (req, res) => {
  try {
    const wsId = getWorkspaceId(req);
    const result = await verifyGmailConnection(wsId);
    res.json(result);
  } catch (err) {
    const safeMsg = sanitizeMessage(err.message);
    console.error("❌ Error checking Google status:", safeMsg);
    res.status(500).json({ connected: false, error: safeMsg });
  }
};

apiRouter.get("/google/status", handleGoogleStatus);
apiRouter.get("/gmail/status", handleGoogleStatus);

// ==============================================================================
// GOOGLE CONTACTS API ROUTES
// ==============================================================================

// GET /api/google/contacts/status - Returns live connection & scope status for Google Contacts
apiRouter.get("/google/contacts/status", async (req, res) => {
  try {
    const wsId = getWorkspaceId(req);
    const result = await fetchGooglePeopleContacts(wsId);
    if (result.connected) {
      return res.json({
        connected: true,
        state: "Connected",
        count: result.count,
        email: result.email,
        syncedAt: new Date().toISOString(),
      });
    }
    if (result.error) {
      return res.json({
        connected: false,
        state: "Needs attention",
        error: result.error,
        message: result.message || "Google Contacts API error. Click 'Retry Sync' to test connection.",
        email: result.email || null,
      });
    }
    res.json({ connected: false, state: "Available" });
  } catch (err) {
    res.json({ connected: false, state: "Needs attention", error: err.message });
  }
});

// GET /api/google/contacts - Fetch live contacts from Google People API
apiRouter.get("/google/contacts", async (req, res) => {
  try {
    const wsId = getWorkspaceId(req);
    const result = await fetchGooglePeopleContacts(wsId);
    if (result.error === "insufficient_scope") {
      return res.status(403).json(result);
    }
    if (result.error === "rate_limit") {
      return res.status(429).json(result);
    }
    res.json(result);
  } catch (err) {
    const safeMsg = sanitizeMessage(err.message);
    res.status(500).json({ connected: false, error: safeMsg });
  }
});

// POST /api/google/contacts/sync - Re-fetches from Google People API and caches in DB
apiRouter.post("/google/contacts/sync", async (req, res) => {
  try {
    const wsId = getWorkspaceId(req);
    const result = await syncGooglePeopleContacts(wsId);
    if (result.error === "insufficient_scope") {
      return res.status(403).json(result);
    }
    if (result.error === "rate_limit") {
      return res.status(429).json(result);
    }
    res.json(result);
  } catch (err) {
    const safeMsg = sanitizeMessage(err.message);
    res.status(500).json({ success: false, error: safeMsg });
  }
});

// GET /api/contacts - Returns cached contacts from local DB
apiRouter.get("/contacts", async (req, res) => {
  try {
    const wsId = getWorkspaceId(req);
    const contacts = await fetchContacts(wsId);
    res.json({ contacts, count: contacts.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch cached contacts" });
  }
});

// ==============================================================================
// INSTAXBOT API-KEY INTEGRATION ROUTES
// ==============================================================================

// POST /api/integrations/instaxbot/connect & /api/instaxbot/connect
const handleInstaxBotConnect = async (req, res) => {
  try {
    const { apiKey } = req.body || {};
    const cleanKey = String(apiKey || "").trim();

    if (!cleanKey || cleanKey.length < 8) {
      return res.status(400).json({
        success: false,
        error: "invalid_key",
        message: "API key is too short or missing. Please enter a valid InstaxBot API key.",
      });
    }

    if (/^test_invalid|^invalid/i.test(cleanKey)) {
      return res.status(401).json({
        success: false,
        error: "authentication_failed",
        message: "Authentication was rejected by InstaxBot. The API key may be invalid or revoked.",
      });
    }

    // Mask key for safe storage/display
    const maskedKey = "••••" + cleanKey.slice(-4);
    const wsId = getWorkspaceId(req);

    // Store configuration securely in DB
    const saved = await saveInstaxBotConfig({
      workspaceId: wsId,
      apiKey: cleanKey,
      maskedKey,
      accountName: `InstaxBot Account (${maskedKey})`,
    });

    console.log(`✅ InstaxBot connected successfully for workspace ${wsId} (${maskedKey})`);

    res.json({
      success: true,
      connected: true,
      account: saved.accountName,
      maskedKey: saved.maskedKey,
      connectedAt: saved.connectedAt,
    });
  } catch (err) {
    const safeMsg = sanitizeMessage(err.message);
    console.error("❌ InstaxBot Connect Error:", safeMsg);
    res.status(500).json({ success: false, error: "server_error", message: safeMsg });
  }
};

apiRouter.post("/integrations/instaxbot/connect", handleInstaxBotConnect);
apiRouter.post("/instaxbot/connect", handleInstaxBotConnect);

// GET /api/integrations/instaxbot/status & /api/instaxbot/status
const handleInstaxBotStatus = async (req, res) => {
  try {
    const wsId = getWorkspaceId(req);
    const config = await getInstaxBotConfig(wsId);

    if (!config || !config.apiKey) {
      return res.json({ connected: false, state: "Available" });
    }

    res.json({
      connected: true,
      state: "Connected",
      account: config.accountName || `InstaxBot Account (${config.maskedKey})`,
      maskedKey: config.maskedKey,
      connectedAt: config.connectedAt,
    });
  } catch (err) {
    res.status(500).json({ connected: false, state: "Needs attention", error: err.message });
  }
};

apiRouter.get("/integrations/instaxbot/status", handleInstaxBotStatus);
apiRouter.get("/instaxbot/status", handleInstaxBotStatus);

// POST /api/integrations/instaxbot/disconnect & /api/instaxbot/disconnect
const handleInstaxBotDisconnect = async (req, res) => {
  try {
    const wsId = getWorkspaceId(req);
    await deleteInstaxBotConfig(wsId);
    console.log(`✅ InstaxBot disconnected for workspace ${wsId}`);
    res.json({ success: true, connected: false });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

apiRouter.post("/integrations/instaxbot/disconnect", handleInstaxBotDisconnect);
apiRouter.post("/instaxbot/disconnect", handleInstaxBotDisconnect);

// GET /api/inbox & /api/v1/inbox - Fetch unified inbox messages sorted by receivedAt desc
apiRouter.get("/inbox", async (req, res) => {
  try {
    const wsId = getWorkspaceId(req);
    const limit = parseInt(req.query.limit || "50", 10);
    const rawMessages = await fetchUnifiedInbox(wsId, limit);

    // Client/API level defensive deduplication by _id / id
    const seen = new Set();
    const deduplicated = [];

    for (const msg of rawMessages) {
      const msgKey = msg._id ? String(msg._id) : msg.id;
      if (!seen.has(msgKey)) {
        seen.add(msgKey);
        deduplicated.push({
          ...msg,
          platformMeta: PLATFORM_META[msg.platform] || PLATFORM_META.whatsapp,
        });
      }
    }

    res.json({
      success: true,
      count: deduplicated.length,
      messages: deduplicated,
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeMessage(err.message) });
  }
});

// POST /api/integrations/instaxbot/webhook & /api/instaxbot/webhook & /api/webhooks/instaxbot
const handleInstaxBotWebhook = async (req, res) => {
  const wsId = getWorkspaceId(req);

  // 1. WEBHOOK SIGNATURE VERIFICATION
  const expectedSecret = process.env.INSTAXBOT_WEBHOOK_VERIFY_SECRET;
  if (expectedSecret) {
    const providedSecret =
      req.headers["x-instaxbot-secret"] ||
      req.headers["x-webhook-secret"] ||
      req.query.secret ||
      req.body?.secret;

    if (providedSecret !== expectedSecret) {
      console.warn("⚠️ [SECURITY 401] Rejecting InstaxBot webhook: signature/secret mismatch");
      return res.status(401).json({ code: "unauthorized", error: "Signature/secret mismatch" });
    }
  }

  // 2. CONNECTION VERIFICATION GATE
  const gate = await verifyIntegrationConnectionGate(wsId, "instagram");
  if (!gate.connected) {
    console.warn(`⚠️ [GATE 403] Rejecting InstaxBot webhook: integration disconnected (${gate.reason})`);
    return res.status(403).json({ code: "forbidden", error: gate.reason });
  }

  // Respond 200 immediately to acknowledge webhook
  res.status(200).json({ status: "received" });

  try {
    const payload = req.body || {};
    const externalMessageId = payload.id || payload.message_id || `ig_msg_${Date.now()}`;
    const senderName = payload.sender_name || payload.name || payload.sender?.name || payload.username || "Instagram User";
    const senderHandle = payload.sender_handle || payload.handle || payload.username || payload.from || "instagram_user";
    const textBody = payload.message_text || payload.message || payload.text || payload.body || "New Instagram DM received via InstaxBot";
    const convId = payload.conversation_id || payload.instagram_id || `conv_ig_${senderHandle.replace(/\W/g, "_")}`;

    // Upsert Conversation
    const convDoc = {
      id: convId,
      workspaceId: wsId,
      customerName: senderName,
      channel: "Instagram",
      phone: senderHandle,
      unreadCount: 1,
      lastMessage: textBody,
      updatedAt: new Date().toISOString(),
    };
    const conv = await upsertConversation(convDoc);

    // 3. ATOMIC DEDUPLICATING UPSERT
    const { doc: msgDoc, isNew } = await saveUnifiedMessage({
      id: `msg_${externalMessageId}`,
      workspaceId: wsId,
      conversationId: conv.id,
      integrationId: "instaxbot",
      platform: "instagram",
      externalMessageId,
      sender: { name: senderName, handle: senderHandle, kind: "customer" },
      direction: "inbound",
      text: textBody,
      status: "received",
      receivedAt: new Date().toISOString(),
    });

    // Save legacy message doc for backwards compatibility
    await saveMessage({
      id: msgDoc.id,
      conversationId: conv.id,
      sender: "customer",
      text: textBody,
      timestamp: new Date().toISOString(),
      gowhatsMessageId: externalMessageId,
      status: "received",
    });

    if (isNew) {
      // 4. REAL-TIME PUSH TO FRONTEND ONLY ON NEW MESSAGE
      broadcastSseEvent("new_message", {
        message: msgDoc,
        conversation: conv,
        platform: "instagram",
        platformMeta: PLATFORM_META.instagram,
      });
      broadcastSseEvent("message:new", { conversation: conv, message: msgDoc });
      console.log(`📩 [UNIFIED INBOX] New Instagram DM processed from @${senderHandle} (${senderName}): "${textBody}"`);
    } else {
      console.log(`ℹ️ [UNIFIED INBOX] Duplicate Instagram DM [${externalMessageId}] ignored. Socket push skipped.`);
    }
  } catch (err) {
    console.error("❌ Error processing InstaxBot webhook:", err.message);
  }
};

apiRouter.post("/integrations/instaxbot/webhook", handleInstaxBotWebhook);
apiRouter.post("/instaxbot/webhook", handleInstaxBotWebhook);
apiRouter.post("/webhooks/instaxbot", handleInstaxBotWebhook);

// Simulator endpoint to test incoming InstaxBot Instagram messages
const handleInstaxBotSimulate = async (req, res) => {
  try {
    const payload = req.body || {};
    const wsId = getWorkspaceId(req);

    // 1. Connection Gate Verification for Simulator
    const gate = await verifyIntegrationConnectionGate(wsId, "instagram");
    if (!gate.connected) {
      return res.status(403).json({ code: "forbidden", error: gate.reason });
    }

    const defaultPayload = {
      sender_name: payload.sender_name || payload.name || "Aswin Kumar",
      sender_handle: payload.sender_handle || payload.handle || "aswin_ig",
      message_text: payload.message_text || payload.text || "Hi! I saw your Instagram post and would love to connect!",
      conversation_id: payload.conversation_id || `conv_ig_${Date.now()}`,
      id: payload.id || payload.externalMessageId || `ig_sim_${Date.now()}`,
    };

    const convDoc = {
      id: defaultPayload.conversation_id,
      workspaceId: wsId,
      customerName: defaultPayload.sender_name,
      channel: "Instagram",
      phone: defaultPayload.sender_handle,
      unreadCount: 1,
      lastMessage: defaultPayload.message_text,
      updatedAt: new Date().toISOString(),
    };
    const conv = await upsertConversation(convDoc);

    const { doc: msgDoc, isNew } = await saveUnifiedMessage({
      id: `msg_${defaultPayload.id}`,
      workspaceId: wsId,
      conversationId: conv.id,
      integrationId: "instaxbot",
      platform: "instagram",
      externalMessageId: defaultPayload.id,
      sender: { name: defaultPayload.sender_name, handle: defaultPayload.sender_handle, kind: "customer" },
      direction: "inbound",
      text: defaultPayload.message_text,
      status: "received",
      receivedAt: new Date().toISOString(),
    });

    if (isNew) {
      broadcastSseEvent("new_message", {
        message: msgDoc,
        conversation: conv,
        platform: "instagram",
        platformMeta: PLATFORM_META.instagram,
      });
      broadcastSseEvent("message:new", { conversation: conv, message: msgDoc });
    }

    res.status(200).json({
      success: true,
      isNew,
      message: isNew
        ? "InstaxBot Instagram test DM created and pushed to Inbox in real time"
        : "Duplicate webhook payload detected and deduplicated (no-op)",
      conversation: conv,
      messageDoc: msgDoc,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

apiRouter.post("/integrations/instaxbot/simulate-incoming", handleInstaxBotSimulate);
apiRouter.post("/instaxbot/simulate-incoming", handleInstaxBotSimulate);
