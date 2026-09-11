/**
 * channelbot.in YouTube Video Comment & Lead Automation Service
 *
 * Strictly references key via process.env.CHANNELBOT_IN_API_KEY (or fallback process.env.CHANNELBOT_API_KEY).
 * REAL API Gateway: https://server-youtube-auto.onrender.com/api/external
 * REAL Auth Header: x-api-key: YOUR_KEY
 * NEVER prints, logs, hardcodes, or exposes the raw API key anywhere in code, logs, or responses.
 */

import { resolveOrCreateContact, upsertConversation, saveUnifiedMessage } from "../data/db.js";
import { PLATFORM_META } from "../constants/platformMeta.js";

const getBaseUrl = () => {
  return (
    process.env.CHANNELBOT_IN_BASE_URL ||
    process.env.CHANNELBOT_BASE_URL ||
    "https://server-youtube-auto.onrender.com/api/external"
  ).replace(/\/$/, "");
};

const getApiKey = () => {
  return (process.env.CHANNELBOT_IN_API_KEY || process.env.CHANNELBOT_API_KEY || "").trim();
};

export const isChannelBotInConfigured = () => {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  return Boolean(apiKey && baseUrl);
};

export const getChannelBotInConfigStatus = () => {
  return {
    configured: isChannelBotInConfigured(),
    baseUrl: getBaseUrl(),
    keyPrefix: getApiKey().slice(0, 3) || "none",
  };
};

/**
 * 1. Connection Verification & Dashboard Call Counter Driver
 * Executes a real authenticated API call to ChannelBot using process.env.CHANNELBOT_IN_API_KEY.
 * Auth Header: x-api-key: <key>
 * Endpoint: GET /api/external/leads
 */
export const verifyChannelBotInConnection = async (overrideKey) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { connected: false, error: "No channelbot.in API key configured" };

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/leads`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
    });

    const data = await response.json().catch(() => ({}));
    const isOk = response.ok && data.success !== false;

    return {
      connected: isOk,
      status: response.status,
      message: isOk ? "ChannelBot.in API connected and verified" : (data.error || data.message || `HTTP ${response.status}`),
      data,
    };
  } catch (err) {
    return {
      connected: false,
      error: err.message,
    };
  }
};

/**
 * 2. Scope: leads:read (Captured YouTube Leads / Video Comments Ingestion)
 * Fetches captured video leads from GET /api/external/leads.
 * Auth Header: x-api-key: <key>
 */
export const fetchYouTubeComments = async ({ overrideKey, limit = 50 } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, comments: [] };

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/leads`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
    });

    const data = await response.json().catch(() => ({}));
    const rawComments = data.data || data.leads || data.comments || (Array.isArray(data) ? data : []);

    return {
      success: response.ok,
      comments: Array.isArray(rawComments) ? rawComments : [],
      raw: data,
    };
  } catch (err) {
    return { success: false, comments: [], error: err.message };
  }
};

/**
 * 3. Scope: customers:read (Fetch Detailed Customer Profiles with Metrics)
 * Calls GET /api/external/customers/details?page={page}&limit={limit}
 * Auth Header: x-api-key: <key>
 */
export const fetchChannelBotCustomerDetails = async ({ page = 1, limit = 20, overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, customers: [] };

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/customers/details?page=${page}&limit=${limit}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
    });

    const data = await response.json().catch(() => ({}));
    const rawCustomers = data.data || data.customers || data.details || (Array.isArray(data) ? data : []);

    return {
      success: response.ok,
      customers: Array.isArray(rawCustomers) ? rawCustomers : [],
      page,
      limit,
      raw: data,
    };
  } catch (err) {
    return { success: false, customers: [], error: err.message };
  }
};

/**
 * 4. Scope: leads:write (Create a New Lead Record)
 * Calls POST /api/external/leads
 * Auth Header: x-api-key: <key>
 */
export const createChannelBotLead = async ({ name, email, phone, overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, error: "No channelbot.in API key configured" };

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/leads`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, email, phone }),
    });

    const data = await response.json().catch(() => ({}));
    return {
      success: response.ok,
      status: response.status,
      data,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

/**
 * 5. Scope: leads:read / customers:read (YouTube Lead Sync)
 * Fetches captured video leads from GET /api/external/leads and merges into BUZZZ Contact model.
 */
export const syncChannelBotLeads = async ({ workspaceId = "ws_default", overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, syncedCount: 0, error: "No channelbot.in API key configured" };

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/leads`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
    });

    const data = await response.json().catch(() => ({}));
    const rawLeads = data.data || data.leads || data.customers || (Array.isArray(data) ? data : []);
    const synced = [];

    if (Array.isArray(rawLeads)) {
      for (const lead of rawLeads) {
        const handle = lead.youtubeHandle || lead.youtube_handle || lead.author || lead.name || "YouTube Viewer";
        const email = lead.email;
        const phone = lead.phone ? String(lead.phone).replace(/\D/g, "") : null;

        const identities = [];
        if (handle) identities.push({ type: "youtube", value: handle });
        if (email) identities.push({ type: "email", value: email.toLowerCase() });
        if (phone) identities.push({ type: "phone", value: phone });

        const contact = await resolveOrCreateContact({
          workspaceId,
          name: lead.name || handle,
          email: email || undefined,
          phone: phone || undefined,
          identities,
          source: "channelbot.in YouTube Lead Capture",
          channel: "youtube",
          metadata: {
            channelbotLeadId: lead._id || lead.id,
            videoTitle: lead.videoTitle || lead.video_title,
            qualificationStatus: lead.status || "new",
          },
        });
        synced.push(contact);
      }
    }

    return {
      success: response.ok,
      syncedCount: synced.length,
      contacts: synced,
    };
  } catch (err) {
    return { success: false, syncedCount: 0, error: err.message };
  }
};

/**
 * 6. Scope: leads:write (Lead Qualification / Status Update)
 * Updates a lead's qualification status in ChannelBot backend.
 */
export const updateChannelBotLeadStatus = async ({ leadId, status, overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, error: "No channelbot.in API key configured" };

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/leads/${leadId}`;

  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "x-api-key": apiKey,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status }),
    });

    const data = await response.json().catch(() => ({}));
    console.log(`[updateChannelBotLeadStatus] HTTP Status: ${response.status}`, data);
    const isSuccess = response.ok;

    return {
      success: isSuccess,
      status: response.status,
      message: isSuccess ? "Lead status updated" : `Failed to update lead status (HTTP ${response.status})`,
      error: isSuccess ? undefined : (data.error || data.message || `HTTP ${response.status}`),
      data,
    };
  } catch (err) {
    console.error("[updateChannelBotLeadStatus error]:", err.message);
    return { success: false, error: err.message };
  }
};

/**
 * 7. Background Polling Scheduler for ChannelBot.in YouTube
 */
let isChannelBotSyncRunning = false;

export function startChannelBotAutoSyncScheduler(broadcastFn, intervalMs = 60000) {
  console.log(`⏰ Initializing ChannelBot.in YouTube background sync scheduler (polling every ${intervalMs / 1000}s)...`);
  setInterval(async () => {
    if (isChannelBotSyncRunning) return;
    isChannelBotSyncRunning = true;
    try {
      if (!isChannelBotInConfigured()) return;
      const commentsRes = await fetchYouTubeComments({ limit: 20 });
      if (commentsRes.success && Array.isArray(commentsRes.comments) && commentsRes.comments.length > 0) {
        let newCount = 0;
        for (const cmt of commentsRes.comments) {
          const authorHandle = cmt.author_handle || cmt.youtubeHandle || cmt.author || cmt.name || "YouTube Viewer";
          const textBody = cmt.text || cmt.comment_text || cmt.message || cmt.lead_source || "New YouTube lead captured";
          const extId = cmt._id || cmt.id || cmt.comment_id || cmt.commentId || cmt.leadId || (cmt.email ? `yt_lead_${cmt.email}` : `yt_lead_${String(cmt.name || authorHandle).replace(/\W/g, "_")}`);
          const videoTitle = cmt.videoTitle || cmt.video_title || "YouTube Video";

          const contact = await resolveOrCreateContact({
            workspaceId: "ws_default",
            name: cmt.author_name || cmt.name || authorHandle,
            email: cmt.email || undefined,
            identities: [
              { type: "youtube", value: authorHandle },
              { type: "custom", value: authorHandle },
            ],
            source: "ChannelBot.in YouTube Auto-Sync",
            channel: "youtube",
          });

          const convId = `conv_yt_${String(authorHandle).replace(/\s+/g, "_")}`;
          const convDoc = {
            id: convId,
            workspaceId: "ws_default",
            customerName: contact?.name || authorHandle,
            channel: "YouTube",
            unreadCount: 1,
            lastMessage: `${videoTitle}: ${textBody}`,
            updatedAt: new Date().toISOString(),
          };
          const conv = await upsertConversation(convDoc);

          const { doc: msgDoc, isNew } = await saveUnifiedMessage({
            id: `msg_${extId}`,
            workspaceId: "ws_default",
            conversationId: conv.id,
            integrationId: "channelbot",
            platform: "youtube",
            externalMessageId: extId,
            sender: {
              name: contact?.name || authorHandle,
              handle: authorHandle,
              contactId: contact?.id || null,
              kind: "customer",
            },
            direction: "inbound",
            text: textBody,
            status: "received",
            receivedAt: new Date().toISOString(),
            metadata: { videoTitle },
          });

          if (isNew) {
            newCount++;
            if (typeof broadcastFn === "function") {
              broadcastFn("new_message", {
                message: msgDoc,
                conversation: conv,
                platform: "youtube",
                platformMeta: PLATFORM_META.youtube,
              });
              broadcastFn("message:new", { conversation: conv, message: msgDoc });
            }
          }
        }
        if (newCount > 0) {
          console.log(`▶️ [CHANNELBOT AUTO-SYNC] Synced ${newCount} new YouTube lead/comment(s).`);
        }
      }
      await syncChannelBotLeads({ workspaceId: "ws_default" });
    } catch (e) {
      console.warn("⚠️ Background ChannelBot.in auto-sync error:", e.message);
    } finally {
      isChannelBotSyncRunning = false;
    }
  }, intervalMs);
}
