/**
 * channelbot.in YouTube Video Comment & Lead Automation Service
 *
 * Strictly references key via process.env.CHANNELBOT_IN_API_KEY (or fallback process.env.CHANNELBOT_API_KEY).
 * NEVER prints, logs, hardcodes, or exposes the raw API key anywhere in code, logs, or responses.
 */

import { resolveOrCreateContact, upsertConversation, saveUnifiedMessage } from "../data/db.js";
import { PLATFORM_META } from "../constants/platformMeta.js";

const getBaseUrl = () => {
  return (process.env.CHANNELBOT_IN_BASE_URL || "https://channelbot.in/api").replace(/\/$/, "");
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
 * Executes a real authenticated API call to channelbot.in using process.env.CHANNELBOT_IN_API_KEY.
 * Increments the call counter on the channelbot.in dashboard.
 */
export const verifyChannelBotInConnection = async (overrideKey) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { connected: false, error: "No channelbot.in API key configured" };

  const baseUrl = getBaseUrl();
  // Call comments or leads endpoint with Accept: application/json
  const url = `${baseUrl}/comments`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
    });

    const data = await response.json().catch(() => ({}));
    const isOk = response.ok && data.success !== false;

    return {
      connected: isOk,
      status: response.status,
      message: isOk ? "channelbot.in YouTube comments API connected and verified" : (data.error || data.message || `HTTP ${response.status}`),
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
 * 2. Scope: comments:read (YouTube Video Comments Ingestion)
 * Fetches YouTube video comments captured by channelbot.in.
 */
export const fetchYouTubeComments = async ({ overrideKey, limit = 50 } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, comments: [] };

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/comments?limit=${limit}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
    });

    const data = await response.json().catch(() => ({}));
    const rawComments = data.data || data.comments || (Array.isArray(data) ? data : []);

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
 * 3. Scope: leads:read / customers:read (YouTube Lead Sync)
 * Fetches captured video leads and merges into BUZZZ Unified Contact model.
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
        "Authorization": `Bearer ${apiKey}`,
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
      success: true,
      syncedCount: synced.length,
      contacts: synced,
    };
  } catch (err) {
    return { success: false, syncedCount: 0, error: err.message };
  }
};

/**
 * 4. Scope: leads:write (Lead Qualification / Status Update)
 * Updates a lead's qualification status in channelbot.in backend.
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
        "Authorization": `Bearer ${apiKey}`,
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
 * 5. Background Polling Scheduler for ChannelBot.in YouTube
 */
export function startChannelBotAutoSyncScheduler(broadcastFn, intervalMs = 30000) {
  console.log(`⏰ Initializing ChannelBot.in YouTube background sync scheduler (polling every ${intervalMs / 1000}s)...`);
  setInterval(async () => {
    try {
      if (!isChannelBotInConfigured()) return;
      const commentsRes = await fetchYouTubeComments({ limit: 20 });
      if (commentsRes.success && Array.isArray(commentsRes.comments) && commentsRes.comments.length > 0) {
        let newCount = 0;
        for (const cmt of commentsRes.comments) {
          const authorHandle = cmt.author_handle || cmt.youtubeHandle || cmt.author || "YouTube Viewer";
          const textBody = cmt.text || cmt.comment_text || cmt.message || "New YouTube comment";
          const extId = cmt.comment_id || cmt.commentId || cmt.id || `yt_${Date.now()}`;
          const videoTitle = cmt.videoTitle || cmt.video_title || "YouTube Video";

          const contact = await resolveOrCreateContact({
            workspaceId: "ws_default",
            name: cmt.author_name || authorHandle,
            email: cmt.email || undefined,
            identities: [
              { type: "youtube", value: authorHandle },
              { type: "custom", value: authorHandle },
            ],
            source: "ChannelBot.in YouTube Auto-Sync",
            channel: "youtube",
          });

          const convId = `conv_yt_${authorHandle.replace(/\s+/g, "_")}`;
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
          console.log(`▶️ [CHANNELBOT AUTO-SYNC] Synced ${newCount} new YouTube comment(s).`);
        }
      }
      await syncChannelBotLeads({ workspaceId: "ws_default" });
    } catch (e) {
      console.warn("⚠️ Background ChannelBot.in auto-sync error:", e.message);
    }
  }, intervalMs);
}
