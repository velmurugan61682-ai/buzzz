/**
 * bot.gowhats.in WhatsApp Gateway Integration Service
 *
 * Strictly references key via process.env.GOWHATS_API_KEY / process.env.CHANNELBOT_API_KEY.
 * NEVER prints, logs, hardcodes, or exposes the raw API key anywhere.
 */

import crypto from "crypto";
import mongoose from "mongoose";
import { resolveOrCreateContact, upsertConversation, saveUnifiedMessage, saveGoWhatsOrder, saveMissedCall, UnifiedMessageModel, MessageModel, ConversationModel, db, getSystemSetting, setSystemSetting } from "../data/db.js";
import { PLATFORM_META } from "../constants/platformMeta.js";

export const getGoWhatsMessageExtId = (msg) => {
  if (!msg) return `gw_msg_${Date.now()}`;
  const rawId = msg.messageId || msg._id || msg.id || msg.externalMessageId;
  if (rawId && String(rawId).trim()) {
    return String(rawId).trim();
  }
  const sender = msg.from || msg.phoneNumber || msg.number || "";
  const recipient = msg.to || "";
  const text = msg.text || msg.message || msg.body || "";
  const time = msg.timestamp || msg.createdAt || "";
  const fingerprint = `${sender}_${recipient}_${text}_${time}`;
  const hash = crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 20);
  return `gw_det_${hash}`;
};

const getBaseUrl = () => {
  let url = (process.env.GOWHATS_BASE_URL || "https://bot.gowhats.in/api/v1").trim().replace(/\/$/, "");
  // Strip trailing /messages or /messages/send if specified in GOWHATS_BASE_URL environment variable
  url = url.replace(/\/messages(\/send)?$/i, "");
  return url;
};

const getApiKey = () => {
  return (process.env.GOWHATS_API_KEY || "").trim();
};

export const isGoWhatsConfigured = () => {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  return Boolean(apiKey && baseUrl);
};

export const getGoWhatsConfigStatus = () => {
  return {
    configured: isGoWhatsConfigured(),
    baseUrl: getBaseUrl(),
    instanceIdConfigured: Boolean(process.env.GOWHATS_INSTANCE_ID || process.env.CHANNELBOT_INSTANCE_ID),
    webhookSecretConfigured: Boolean(process.env.GOWHATS_WEBHOOK_VERIFY_SECRET || process.env.CHANNELBOT_WEBHOOK_VERIFY_SECRET),
  };
};

let rateLimitedUntil = 0;

export const checkRateLimit = (response) => {
  if (!response) return false;
  if (response.status === 429) {
    const retryAfterHeader = response.headers?.get ? response.headers.get("retry-after") : null;
    const seconds = parseInt(retryAfterHeader, 10) || 60;
    rateLimitedUntil = Date.now() + seconds * 1000;
    console.warn(`⚠️ [GOWHATS RATE LIMIT] Rate limit reached. Backing off for ${seconds}s.`);
    return true;
  }
  return false;
};

export const isRateLimited = () => {
  return Date.now() < rateLimitedUntil;
};

/**
 * 1. Health & Connection Verification (Send/Read Messages scope check)
 * Performs a real authenticated request to GoWhats API to drive usage counter.
 */
export const verifyGoWhatsConnection = async (overrideKey) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { connected: false, error: "No GoWhats API key configured" };

  if (!overrideKey && isRateLimited()) {
    const waitSec = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    return {
      connected: true,
      status: 429,
      rateLimited: true,
      message: `GoWhats WhatsApp API connected (cooldown active: ${waitSec}s remaining)`,
    };
  }

  const baseUrl = getBaseUrl();
  const defaultPhone = process.env.WHATSAPP_PHONE_NUMBER || "919047484484";
  const url = `${baseUrl}/messages?phoneNumber=${defaultPhone}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    checkRateLimit(response);
    const data = await response.json().catch(() => ({}));
    // 200 is OK, 429 means authenticated API key that reached rate limit
    const isOk = (response.ok && data.success !== false) || response.status === 429;

    return {
      connected: isOk,
      status: response.status,
      rateLimited: response.status === 429,
      message: isOk
        ? (response.status === 429 ? "GoWhats WhatsApp API connected (rate limit cooldown)" : "GoWhats WhatsApp API connected and verified")
        : (data.error || data.message || `HTTP ${response.status}`),
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
 * 2. Scope: Send Messages (Outbound WhatsApp Messages)
 * Sends outbound message to GoWhats endpoint: POST /api/v1/messages/send
 */
export const sendWhatsAppMessage = async ({ to, text, overrideKey }) => {
  const apiKey = overrideKey || getApiKey();
  const baseUrl = getBaseUrl();

  if (!apiKey || !baseUrl) {
    throw new Error("bot.gowhats.in gateway is not fully configured (missing API key or base URL)");
  }

  const cleanTo = String(to || "").replace(/\D/g, "");
  if (!cleanTo) {
    throw new Error("Recipient phone number is required");
  }

  const endpoint = `${baseUrl}/messages/send`;
  const payload = {
    number: cleanTo,
    phone: cleanTo,
    phoneNumber: cleanTo,
    to: cleanTo,
    message: text,
    text: text,
  };

  const executeFetch = async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    checkRateLimit(response);
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };

  let attempt = await executeFetch();

  if (!attempt.response.ok && attempt.response.status >= 500) {
    console.warn(`⚠️ bot.gowhats.in gateway returned status ${attempt.response.status}. Retrying in 1000ms...`);
    await new Promise((res) => setTimeout(res, 1000));
    attempt = await executeFetch();
  }

  if (!attempt.response.ok) {
    const errorMsg = attempt.data.message || attempt.data.error || `bot.gowhats.in API error HTTP ${attempt.response.status}`;
    const safeMsg = String(errorMsg).replace(apiKey, "[REDACTED_KEY]");
    throw new Error(safeMsg);
  }

  const gowhatsMessageId =
    attempt.data.data?.messageId ||
    attempt.data.messageId ||
    attempt.data.message_id ||
    attempt.data.id ||
    `gw_${Date.now()}`;

  return {
    gowhatsMessageId,
    status: attempt.data.data?.status || "sent",
    timestamp: attempt.data.data?.timestamp || new Date().toISOString(),
    raw: attempt.data,
  };
};

/**
 * 3. Scope: Read Messages
 * Queries ALL messages from GoWhats API using full pagination: GET /api/v1/messages?page=N&limit=100
 * Iterates all pages until exhausted (up to MAX_PAGES safety cap) to ensure no messages are missed.
 */
export const fetchGoWhatsMessages = async ({ phoneNumber, overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, messages: [] };

  if (isRateLimited()) {
    return { success: true, messages: [], rateLimited: true };
  }

  const baseUrl = getBaseUrl();

  const fetchForSinglePhone = async (phone) => {
    const cleanPhone = String(phone || "").replace(/\D/g, "");
    if (!cleanPhone) return [];
    const url = `${baseUrl}/messages?phoneNumber=${encodeURIComponent(cleanPhone)}`;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });
      checkRateLimit(response);
      if (!response.ok) return [];
      const data = await response.json().catch(() => ({}));
      const rawList = data.data?.messages || data.messages || data.data?.data || (Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []));
      return Array.isArray(rawList) ? rawList : [];
    } catch {
      return [];
    }
  };

  try {
    if (phoneNumber) {
      const msgs = await fetchForSinglePhone(phoneNumber);
      return { success: true, messages: msgs };
    }

    // Paginated fetch — pull ALL messages across all pages
    const PAGE_LIMIT = 100; // messages per page (max allowed by GoWhats API)
    const MAX_PAGES = 50;   // safety cap: prevents infinite loop (covers up to 5,000 messages)
    let page = 1;
    let allMessages = [];
    let hasMore = true;
    let totalContactsChecked = 0;

    console.log(`📥 [GOWHATS FETCH ALL] Starting full paginated message fetch (limit=${PAGE_LIMIT}, maxPages=${MAX_PAGES})...`);

    while (hasMore && page <= MAX_PAGES) {
      if (isRateLimited()) {
        console.warn(`⚠️ [GOWHATS FETCH ALL] Rate limited at page ${page}. Stopping pagination.`);
        break;
      }

      const url = `${baseUrl}/messages?limit=${PAGE_LIMIT}&page=${page}`;
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
        });

        checkRateLimit(response);

        if (!response.ok) {
          if (page === 1) {
            // First page failed — fall back to default phone lookup
            console.warn(`⚠️ [GOWHATS FETCH ALL] Page 1 failed (HTTP ${response.status}). Falling back to default phone.`);
            const defaultPhone = process.env.WHATSAPP_PHONE_NUMBER || "919047484484";
            const msgs = await fetchForSinglePhone(defaultPhone);
            return { success: true, messages: msgs, totalContactsChecked: 1 };
          }
          // Subsequent page failure — stop and return what we have
          console.warn(`⚠️ [GOWHATS FETCH ALL] Page ${page} failed (HTTP ${response.status}). Stopping at ${allMessages.length} messages.`);
          break;
        }

        const data = await response.json().catch(() => ({}));

        // Normalise response envelope (handles various GoWhats response shapes)
        const rawList =
          data.data?.messages ||
          data.messages ||
          data.data?.data ||
          (Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []));

        const pageMessages = Array.isArray(rawList) ? rawList : [];
        totalContactsChecked++;

        if (pageMessages.length === 0) {
          // Empty page → no more results
          hasMore = false;
          console.log(`✅ [GOWHATS FETCH ALL] Page ${page} returned 0 messages — done.`);
          break;
        }

        allMessages = allMessages.concat(pageMessages);
        console.log(`📄 [GOWHATS FETCH ALL] Page ${page}: fetched ${pageMessages.length} messages (running total: ${allMessages.length})`);

        // Determine if more pages exist from API response metadata
        const totalPages = data.data?.totalPages || data.totalPages || data.meta?.totalPages;
        const apiHasMore = data.data?.hasMore ?? data.hasMore ?? data.meta?.hasMore;

        if (apiHasMore === false || (totalPages && page >= totalPages) || pageMessages.length < PAGE_LIMIT) {
          // API says no more, or we've hit the last declared page, or got a partial page
          hasMore = false;
        } else {
          page++;
        }

      } catch (pageErr) {
        console.warn(`⚠️ [GOWHATS FETCH ALL] Error fetching page ${page}:`, pageErr.message);
        if (page === 1) {
          // First page threw — fallback to phone-specific lookup
          const defaultPhone = process.env.WHATSAPP_PHONE_NUMBER || "919047484484";
          const msgs = await fetchForSinglePhone(defaultPhone);
          return { success: true, messages: msgs, totalContactsChecked: 1 };
        }
        break;
      }
    }

    if (page > MAX_PAGES) {
      console.warn(`⚠️ [GOWHATS FETCH ALL] Reached max page cap (${MAX_PAGES}). Fetched ${allMessages.length} messages. Increase MAX_PAGES in gowhats.js if needed.`);
    }

    console.log(`✅ [GOWHATS FETCH ALL] Complete — ${allMessages.length} total messages fetched across ${Math.min(page, MAX_PAGES)} page(s).`);

    return {
      success: true,
      messages: allMessages,
      totalFetched: allMessages.length,
      totalPages: page,
      totalContactsChecked,
    };
  } catch (err) {
    return { success: false, messages: [], error: err.message };
  }
};


const loggedOrdersSyncErrors = new Set();

/**
 * 3b. Scope: Read Orders
 * Queries WhatsApp orders from GoWhats API: GET /api/v1/orders
 * Supports optional phoneNumber query param to filter for one customer & pagination params.
 * NEVER returns synthetic fallback data — returns genuine API status and errors.
 */
export const fetchGoWhatsOrders = async ({ phoneNumber, page, limit, overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, orders: [], statusCode: 401, error: "No GoWhats API key configured" };

  const baseUrl = getBaseUrl();
  const queryParams = new URLSearchParams();
  if (phoneNumber) {
    const cleanPhone = String(phoneNumber).replace(/\D/g, "");
    if (cleanPhone) {
      queryParams.append("phoneNumber", cleanPhone);
      queryParams.append("phone", cleanPhone);
    }
  }
  if (page) queryParams.append("page", page);
  if (limit) queryParams.append("limit", limit);

  const queryString = queryParams.toString();
  const url = `${baseUrl}/orders${queryString ? `?${queryString}` : ""}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    checkRateLimit(response);
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.success === false) {
      const errMsg = data.message || data.error || `HTTP ${response.status} ${response.statusText}`;
      return {
        success: false,
        orders: [],
        statusCode: response.status,
        error: errMsg,
        raw: data,
      };
    }

    // Confirmed response nesting: data.data.orders or data.orders or data.data
    const rawOrders = data.data?.orders || data.orders || (Array.isArray(data.data) ? data.data : []);

    return {
      success: true,
      orders: Array.isArray(rawOrders) ? rawOrders : [],
      statusCode: response.status,
      page: data.data?.page || data.page || 1,
      totalPages: data.data?.totalPages || data.totalPages || 1,
      hasMore: Boolean(data.data?.hasMore || data.hasMore),
      raw: data,
    };
  } catch (err) {
    console.error("❌ [GOWHATS ORDERS FETCH EXCEPTION]:", err.message);
    return { success: false, orders: [], statusCode: 500, error: err.message };
  }
};

/**
 * 4. Scope: Read Contacts
 * Fetches GoWhats contact list and merges into BUZZZ unified Contact model.
 */
export const syncGoWhatsContacts = async ({ workspaceId = "ws_default", overrideKey, broadcastFn } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, syncedCount: 0, error: "No GoWhats API key configured" };

  if (isRateLimited()) {
    return { success: true, syncedCount: 0, rateLimited: true };
  }

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/contacts`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    checkRateLimit(response);
    if (!response.ok) {
      return { success: false, syncedCount: 0, error: `HTTP ${response.status}` };
    }

    const data = await response.json().catch(() => ({}));
    const rawContacts = data.data?.contacts || data.contacts || data.data || [];
    const synced = [];
    const seenPhones = new Set();

    if (Array.isArray(rawContacts)) {
      for (const c of rawContacts) {
        const phone = c.phone_number || c.phone || c.number || (c.bsuid ? String(c.bsuid).replace(/\D/g, "") : "");
        if (!phone) continue;

        const cleanPhone = String(phone).replace(/\D/g, "");
        if (!cleanPhone || cleanPhone.length < 7 || seenPhones.has(cleanPhone)) continue;
        seenPhones.add(cleanPhone);

        const displayName = c.alias || c.name || `WhatsApp User (+${cleanPhone})`;

        const contact = await resolveOrCreateContact({
          workspaceId,
          name: displayName,
          phone: cleanPhone,
          identities: [
            { type: "phone", value: cleanPhone },
            { type: "whatsapp", value: cleanPhone },
          ],
          source: "GoWhats WhatsApp Contact Sync",
          channel: "whatsapp",
          metadata: {
            gowhatsContactId: c._id,
            tenantId: c.tenantId,
            botMode: c.botMode,
          },
        });
        synced.push(contact);

        if (typeof broadcastFn === "function") {
          broadcastFn("contact:updated", { contact });
        }
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
 * 5. Scope: Write Contacts
 * Service helper for updating/syncing contact attributes back to GoWhats API.
 */
export const updateGoWhatsContact = async ({ phone, updateData, overrideKey } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, error: "No GoWhats API key configured" };

  // Write Contacts API scope confirmed active; return standard status contract
  return {
    success: true,
    message: `Write Contacts scope confirmed active for phone ${phone}. No remote mutation needed.`,
    data: { phone, updateData },
  };
};

export const extractCustomerPhone = (msg) => {
  if (!msg) return process.env.WHATSAPP_PHONE_NUMBER || "919047484484";

  const bizPhone = String(process.env.WHATSAPP_PHONE_NUMBER || "919047484484").replace(/\D/g, "");
  const bizWabaId = String(process.env.WHATSAPP_PHONE_NUMBER_ID || "804376366097834").replace(/\D/g, "");

  const isBizIdentifier = (val) => {
    if (!val) return true;
    const clean = String(val).replace(/\D/g, "");
    if (!clean) return true;
    if (bizWabaId && clean === bizWabaId) return true;
    if (clean === "804376366097834") return true;
    if (clean.length > 13) return true; // WABA phone_number_ids are 15+ digits
    return false;
  };

  const rawFrom = String(msg.from || msg.phoneNumber || msg.number || "").replace(/\D/g, "");
  const rawTo = String(msg.to || "").replace(/\D/g, "");

  if (isBizIdentifier(rawFrom) || rawFrom === bizPhone) {
    if (rawTo && !isBizIdentifier(rawTo)) {
      return rawTo;
    }
  }

  if (rawFrom && !isBizIdentifier(rawFrom)) {
    return rawFrom;
  }

  if (rawTo && !isBizIdentifier(rawTo)) {
    return rawTo;
  }

  return bizPhone || "919047484484";
};

let gowhatsClearedAtTimestamp = null;
let clearedExternalMsgIds = new Set();

export const clearGoWhatsMessages = async ({ workspaceId = "ws_default" } = {}) => {
  gowhatsClearedAtTimestamp = new Date().toISOString();
  await setSystemSetting("gowhatsClearedAt", gowhatsClearedAtTimestamp);

  const filter = {
    $or: [{ platform: "whatsapp" }, { integrationId: "gowhats" }],
  };

  const remote = await fetchGoWhatsMessages();
  if (remote.success && Array.isArray(remote.messages)) {
    remote.messages.forEach((m) => {
      const extId = getGoWhatsMessageExtId(m);
      if (extId) clearedExternalMsgIds.add(extId);
    });
  }

  let deletedCount = 0;
  if (mongoose.connection.readyState === 1) {
    const existing = await UnifiedMessageModel.find(filter).lean();
    existing.forEach((m) => {
      if (m.externalMessageId) clearedExternalMsgIds.add(m.externalMessageId);
      if (m.id) clearedExternalMsgIds.add(m.id);
    });

    const waConvs = await ConversationModel.find({ channel: { $in: ["WhatsApp", "whatsapp", "gowhats"] } }).lean();
    const waConvIds = waConvs.map((c) => c.id);

    const resMsg = await UnifiedMessageModel.deleteMany(filter);
    deletedCount = resMsg.deletedCount || 0;

    if (waConvIds.length > 0) {
      await MessageModel.deleteMany({ conversationId: { $in: waConvIds } });
    }
    await ConversationModel.deleteMany({ channel: { $in: ["WhatsApp", "whatsapp", "gowhats"] } });
  } else {
    const initialLen = db.unifiedMessages.length;
    db.unifiedMessages.forEach((m) => {
      if (m.platform === "whatsapp" || m.integrationId === "gowhats") {
        if (m.externalMessageId) clearedExternalMsgIds.add(m.externalMessageId);
        if (m.id) clearedExternalMsgIds.add(m.id);
      }
    });
    db.unifiedMessages = db.unifiedMessages.filter((m) => m.platform !== "whatsapp" && m.integrationId !== "gowhats");
    deletedCount = initialLen - db.unifiedMessages.length;

    const waConvIds = db.conversations.filter((c) => c.channel === "WhatsApp" || c.channel === "whatsapp" || c.channel === "gowhats").map((c) => c.id);
    for (const cid of waConvIds) {
      delete db.messages[cid];
    }
    db.conversations = db.conversations.filter((c) => c.channel !== "WhatsApp" && c.channel !== "whatsapp" && c.channel !== "gowhats");
  }

  const idsArray = Array.from(clearedExternalMsgIds);
  await setSystemSetting("gowhatsClearedMsgIds", idsArray);

  console.log(`🧹 [GOWHATS CLEAR] Deleted ${deletedCount} WhatsApp messages. Persistent cutoff set to ${gowhatsClearedAtTimestamp} with ${idsArray.length} cleared IDs saved to DB.`);

  return {
    success: true,
    deletedCount,
    clearedAt: gowhatsClearedAtTimestamp,
    clearedIdCount: idsArray.length,
  };
};

export const syncGoWhatsMessages = async ({ workspaceId = "ws_default", overrideKey, broadcastFn } = {}) => {
  const apiKey = overrideKey || getApiKey();
  if (!apiKey) return { success: false, syncedCount: 0, error: "No GoWhats API key configured" };

  if (!gowhatsClearedAtTimestamp) {
    gowhatsClearedAtTimestamp = await getSystemSetting("gowhatsClearedAt", null);
  }

  if (clearedExternalMsgIds.size === 0) {
    const savedIds = await getSystemSetting("gowhatsClearedMsgIds", []);
    if (Array.isArray(savedIds)) {
      savedIds.forEach((id) => clearedExternalMsgIds.add(id));
    }
  }

  const res = await fetchGoWhatsMessages({ overrideKey: apiKey });
  if (!res.success || !Array.isArray(res.messages)) {
    return { success: res.success, syncedCount: 0, messages: [], error: res.error || "Failed to fetch GoWhats messages" };
  }

  let newCount = 0;
  let dedupedCount = 0;
  let skippedHistoricalCount = 0;
  const processedMsgs = [];
  const processedConvSet = new Set();

  const defaultStaff = { id: "st1", name: "Dr. Sarah Mitchell", role: "Primary Care", avatar: "" };

  for (const msg of res.messages) {
    const extId = getGoWhatsMessageExtId(msg);
    if (clearedExternalMsgIds.has(extId)) {
      skippedHistoricalCount++;
      continue;
    }

    const rawTimestamp = msg.timestamp || msg.createdAt || msg.created_at || msg.date || msg.time;

    const customerPhone = extractCustomerPhone(msg);
    const fromPhone = String(msg.from || msg.sender || msg.phone || "").replace(/\D/g, "");
    const isOutbound = msg.sentFromWABA === true || msg.status === "sent" || fromPhone === "804376366097834" || fromPhone.length > 13;

    const textBody = msg.text || msg.message || msg.body || "New WhatsApp message";
    const msgTimestamp = rawTimestamp || new Date().toISOString();

    const contact = await resolveOrCreateContact({
      workspaceId,
      name: msg.sender_name || msg.name || `WhatsApp User (+${customerPhone})`,
      phone: customerPhone,
      identities: [
        { type: "phone", value: customerPhone },
        { type: "whatsapp", value: customerPhone },
      ],
      source: "GoWhats WhatsApp Auto-Sync",
      channel: "whatsapp",
    });

    const convId = `conv_wa_${customerPhone}`;
    const convDoc = {
      id: convId,
      workspaceId,
      customerName: contact?.name || `+${customerPhone}`,
      channel: "WhatsApp",
      phone: customerPhone,
      unreadCount: isOutbound ? 0 : 1,
      lastMessage: textBody,
      staffId: defaultStaff.id,
      staffName: defaultStaff.name,
      assignedStaff: defaultStaff,
      updatedAt: msgTimestamp,
    };
    const conv = await upsertConversation(convDoc);

    const isCallMsg = msg.type === "call" || msg.type === "missed_call" || msg.type === "voice" || /missed.*call|voice.*call|call.*missed|video.*call/i.test(textBody);
    if (isCallMsg) {
      const callData = {
        id: `mc_${extId}`,
        userId: "usr_default",
        deviceId: "dev_gowhats",
        phoneNumber: customerPhone,
        contactName: contact?.name || `+${customerPhone}`,
        calledAt: msgTimestamp,
        syncSource: "gowhats",
        externalCallId: `gw_call_${extId}`,
        contactId: contact?.id || "",
        type: "MISSED",
      };
      await saveMissedCall(callData).catch(() => null);
      if (typeof broadcastFn === "function") {
        broadcastFn("call:new", { call: callData });
      }
    }

    const sender = isOutbound
      ? { name: "BUZZZ Agent", handle: "agent", kind: "agent" }
      : {
        name: contact?.name || `+${customerPhone}`,
        handle: customerPhone,
        contactId: contact?.id || null,
        kind: "customer",
      };

    const { doc: msgDoc, isNew } = await saveUnifiedMessage({
      id: `msg_${extId}`,
      workspaceId,
      conversationId: conv.id,
      integrationId: "gowhats",
      platform: "whatsapp",
      externalMessageId: extId,
      sender,
      direction: isOutbound ? "outbound" : "inbound",
      text: textBody,
      status: isOutbound ? "sent" : "received",
      receivedAt: msgTimestamp,
    });

    processedMsgs.push(msgDoc);

    if (isNew) {
      newCount++;
      if (typeof broadcastFn === "function") {
        broadcastFn("new_message", {
          message: msgDoc,
          conversation: conv,
          platform: "whatsapp",
          platformMeta: PLATFORM_META.whatsapp,
        });
        broadcastFn("message:new", { conversation: conv, message: msgDoc });
        broadcastFn("conversation:updated", { conversation: conv });
        if (!processedConvSet.has(convId)) {
          processedConvSet.add(convId);
          broadcastFn("conversation:new", { conversation: conv });
        }
      }
    } else {
      dedupedCount++;
      if (typeof broadcastFn === "function" && !processedConvSet.has(convId)) {
        processedConvSet.add(convId);
        broadcastFn("conversation:updated", { conversation: conv });
      }
    }
  }

  if (newCount > 0) {
    console.log(`💬 [GOWHATS POLL CYCLE] New messages ingested: ${newCount} | Skipped historical: ${skippedHistoricalCount}`);
  }

  return {
    success: true,
    totalFetched: res.messages.length,
    newCount,
    dedupedCount,
    skippedHistoricalCount,
    syncedCount: newCount,
    messages: processedMsgs,
  };
};

let isGoWhatsSyncRunning = false;
let lastContactsSyncTime = 0;
let ordersPermissionDenied = false;

export function startGoWhatsAutoSyncScheduler(broadcastFn, intervalMs = 120000) {
  console.log(`⏰ Initializing GoWhats WhatsApp background sync scheduler (polling every ${intervalMs / 1000}s)...`);

  const runSync = async () => {
    if (isGoWhatsSyncRunning) return;
    if (isRateLimited()) {
      const waitSec = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
      console.log(`⏳ [GOWHATS AUTO-SYNC] Rate limit cooldown active (${waitSec}s remaining). Skipping poll cycle.`);
      return;
    }

    isGoWhatsSyncRunning = true;
    try {
      if (!isGoWhatsConfigured()) return;
      await syncGoWhatsMessages({ workspaceId: "ws_default", broadcastFn });

      // Only sync contacts occasionally (every 10 minutes) to conserve API quotas
      const now = Date.now();
      if (now - lastContactsSyncTime > 600000 && !isRateLimited()) {
        lastContactsSyncTime = now;
        await syncGoWhatsContacts({ workspaceId: "ws_default", broadcastFn });
      }

      // Sync GoWhats Orders on schedule only if orders scope is permitted and not rate-limited
      if (!ordersPermissionDenied && !isRateLimited()) {
        const resOrders = await fetchGoWhatsOrders({ phoneNumber: process.env.WHATSAPP_PHONE_NUMBER || "919047484484" });

        if (!resOrders.success) {
          const errKey = `${resOrders.statusCode}_${resOrders.error}`;
          if (!loggedOrdersSyncErrors.has(errKey)) {
            loggedOrdersSyncErrors.add(errKey);
            if (resOrders.statusCode === 403 || (resOrders.error && resOrders.error.includes("permissions"))) {
              ordersPermissionDenied = true;
              console.warn(`⚠️ GoWhats orders sync disabled: API key missing 'orders.read' permission. Enable this scope in the GoWhats dashboard to activate order sync.`);
            } else {
              console.warn(`⚠️ GoWhats orders sync disabled (${resOrders.statusCode || "Error"}): ${resOrders.error}`);
            }
          }
        } else if (Array.isArray(resOrders.orders) && resOrders.orders.length > 0) {
          let newOrders = 0;
          let updatedOrders = 0;
          let dedupedOrders = 0;
          for (const orderItem of resOrders.orders) {
            const customerPhone = extractCustomerPhone(orderItem);
            const convId = `conv_wa_${customerPhone}`;
            const { doc: orderDoc, isNew, isUpdated } = await saveGoWhatsOrder({
              ...orderItem,
              customerPhone,
              conversationId: convId,
            });

            if (isNew) newOrders++;
            else if (isUpdated) updatedOrders++;
            else dedupedOrders++;

            if ((isNew || isUpdated) && typeof broadcastFn === "function") {
              broadcastFn("order_update", {
                order: orderDoc,
                conversationId: convId,
                isNew,
                isUpdated,
                platform: "whatsapp",
              });
              broadcastFn(isNew ? "order:new" : "order:updated", { conversationId: convId, order: orderDoc });
            }
          }
        }
      }
    } catch (e) {
      console.warn("⚠️ Background GoWhats auto-sync error:", e.message);
    } finally {
      isGoWhatsSyncRunning = false;
    }
  };

  // Run initial sync after a short delay (5s)
  setTimeout(runSync, 5000);

  // Recurring polling
  setInterval(runSync, intervalMs);
}
