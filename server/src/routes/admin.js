import { Router } from "express";
import mongoose from "mongoose";
import os from "os";
import {
  ConversationModel,
  ContactModel,
  UnifiedMessageModel,
  MessageModel,
  OrderModel,
  DealModel,
  MissedCallModel,
  UserModel,
  getDbStatus,
  createApiKeyRecord,
  fetchApiKeys,
  deleteApiKeyRecord,
  toggleApiKeyRecord,
  validateApiKey,
} from "../data/db.js";

import {
  getGoWhatsConfigStatus,
  verifyGoWhatsConnection,
  isRateLimited,
  rateLimitedUntil,
  syncGoWhatsMessages,
  syncGoWhatsContacts,
  fetchGoWhatsMessages,
  fetchGoWhatsOrders,
} from "../services/gowhats.js";

import {
  getChannelBotInConfigStatus,
  verifyChannelBotInConnection,
  fetchYouTubeComments,
} from "../services/channelbot.js";

import {
  fetchInstaxBotMessages,
  runInstaxBotHistoricalBackfill,
  syncInstaxBotContacts,
} from "../services/instaxbot.js";

import {
  verifyGmailConnection,
  getValidGoogleAccount,
  syncGmailMessages,
} from "../services/gmailAuth.js";

export const adminRouter = Router();

/**
 * POST /api/v1/admin/login
 * Staff authentication for the internal admin console
 */
adminRouter.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  const who = (email || "").trim().toLowerCase();

  if (
    (who === "owner@buzzzbuzzz.com" || who === "admin@buzzz.com" || who === "owner@buzzz.com") &&
    (password === "buzzz-owner-2026" || password === "admin123" || password === "buzzz-demo-2026")
  ) {
    return res.json({
      ok: true,
      success: true,
      data: {
        staff: {
          id: "staff-owner",
          email: who,
          name: "Owner / SuperAdmin",
          role: "superadmin",
        },
        token: `admin_tok_${Date.now()}`,
      },
    });
  }

  if (who === "ops@buzzzbuzzz.com" && (password === "buzzz-ops-2026" || password === "buzzz-demo-2026")) {
    return res.json({
      ok: true,
      success: true,
      data: {
        staff: {
          id: "staff-demo",
          email: who,
          name: "Demo Operator",
          role: "ops",
        },
        token: `admin_tok_${Date.now()}`,
      },
    });
  }

  return res.status(401).json({
    ok: false,
    success: false,
    message: "Invalid admin credentials. Use owner@buzzzbuzzz.com / buzzz-owner-2026",
  });
});

// In-memory audit log for admin operations
const adminAuditLogs = [
  {
    id: "log_init",
    action: "System Initialized",
    actor: "system",
    detail: "BUZZZ Server and Database ready",
    timestamp: new Date().toISOString(),
    severity: "info",
  },
];

const logAdminAction = (action, actor = "admin", detail = "", severity = "info") => {
  adminAuditLogs.unshift({
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    action,
    actor,
    detail,
    timestamp: new Date().toISOString(),
    severity,
  });
  if (adminAuditLogs.length > 200) adminAuditLogs.pop();
};

/**
 * 1. GET /api/v1/admin/overview
 * Executive metrics and real-time counts across the platform
 */
adminRouter.get("/overview", async (req, res) => {
  try {
    const isConnected = mongoose.connection.readyState === 1;

    let totalContacts = 0;
    let totalConversations = 0;
    let totalUnifiedMsgs = 0;
    let totalOrders = 0;
    let totalDeals = 0;
    let totalCalls = 0;
    let channelBreakdown = {
      whatsapp: 0,
      instagram: 0,
      channelbot: 0,
      gmail: 0,
    };

    if (isConnected) {
      const [cCount, convCount, msgCount, ordCount, dealCount, callCount] = await Promise.all([
        ContactModel.countDocuments().catch(() => 0),
        ConversationModel.countDocuments().catch(() => 0),
        UnifiedMessageModel.countDocuments().catch(() => 0),
        OrderModel.countDocuments().catch(() => 0),
        DealModel.countDocuments().catch(() => 0),
        MissedCallModel.countDocuments().catch(() => 0),
      ]);

      totalContacts = cCount;
      totalConversations = convCount;
      totalUnifiedMsgs = msgCount;
      totalOrders = ordCount;
      totalDeals = dealCount;
      totalCalls = callCount;

      const [wa, ig, cb, gm] = await Promise.all([
        UnifiedMessageModel.countDocuments({ platform: "whatsapp" }).catch(() => 0),
        UnifiedMessageModel.countDocuments({ platform: "instagram" }).catch(() => 0),
        UnifiedMessageModel.countDocuments({ platform: "channelbot" }).catch(() => 0),
        UnifiedMessageModel.countDocuments({ platform: "gmail" }).catch(() => 0),
      ]);
      channelBreakdown = { whatsapp: wa, instagram: ig, channelbot: cb, gmail: gm };
    }

    const uptimeSeconds = Math.floor(process.uptime());
    const memUsage = process.memoryUsage();

    res.json({
      success: true,
      ok: true,
      data: {
        stats: {
          totalContacts,
          totalConversations,
          totalUnifiedMessages: totalUnifiedMsgs,
          totalOrders,
          totalDeals,
          totalCalls,
          channelBreakdown,
        },
        ai: {
          activeAgents: 4,
          agents: [
            { id: "a1", name: "Sarah", role: "Sales Agent", status: "online", autonomy: 4 },
            { id: "a2", name: "Kai", role: "Support Agent", status: "online", autonomy: 3 },
            { id: "a3", name: "Ana", role: "Appointment Agent", status: "online", autonomy: 4 },
            { id: "a4", name: "Voz", role: "Voice Agent", status: "online", autonomy: 2 },
          ],
        },
        system: {
          dbStatus: isConnected ? "connected" : "disconnected",
          dbHost: mongoose.connection.host || "mongodb",
          uptimeSeconds,
          nodeVersion: process.version,
          platform: process.platform,
          memoryRssMb: Math.round(memUsage.rss / 1024 / 1024),
          memoryHeapMb: Math.round(memUsage.heapUsed / 1024 / 1024),
          rateLimited: isRateLimited(),
          rateLimitedSecondsRemaining: isRateLimited() ? Math.ceil((rateLimitedUntil - Date.now()) / 1000) : 0,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 2. GET /api/v1/admin/integrations
 * Real-time health and connection statuses for all 4 external gateways
 */
adminRouter.get("/integrations", async (req, res) => {
  try {
    const isConnected = mongoose.connection.readyState === 1;

    // GoWhats WhatsApp
    const gwKey = (process.env.GOWHATS_API_KEY || "").trim();
    const gowhatsHealth = {
      id: "gowhats",
      name: "GoWhats WhatsApp Gateway",
      channel: "WhatsApp",
      configured: Boolean(gwKey),
      apiKeyMasked: gwKey ? "••••" + gwKey.slice(-4) : "Not configured",
      rateLimited: isRateLimited(),
      rateLimitedSeconds: isRateLimited() ? Math.ceil((rateLimitedUntil - Date.now()) / 1000) : 0,
      phone: process.env.WHATSAPP_PHONE_NUMBER || "919047484484",
      status: gwKey ? (isRateLimited() ? "cooldown" : "connected") : "disconnected",
    };

    // InstaxBot Instagram
    const igKey = (process.env.INSTAXBOT_API_KEY || "").trim();
    const instaxbotHealth = {
      id: "instaxbot",
      name: "InstaxBot Instagram Integration",
      channel: "Instagram",
      configured: Boolean(igKey),
      apiKeyMasked: igKey ? "••••" + igKey.slice(-4) : "Not configured",
      handle: process.env.INSTAGRAM_HANDLE || "@techvaseegrah",
      status: igKey ? "connected" : "disconnected",
    };

    // ChannelBot YouTube
    const cbKey = (process.env.CHANNELBOT_IN_API_KEY || process.env.CHANNELBOT_API_KEY || "").trim();
    const channelbotHealth = {
      id: "channelbot",
      name: "ChannelBot.in YouTube Automation",
      channel: "YouTube",
      configured: Boolean(cbKey),
      apiKeyMasked: cbKey ? "••••" + cbKey.slice(-4) : "Not configured",
      channelUrl: "youtube.com/@channelbot",
      status: cbKey ? "connected" : "disconnected",
    };

    // Gmail & Google Workspace
    const gmailAccount = await getValidGoogleAccount().catch(() => null);
    const gmailHealth = {
      id: "gmail",
      name: "Google Workspace & Gmail",
      channel: "Email",
      configured: Boolean(process.env.GOOGLE_CLIENT_ID),
      connected: Boolean(gmailAccount?.tokens?.access_token),
      email: gmailAccount?.account?.email || "techvaseegraha@gmail.com",
      status: gmailAccount?.tokens?.access_token ? "connected" : "pending_auth",
    };

    // MongoDB Platform Database
    const dbHealth = {
      id: "mongodb",
      name: "MongoDB Platform Database",
      channel: "Database",
      configured: Boolean(process.env.MONGODB_URI),
      connected: isConnected,
      host: mongoose.connection.host || "localhost",
      name_: mongoose.connection.name || "buzzz_db",
      status: isConnected ? "connected" : "disconnected",
    };

    res.json({
      success: true,
      integrations: [gowhatsHealth, instaxbotHealth, channelbotHealth, gmailHealth, dbHealth],
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 3. POST /api/v1/admin/integrations/:platform/sync
 * Manually force a live synchronization for a specific gateway
 */
adminRouter.post("/integrations/:platform/sync", async (req, res) => {
  const { platform } = req.params;
  const wsId = req.headers["x-workspace-id"] || "ws_default";

  try {
    let result = {};

    if (platform === "gowhats" || platform === "whatsapp") {
      logAdminAction("Triggered GoWhats WhatsApp Sync", "admin", "Manual sync triggered via Admin Panel");
      const [msgRes, ordersRes] = await Promise.allSettled([
        fetchGoWhatsMessages({ limit: 50 }).catch(() => ({ success: false, messages: [] })),
        fetchGoWhatsOrders().catch(() => ({ success: false, orders: [] })),
      ]);
      result = {
        platform: "gowhats",
        messagesSynced: msgRes.status === "fulfilled" && msgRes.value?.messages ? msgRes.value.messages.length : 0,
        ordersSynced: ordersRes.status === "fulfilled" && ordersRes.value?.orders ? ordersRes.value.orders.length : 0,
      };
    } else if (platform === "instaxbot" || platform === "instagram") {
      logAdminAction("Triggered InstaxBot Instagram Omnichannel Sync", "admin", "Manual sync triggered via Admin Panel");
      const backfillRes = await runInstaxBotHistoricalBackfill({ workspaceId: wsId }).catch(() => ({}));
      const contactRes = await syncInstaxBotContacts({ workspaceId: wsId }).catch(() => ({}));
      result = {
        platform: "instaxbot",
        status: "success",
        messagesSynced: (backfillRes.status?.ordersCount || 0) + (backfillRes.status?.commentsCount || 0) + (backfillRes.status?.chatsCount || 0),
        contactsSynced: contactRes.syncedCount || 0,
      };
    } else if (platform === "channelbot" || platform === "youtube") {
      logAdminAction("Triggered ChannelBot YouTube Sync", "admin", "Manual sync triggered via Admin Panel");
      const cbRes = await fetchYouTubeComments({ workspaceId: wsId }).catch(() => ({}));
      result = {
        platform: "channelbot",
        commentsSynced: cbRes.comments?.length || 0,
      };
    } else if (platform === "gmail" || platform === "email") {
      logAdminAction("Triggered Gmail Sync", "admin", "Manual sync triggered via Admin Panel");
      const gmRes = await syncGmailMessages({ workspaceId: wsId, limit: 50 }).catch(() => ({}));
      result = {
        platform: "gmail",
        messagesSynced: gmRes.syncedCount || 0,
      };
    } else {
      return res.status(400).json({ success: false, error: `Unknown platform: ${platform}` });
    }

    res.json({
      success: true,
      message: `Manual sync completed successfully for ${platform}.`,
      result,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 4. GET /api/v1/admin/users
 * Returns list of platform staff and users with roles
 */
adminRouter.get("/users", async (req, res) => {
  try {
    const isConnected = mongoose.connection.readyState === 1;
    let users = [];

    if (isConnected) {
      users = await UserModel.find().sort({ createdAt: -1 }).lean().catch(() => []);
    }

    // Default staff list for BUZZZ
    const staffList = [
      { id: "usr_owner", name: "Admin Owner", email: "admin@buzzz.com", role: "Owner", status: "Active", lastActive: "Just now" },
      { id: "usr_sarah", name: "Sarah Mitchell", email: "sarah@buzzz.com", role: "Sales Manager", status: "Active", lastActive: "5m ago" },
      { id: "usr_techvaseegrah", name: "Tech Vaseegrah", email: "techvaseegrah@buzzz.com", role: "Support Lead", status: "Active", lastActive: "12m ago" },
      { id: "usr_ana", name: "Ana Gomez", email: "ana@buzzz.com", role: "Appointment Specialist", status: "Active", lastActive: "1h ago" },
    ];

    res.json({
      success: true,
      staff: staffList,
      registeredUsers: users,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 5. POST /api/v1/admin/users
 * Invite or add new team member
 */
adminRouter.post("/users", async (req, res) => {
  const { name, email, role } = req.body || {};
  if (!email || !name) {
    return res.status(400).json({ success: false, error: "Name and email are required" });
  }

  logAdminAction(`Added Team Member: ${name} (${email})`, "admin", `Assigned role: ${role || "Agent"}`);

  res.json({
    success: true,
    message: `Team member ${name} (${email}) created with role '${role || "Agent"}'.`,
    user: {
      id: `usr_${Date.now()}`,
      name,
      email,
      role: role || "Agent",
      status: "Invited",
      lastActive: "Pending confirmation",
    },
  });
});

/**
 * 6. GET /api/v1/admin/audit
 * Returns system audit logs
 */
adminRouter.get("/audit", (req, res) => {
  res.json({
    success: true,
    logs: adminAuditLogs,
  });
});

/**
 * 7. GET /api/v1/admin/health
 * Comprehensive platform health probe
 */
adminRouter.get("/health", (req, res) => {
  const isConnected = mongoose.connection.readyState === 1;
  res.json({
    success: true,
    status: isConnected ? "HEALTHY" : "DEGRADED",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    database: {
      connected: isConnected,
      host: mongoose.connection.host || "localhost",
      name: mongoose.connection.name || "buzzz_db",
    },
    system: {
      nodeVersion: process.version,
      platform: process.platform,
      cpus: os.cpus().length,
      freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
      totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
      processMemoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    rateLimits: {
      gowhats: {
        rateLimited: isRateLimited(),
        secondsRemaining: isRateLimited() ? Math.ceil((rateLimitedUntil - Date.now()) / 1000) : 0,
      },
    },
  });
});

/**
 * 8. GET /api/v1/admin/api-keys
 * List all active and revoked API keys for the workspace
 */
adminRouter.get("/api-keys", async (req, res) => {
  try {
    const wsId = req.headers["x-workspace-id"] || "ws_default";
    const keys = await fetchApiKeys(wsId);
    res.json({ success: true, keys });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 9. POST /api/v1/admin/api-keys
 * Generate a new API key with specific scopes and environment
 */
adminRouter.post("/api-keys", async (req, res) => {
  try {
    const wsId = req.headers["x-workspace-id"] || "ws_default";
    const { name, scopes, env } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: "API key name is required" });
    }

    const { apiKey, rawKey } = await createApiKeyRecord({
      name: name.trim(),
      scopes: Array.isArray(scopes) && scopes.length ? scopes : ["read", "write"],
      env: env === "test" ? "test" : "live",
      workspaceId: wsId,
    });

    logAdminAction(`Generated API Key "${name}"`, "admin", `Scopes: ${(scopes || []).join(", ")}, Env: ${env || "live"}`);

    res.json({
      success: true,
      message: "API key generated successfully. Copy it now, as it will not be shown again!",
      apiKey,
      rawKey,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 10. DELETE /api/v1/admin/api-keys/:id
 * Revoke and delete an API key
 */
adminRouter.delete("/api-keys/:id", async (req, res) => {
  try {
    const wsId = req.headers["x-workspace-id"] || "ws_default";
    const { id } = req.params;
    await deleteApiKeyRecord(id, wsId);
    logAdminAction(`Revoked API Key "${id}"`, "admin", `Workspace: ${wsId}`, "warn");
    res.json({ success: true, message: "API key revoked successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 11. PATCH /api/v1/admin/api-keys/:id/toggle
 * Enable or disable an API key
 */
adminRouter.patch("/api-keys/:id/toggle", async (req, res) => {
  try {
    const wsId = req.headers["x-workspace-id"] || "ws_default";
    const { id } = req.params;
    const { active } = req.body || {};
    const updated = await toggleApiKeyRecord(id, Boolean(active), wsId);
    if (!updated) {
      return res.status(404).json({ success: false, error: "API key not found" });
    }
    logAdminAction(`${active ? "Enabled" : "Disabled"} API Key "${id}"`, "admin", `Status changed to ${active ? "active" : "inactive"}`);
    res.json({ success: true, apiKey: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 12. POST /api/v1/admin/api-keys/validate
 * Authenticate and inspect an API key
 */
adminRouter.post("/api-keys/validate", async (req, res) => {
  try {
    const { apiKey } = req.body || {};
    const keyToTest = apiKey || req.headers["x-api-key"] || (req.headers["authorization"]?.replace(/^Bearer\s+/i, ""));
    const keyDoc = await validateApiKey(keyToTest);
    if (!keyDoc) {
      return res.status(401).json({ success: false, valid: false, error: "Invalid or inactive API key" });
    }
    res.json({
      success: true,
      valid: true,
      key: {
        id: keyDoc.id,
        name: keyDoc.name,
        scopes: keyDoc.scopes,
        env: keyDoc.env,
        lastUsedAt: keyDoc.lastUsedAt,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
