/**
 * InstaxBot (instaxbot.com) Integration Service
 * 
 * Manages authenticated communication with InstaxBot API using INSTAXBOT_API_KEY.
 * Strictly references key via process.env.INSTAXBOT_API_KEY.
 * NEVER prints, logs, hardcodes, or exposes the raw API key anywhere.
 */

import { resolveOrCreateContact, upsertConversation, saveUnifiedMessage, saveOrderRecord, syncDealsFromOrders } from "../data/db.js";
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
 * Fetch ALL InstaxBot orders across all pages dynamically
 */
export const fetchAllInstaxBotOrders = async ({ overrideKey, limit = 50, throttleMs = 200 } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, orders: [], total: 0, pagesRead: 0 };

  const allOrders = [];
  let page = 1;
  let hasMore = true;
  let totalReported = 0;
  let pagesReported = 0;

  while (hasMore) {
    try {
      const res = await fetchInstaxBotOrders({ page, limit, overrideKey: apiKey });
      if (!res.success && (!res.orders || res.orders.length === 0)) {
        break;
      }

      const batch = res.orders || [];
      allOrders.push(...batch);

      const pagination = res.raw?.pagination || {};
      if (pagination.totalRecords) totalReported = pagination.totalRecords;
      if (pagination.totalPages) pagesReported = pagination.totalPages;

      console.log(`📦 [fetchAllInstaxBotOrders] Page ${page}: fetched ${batch.length} order(s) (running total: ${allOrders.length}/${totalReported || "?"})`);

      if (batch.length < limit || (pagesReported > 0 && page >= pagesReported)) {
        hasMore = false;
      } else {
        page++;
        if (throttleMs > 0) await new Promise((r) => setTimeout(r, throttleMs));
      }
    } catch (err) {
      console.warn(`⚠️ [fetchAllInstaxBotOrders] Page ${page} fetch error:`, err.message);
      break;
    }
  }

  return {
    success: allOrders.length > 0,
    orders: allOrders,
    total: totalReported || allOrders.length,
    pagesRead: page,
  };
};

/**
 * 3. Scope: contacts.read
 * Fetch InstaxBot customer/client contacts and sync them into BUZZZ Unified Contacts model.
 * If /clients returns 403/empty, automatically extracts real customer contacts from InstaxBot orders!
 */
export const syncInstaxBotContacts = async ({ workspaceId = "ws_default", overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, syncedCount: 0, error: "No InstaxBot API key configured" };

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/api/external/v2/clients?limit=100`;

  try {
    let rawClients = [];
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: getAuthHeaders(apiKey),
      });
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        rawClients = data.clients || data.data || [];
      }
    } catch (_e) {}

    const synced = [];
    const seenHandles = new Set();

    // 1. Ingest from /clients if available
    for (const c of rawClients) {
      const name = c.name || c.username || c.email?.split("@")[0] || "Instagram Customer";
      const handle = c.username || c.name?.toLowerCase().replace(/\s+/g, "_") || c._id;
      if (!handle || seenHandles.has(handle)) continue;
      seenHandles.add(handle);

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

    // 2. If /clients returned 0 or 403, extract real customer contacts from orders!
    if (synced.length === 0) {
      const ordersRes = await fetchAllInstaxBotOrders({ overrideKey: apiKey, limit: 50 });
      for (const order of ordersRes.orders || []) {
        const handle = order.username || order.senderId || (order.orderId ? `guest_${order.orderId}` : (order.bill_no ? `guest_${order.bill_no}` : `guest_${order._id}`));
        if (!handle || seenHandles.has(handle)) continue;
        seenHandles.add(handle);

        const name = order.name || order.customer_name || handle;
        const phone = order.phone_number ? String(order.phone_number).replace(/\D/g, "") : null;
        const identities = [{ type: "instagram", value: handle }];
        if (phone) identities.push({ type: "phone", value: phone });

        try {
          const contact = await resolveOrCreateContact({
            workspaceId,
            name,
            phone: phone || undefined,
            identities,
            source: "InstaxBot Order Sync",
            channel: "instagram",
            metadata: {
              city: order.city,
              state: order.state,
              zipCode: order.zip_code,
              address: order.address,
              lastOrderId: order.orderId || order.bill_no,
              totalAmount: order.total_amount || order.amount,
            },
          });
          synced.push(contact);
        } catch (innerErr) {
          console.warn(`⚠️ Failed to upsert InstaxBot contact for ${handle}:`, innerErr.message);
        }
      }
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
/**
 * 7. Scope: messages.read + messages.send
 * Ingest incoming Instagram order messages, comments and DMs from InstaxBot endpoint.
 */
export const fetchInstaxBotMessages = async ({ limit = 50, all = false, overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, messages: [] };

  const baseUrl = getBaseUrl();
  const messages = [];

  // 1. Attempt comments endpoint if accessible
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
    const ordersRes = all
      ? await fetchAllInstaxBotOrders({ overrideKey: apiKey, limit: 50 })
      : await fetchInstaxBotOrders({ limit, overrideKey: apiKey });

    if (ordersRes.success && Array.isArray(ordersRes.orders) && ordersRes.orders.length > 0) {
      for (const order of ordersRes.orders) {
        const senderHandle = order.username || order.senderId || `guest_${order.orderId}`;
        const senderName = order.name || order.customer_name || senderHandle;
        const itemsText = Array.isArray(order.products) && order.products.length > 0
          ? order.products.map((p) => `${p.product_name} (x${p.quantity || 1})`).join(", ")
          : "Instagram Products";
        const textBody = `🛍️ InstaxBot Order #${order.orderId || order.bill_no}: ${itemsText} - Total: ${order.currency || "INR"} ${order.total_amount || order.amount} [Status: ${order.status || "CREATED"}]`;

        messages.push({
          _id: order._id || `instax_ord_${order.orderId || order.bill_no}`,
          sender_handle: senderHandle,
          sender_name: senderName,
          phone: order.phone_number,
          message: textBody,
          receivedAt: order.created_at || new Date().toISOString(),
          rawOrder: order,
        });
      }
    }
  } catch (_e) {}

  return {
    success: messages.length > 0,
    total: messages.length,
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
 * 8. Historical Backfill Engine for InstaxBot (Paginates and Ingests ALL 150+ Orders)
 */
let instaxBotBackfillProgress = {
  status: "idle",
  startedAt: null,
  completedAt: null,
  currentPage: 0,
  totalPages: 0,
  totalRecordsReported: 0,
  recordsProcessed: 0,
  newlyInserted: 0,
  duplicatesSkipped: 0,
  error: null,
};

export const getInstaxBotBackfillStatus = () => ({ ...instaxBotBackfillProgress });

export const runInstaxBotHistoricalBackfill = async ({
  workspaceId = "ws_default",
  broadcastFn,
  overrideKey,
  limit = 50,
} = {}) => {
  if (instaxBotBackfillProgress.status === "running") {
    const runningForMs = instaxBotBackfillProgress.startedAt
      ? Date.now() - new Date(instaxBotBackfillProgress.startedAt).getTime()
      : 0;
    if (runningForMs < 120000) {
      return {
        success: true,
        message: "InstaxBot historical backfill already in progress",
        status: getInstaxBotBackfillStatus(),
      };
    }
  }

  const apiKey = overrideKey || getApiKey();
  if (!apiKey) {
    return { success: false, error: "No InstaxBot API key configured" };
  }

  instaxBotBackfillProgress = {
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    currentPage: 1,
    totalPages: 1,
    totalRecordsReported: 0,
    recordsProcessed: 0,
    newlyInserted: 0,
    duplicatesSkipped: 0,
    error: null,
  };

  (async () => {
    try {
      console.log("🚀 [INSTAXBOT BACKFILL] Fetching all orders via fetchAllInstaxBotOrders...");
      const fetchResult = await fetchAllInstaxBotOrders({ overrideKey: apiKey, limit: 50 });
      const orders = fetchResult.orders || [];
      instaxBotBackfillProgress.totalRecordsReported = fetchResult.total || orders.length;
      instaxBotBackfillProgress.totalPages = fetchResult.pagesRead || 1;

      console.log(`📦 [INSTAXBOT BACKFILL] Ingesting ${orders.length} orders into BUZZZ CRM & Unified Inbox...`);

      for (let i = 0; i < orders.length; i++) {
        const order = orders[i];
        instaxBotBackfillProgress.recordsProcessed = i + 1;
        instaxBotBackfillProgress.currentPage = Math.floor(i / 50) + 1;

        try {
          const senderHandle = order.username || order.senderId || (order.orderId ? `guest_${order.orderId}` : (order.bill_no ? `guest_${order.bill_no}` : `guest_${order._id || i}`));
          const senderName = order.name || order.customer_name || senderHandle;
          const phone = order.phone_number ? String(order.phone_number).replace(/\D/g, "") : null;
          const extId = order._id || `instax_ord_${order.orderId || order.bill_no || i}`;
          const receivedAtIso = order.created_at || new Date().toISOString();

          const itemsText = Array.isArray(order.products) && order.products.length > 0
            ? order.products.map((p) => `${p.product_name || "Product"} (x${p.quantity || 1})`).join(", ")
            : "Instagram Products";
          const textBody = `🛍️ InstaxBot Order #${order.orderId || order.bill_no || extId}: ${itemsText} - Total: ${order.currency || "INR"} ${order.total_amount || order.amount || 0} [Status: ${order.status || "CREATED"}]`;

          // 1. Upsert contact
          let contact = null;
          try {
            contact = await resolveOrCreateContact({
              workspaceId,
              name: senderName,
              phone: phone || undefined,
              identities: [
                { type: "instagram", value: senderHandle },
                ...(phone ? [{ type: "phone", value: phone }] : []),
              ],
              source: "InstaxBot Historical Backfill",
              channel: "instagram",
              metadata: {
                city: order.city,
                state: order.state,
                zipCode: order.zip_code,
                address: order.address,
                lastOrderId: order.orderId || order.bill_no,
                totalAmount: order.total_amount || order.amount,
              },
            });
          } catch (cErr) {
            console.warn(`⚠️ Error upserting contact for order ${extId}:`, cErr.message);
          }

          // 2. Upsert conversation
          const convId = `conv_ig_${String(senderHandle).replace(/\W/g, "_")}`;
          const convDoc = {
            id: convId,
            workspaceId,
            customerName: contact?.name || senderName,
            channel: "InstaxBot",
            platform: "instaxbot",
            phone: phone || senderHandle,
            unreadCount: 1,
            lastMessage: textBody,
            updatedAt: receivedAtIso,
          };
          const conv = await upsertConversation(convDoc);

          // 3. Save Unified Message
          const { doc: msgDoc, isNew } = await saveUnifiedMessage({
            id: `msg_${extId}_${workspaceId}`,
            workspaceId,
            conversationId: conv?.id || convId,
            integrationId: "instaxbot",
            platform: "instaxbot",
            externalMessageId: extId,
            sender: {
              name: contact?.name || senderName,
              handle: senderHandle,
              phone: phone || "",
              contactId: contact?.id || null,
              kind: "customer",
            },
            direction: "inbound",
            text: textBody,
            status: "received",
            receivedAt: receivedAtIso,
            metadata: {
              orderId: order.orderId,
              billNo: order.bill_no,
              amount: order.amount,
              totalAmount: order.total_amount,
              currency: order.currency,
              orderStatus: order.status,
              paymentStatus: order.paymentStatus,
              products: order.products,
              shippingPartner: order.shipping_partner,
              trackingStatus: order.tracking_status,
            },
          });

          // 4. Save into OrderModel
          try {
            await saveOrderRecord({
              workspaceId,
              conversationId: conv?.id || convId,
              platform: "instaxbot",
              externalOrderId: extId,
              orderId: String(order.orderId || order.bill_no || extId),
              customerPhone: phone || senderHandle,
              customerName: senderName,
              totalAmount: Number(order.total_amount || order.amount) || 0,
              currency: order.currency || "INR",
              status: (order.status || "pending").toLowerCase(),
              paymentStatus: (order.paymentStatus || "pending").toLowerCase(),
              items: (Array.isArray(order.products) ? order.products : []).map((p) => ({
                name: p.product_name || "Product",
                quantity: p.quantity || 1,
                price: p.price || 0,
                totalPrice: (p.price || 0) * (p.quantity || 1),
              })),
              metadata: {
                address: order.address,
                city: order.city,
                state: order.state,
                zipCode: order.zip_code,
                trackingStatus: order.tracking_status,
                shippingPartner: order.shipping_partner,
              },
              createdAt: order.created_at,
            });
          } catch (oErr) {
            console.warn(`⚠️ Error saving order record for ${extId}:`, oErr.message);
          }

          if (isNew) {
            instaxBotBackfillProgress.newlyInserted++;
            if (typeof broadcastFn === "function") {
              broadcastFn("new_message", {
                message: msgDoc,
                conversation: conv,
                platform: "instaxbot",
                platformMeta: PLATFORM_META.instaxbot,
              });
              broadcastFn("message:new", { conversation: conv, message: msgDoc });
            }
          } else {
            instaxBotBackfillProgress.duplicatesSkipped++;
          }
        } catch (itemErr) {
          console.warn(`⚠️ Error processing order index ${i}:`, itemErr.message);
        }
      }

      // Sync Deals from all stored orders
      try {
        await syncDealsFromOrders(workspaceId);
      } catch (dErr) {
        console.warn("⚠️ syncDealsFromOrders error during backfill:", dErr.message);
      }

      instaxBotBackfillProgress.status = "completed";
      instaxBotBackfillProgress.completedAt = new Date().toISOString();
      console.log(`✅ [INSTAXBOT BACKFILL COMPLETED] Processed ${instaxBotBackfillProgress.recordsProcessed} orders (${instaxBotBackfillProgress.newlyInserted} new messages, ${instaxBotBackfillProgress.duplicatesSkipped} duplicates skipped).`);
    } catch (err) {
      console.error("❌ [INSTAXBOT BACKFILL ERROR]:", err.message);
      instaxBotBackfillProgress.status = "failed";
      instaxBotBackfillProgress.error = err.message;
      instaxBotBackfillProgress.completedAt = new Date().toISOString();
    }
  })();

  return {
    success: true,
    message: "InstaxBot historical backfill job started in background",
    status: getInstaxBotBackfillStatus(),
  };
};

/**
 * 9. Background Polling Scheduler for InstaxBot Instagram
 */
let isInstaxBotSyncRunning = false;

export function startInstaxBotAutoSyncScheduler(broadcastFn, intervalMs = 45000) {
  console.log(`⏰ Initializing InstaxBot Instagram background sync scheduler (polling every ${intervalMs / 1000}s)...`);

  // Run an initial backfill 3 seconds after boot to populate all orders immediately
  setTimeout(() => {
    if (isInstaxBotConfigured()) {
      console.log("🚀 [INSTAXBOT STARTUP] Initiating auto-backfill of InstaxBot orders...");
      runInstaxBotHistoricalBackfill({ workspaceId: "ws_default", broadcastFn }).catch((e) =>
        console.warn("⚠️ InstaxBot initial backfill warning:", e.message)
      );
    }
  }, 3000);

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

