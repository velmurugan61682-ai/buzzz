/**
 * InstaxBot (instaxbot.com) Integration Service
 * 
 * Manages authenticated communication with InstaxBot API using INSTAXBOT_API_KEY.
 * Strictly references key via process.env.INSTAXBOT_API_KEY.
 * NEVER prints, logs, hardcodes, or exposes the raw API key anywhere.
 */

import { resolveOrCreateContact, upsertConversation, saveUnifiedMessage } from "../data/db.js";
import { PLATFORM_META } from "../constants/platformMeta.js";

const getBaseUrl = () => {
  return (process.env.INSTAXBOT_BASE_URL || "https://app.instaxbot.com").replace(/\/$/, "");
};

const getApiKey = () => {
  return (process.env.INSTAXBOT_API_KEY || "").trim();
};

export const isInstaxBotConfigured = () => {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  return Boolean(apiKey && baseUrl);
};

export const getInstaxBotConfigStatus = () => {
  return {
    configured: isInstaxBotConfigured(),
    baseUrl: getBaseUrl(),
    keyPrefix: getApiKey().slice(0, 3) || "none",
  };
};

/**
 * Common headers for InstaxBot API requests
 */
const getAuthHeaders = (overrideKey) => {
  const apiKey = overrideKey || getApiKey();
  return {
    "X-API-KEY": apiKey,
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
};

/**
 * 1. Scope: webhooks.manage
 * Register/Update BUZZZ webhook URL with InstaxBot for automated DM delivery.
 */
export const registerInstaxBotWebhook = async ({ webhookUrl, overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, reason: "No InstaxBot API key configured" };

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/api/external/v2/webhooks/register`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: getAuthHeaders(apiKey),
      body: JSON.stringify({
        webhookUrl: webhookUrl || `${process.env.PUBLIC_URL || "http://localhost:5000"}/api/integrations/instaxbot/webhook`,
        events: ["messages", "comments", "orders"],
      }),
    });

    const data = await response.json().catch(() => ({}));
    return {
      success: response.ok,
      status: response.status,
      data,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      note: "InstaxBot webhook registration offline fallback engaged",
    };
  }
};

/**
 * 2. Scope: orders.read
 * Authenticated Health Check / Order Sync Endpoint.
 * Executing this call increments the InstaxBot dashboard 'reqs' counter off 0.
 */
export const fetchInstaxBotOrders = async ({ page = 1, limit = 50, overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, error: "No InstaxBot API key configured" };

  const baseUrl = getBaseUrl();
  // Try v2 orders endpoint, fallback to resource endpoint
  const primaryUrl = `${baseUrl}/api/external/v2/orders?page=${page}&limit=${limit}`;
  const fallbackUrl = `${baseUrl}/api/external/v2/data?resource=orders&page=${page}&limit=${limit}`;

  try {
    let response = await fetch(primaryUrl, {
      method: "GET",
      headers: getAuthHeaders(apiKey),
    });

    if (response.status === 404) {
      response = await fetch(fallbackUrl, {
        method: "GET",
        headers: getAuthHeaders(apiKey),
      });
    }

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { rawText: text.substring(0, 200) };
    }

    return {
      success: response.ok,
      status: response.status,
      count: data.count || data.data?.length || 0,
      orders: data.orders || data.data || [],
      raw: data,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      orders: [],
    };
  }
};

/**
 * 3. Scope: contacts.read
 * Fetch InstaxBot customer/client contacts and sync them into BUZZZ Unified Contacts model.
 */
export const syncInstaxBotContacts = async ({ workspaceId = "ws_default", overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, syncedCount: 0, error: "No InstaxBot API key configured" };

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/api/external/v2/clients?limit=100`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: getAuthHeaders(apiKey),
    });

    const data = await response.json().catch(() => ({}));
    const rawClients = data.clients || data.data || [];
    const synced = [];

    for (const c of rawClients) {
      const name = c.name || c.username || c.email?.split("@")[0] || "Instagram Customer";
      const handle = c.username || c.name?.toLowerCase().replace(/\s+/g, "_") || c._id;

      const contact = await resolveOrCreateContact({
        workspaceId,
        name,
        identities: [
          { type: "instagram", value: handle },
          { type: "custom", value: handle },
        ],
        source: "InstaxBot Contacts Sync",
        channel: "instagram",
        metadata: {
          instaxbotTenantId: c.tenantId || c._id,
          plan: c.plan,
          status: c.status,
        },
      });
      synced.push(contact);
    }

    return {
      success: true,
      syncedCount: synced.length,
      contacts: synced,
    };
  } catch (err) {
    return {
      success: false,
      syncedCount: 0,
      error: err.message,
    };
  }
};

/**
 * 4. Scope: contacts.write
 * Update contact attributes/tags on InstaxBot side.
 */
export const updateInstaxBotContact = async ({ tenantId, updateData, overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, error: "No InstaxBot API key configured" };

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/api/external/v2/clients/${tenantId}`;

  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: getAuthHeaders(apiKey),
      body: JSON.stringify(updateData || {}),
    });
    const data = await response.json().catch(() => ({}));
    return { success: response.ok, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

/**
 * 5. Scope: broadcasts.send
 * Dispatch broadcast message through InstaxBot API.
 */
export const sendInstaxBotBroadcast = async ({ segmentId, templateId, messageText, overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, error: "No InstaxBot API key configured" };

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/api/external/v2/broadcasts`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: getAuthHeaders(apiKey),
      body: JSON.stringify({ segmentId, templateId, messageText }),
    });
    const data = await response.json().catch(() => ({}));
    return { success: response.ok, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

/**
 * 6. Scope: templates.read
 * Fetch saved message templates from InstaxBot.
 */
export const fetchInstaxBotTemplates = async ({ overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, templates: [] };

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/api/external/v2/templates`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: getAuthHeaders(apiKey),
    });
    const data = await response.json().catch(() => ({}));
    return {
      success: response.ok,
      templates: data.templates || data.data || [],
    };
  } catch (err) {
    return { success: false, templates: [], error: err.message };
  }
};

/**
 * 7. Scope: messages.read + messages.send
 * - messages.read: Ingest incoming comments/DMs from InstaxBot endpoint
 * - messages.send: Send outbound comment reply via InstaxBot
 */
/**
 * 7. Scope: messages.read + messages.send
 * - messages.read: Ingest incoming comments/DMs and Instagram order messages from InstaxBot endpoint
 * - messages.send: Send outbound comment reply via InstaxBot
 */
export const fetchInstaxBotMessages = async ({ limit = 50, overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, messages: [] };

  const baseUrl = getBaseUrl();
  const messages = [];

  // 1. Attempt to fetch comments / DMs directly if permitted
  try {
    const commentsRes = await fetch(`${baseUrl}/api/external/v2/comments?limit=${limit}`, {
      method: "GET",
      headers: getAuthHeaders(apiKey),
    });
    if (commentsRes.ok) {
      const data = await commentsRes.json().catch(() => ({}));
      const raw = data.comments || data.messages || data.data || [];
      if (Array.isArray(raw)) messages.push(...raw);
    }
  } catch (_e) {}

  // 2. Ingest Instagram order messages & DMs from /orders endpoint
  try {
    const ordersRes = await fetchInstaxBotOrders({ limit, overrideKey: apiKey });
    if (ordersRes.success && Array.isArray(ordersRes.orders) && ordersRes.orders.length > 0) {
      for (const order of ordersRes.orders) {
        const senderHandle = order.username || order.senderId || order.customer_name || "instagram_user";
        const senderName = order.name || order.customer_name || senderHandle;
        const itemsText = Array.isArray(order.products) && order.products.length > 0
          ? order.products.map((p) => `${p.product_name} (x${p.quantity || 1})`).join(", ")
          : "Instagram Products";
        const textBody = `🛍️ InstaxBot Order #${order.orderId || order.bill_no}: ${itemsText} - Total: ${order.currency || "INR"} ${order.total_amount || order.amount} [Status: ${order.status || "CREATED"}]`;

        messages.push({
          _id: order._id || `instax_ord_${order.orderId || order.bill_no}`,
          sender_handle: senderHandle,
          sender_name: senderName,
          message: textBody,
          receivedAt: order.created_at || new Date().toISOString(),
          rawOrder: order,
        });
      }
    }
  } catch (_e) {}

  return {
    success: messages.length > 0,
    messages,
  };
};

export const sendInstaxBotMessage = async ({ recipientId, text, overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, error: "No InstaxBot API key configured" };

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/api/external/v2/comments`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: getAuthHeaders(apiKey),
      body: JSON.stringify({
        commentId: `outbound_cmt_${Date.now()}`,
        senderId: "buzzz_platform",
        mediaId: recipientId || "media_default",
        message: text,
      }),
    });
    const data = await response.json().catch(() => ({}));
    return { success: response.ok, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

/**
 * 8. Background Polling Scheduler for InstaxBot Instagram
 */
let isInstaxBotSyncRunning = false;

export function startInstaxBotAutoSyncScheduler(broadcastFn, intervalMs = 45000) {
  console.log(`⏰ Initializing InstaxBot Instagram background sync scheduler (polling every ${intervalMs / 1000}s)...`);
  setInterval(async () => {
    if (isInstaxBotSyncRunning) return;
    isInstaxBotSyncRunning = true;
    try {
      if (!isInstaxBotConfigured()) return;
      const res = await fetchInstaxBotMessages({ limit: 50 });
      if (res.success && Array.isArray(res.messages) && res.messages.length > 0) {
        let newCount = 0;
        for (const msg of res.messages) {
          const senderHandle = msg.sender_handle || msg.handle || msg.sender?.handle || msg.author || "instagram_user";
          const senderName = msg.sender_name || msg.name || msg.sender?.name || senderHandle;
          const textBody = msg.message || msg.text || msg.caption || "New Instagram DM";
          const extId = msg._id || msg.id || msg.commentId || `ig_${Date.now()}`;
          const receivedAtIso = msg.receivedAt || new Date().toISOString();

          for (const targetWsId of ["ws_default", "demo-ws"]) {
            const contact = await resolveOrCreateContact({
              workspaceId: targetWsId,
              name: senderName,
              identities: [
                { type: "instagram", value: senderHandle },
                { type: "custom", value: senderHandle },
              ],
              source: "InstaxBot Instagram Auto-Sync",
              channel: "instagram",
            });

            const convId = `conv_ig_${String(senderHandle).replace(/\W/g, "_")}`;
            const convDoc = {
              id: convId,
              workspaceId: targetWsId,
              customerName: contact?.name || senderName,
              channel: "InstaxBot",
              platform: "instaxbot",
              unreadCount: 1,
              lastMessage: textBody,
              updatedAt: receivedAtIso,
            };
            const conv = await upsertConversation(convDoc);

            const { doc: msgDoc, isNew } = await saveUnifiedMessage({
              id: `msg_${extId}_${targetWsId}`,
              workspaceId: targetWsId,
              conversationId: conv.id,
              integrationId: "instaxbot",
              platform: "instaxbot",
              externalMessageId: extId,
              sender: {
                name: contact?.name || senderName,
                handle: senderHandle,
                contactId: contact?.id || null,
                kind: "customer",
              },
              direction: "inbound",
              text: textBody,
              status: "received",
              receivedAt: receivedAtIso,
            });

            if (isNew) {
              newCount++;
              if (typeof broadcastFn === "function") {
                broadcastFn("new_message", {
                  message: msgDoc,
                  conversation: conv,
                  platform: "instaxbot",
                  platformMeta: PLATFORM_META.instaxbot,
                });
                broadcastFn("message:new", { conversation: conv, message: msgDoc });
              }
            }
          }
        }
        if (newCount > 0) {
          console.log(`📸 [INSTAXBOT AUTO-SYNC] Synced ${res.messages.length} Instagram DM/Order(s) (${newCount} new, ${res.messages.length - newCount} duplicate(s) skipped).`);
        }
      }
      try {
        await syncInstaxBotContacts({ workspaceId: "ws_default" });
      } catch (_e) {}
    } catch (e) {
      console.warn("⚠️ Background InstaxBot auto-sync error:", e.message);
    } finally {
      isInstaxBotSyncRunning = false;
    }
  }, intervalMs);
}
