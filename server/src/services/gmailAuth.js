import {
  saveGoogleAccount,
  getGoogleAccount,
  upsertContact,
  fetchContacts,
  resolveOrCreateContact,
  upsertConversation,
  saveMessage,
  saveUnifiedMessage,
} from "../data/db.js";

/**
 * Redacts tokens, passwords, and client secrets from logs or error messages
 * to prevent leaking sensitive credentials in logs.
 */
export function sanitizeMessage(msg) {
  if (!msg) return "";
  const str = typeof msg === "object" ? JSON.stringify(msg) : String(msg);
  return str
    .replace(/(GOCSPX-[a-zA-Z0-9_-]{10,})/g, "[REDACTED_CLIENT_SECRET]")
    .replace(/(ya29\.[a-zA-Z0-9_-]{20,})/g, "[REDACTED_ACCESS_TOKEN]")
    .replace(/(1\/\/[a-zA-Z0-9_-]{20,})/g, "[REDACTED_REFRESH_TOKEN]")
    .replace(/access_token=([^&]+)/gi, "access_token=[REDACTED]")
    .replace(/refresh_token=([^&]+)/gi, "refresh_token=[REDACTED]")
    .replace(/client_secret=([^&]+)/gi, "client_secret=[REDACTED]");
}

/**
 * Refreshes an expired Google access_token using the stored refresh_token.
 */
export async function refreshGoogleAccessToken(account) {
  if (!account || !account.refreshToken) {
    throw new Error("No refresh_token available for Google account. Re-authentication required.");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET missing in environment variables.");
  }

  console.log(`🔄 Attempting to refresh Google access_token for ${account.email}...`);

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: account.refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    const errType = data.error || "refresh_failed";
    const errDesc = data.error_description || "Failed to refresh Google token";
    console.error(`❌ Token refresh error (${errType}): ${sanitizeMessage(errDesc)}`);
    throw new Error(`Google token refresh failed [${errType}]: ${errDesc}`);
  }

  const expiresIn = data.expires_in || 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  const newAccessToken = data.access_token;
  const newRefreshToken = data.refresh_token || account.refreshToken;

  const updatedAccount = await saveGoogleAccount({
    workspaceId: account.workspaceId || "ws_default",
    googleId: account.googleId,
    name: account.name,
    email: account.email,
    picture: account.picture,
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    expiresAt,
    needsReauth: false,
    isRevoked: false,
  });

  console.log(`✅ Access token refreshed successfully for ${account.email}. Expires at ${expiresAt.toISOString()}`);
  return updatedAccount;
}

/**
 * Gets a valid Google account with an active (non-expired) access token.
 * Auto-refreshes if token is expired or expiring within 5 minutes.
 */
export async function getValidGoogleAccount(workspaceId = "ws_default") {
  const account = await getGoogleAccount(workspaceId);
  if (!account || !account.accessToken) {
    return null;
  }

  const expiresTime = new Date(account.expiresAt).getTime();
  const bufferMs = 5 * 60 * 1000; // 5 minute safety buffer

  if (Date.now() + bufferMs >= expiresTime || account.needsReauth || account.isRevoked) {
    if (account.refreshToken) {
      try {
        return await refreshGoogleAccessToken(account);
      } catch (err) {
        if (err.message.includes("invalid_grant") || err.message.includes("expired or revoked")) {
          await saveGoogleAccount({ ...account, needsReauth: true, isRevoked: true });
          console.warn(`⚠️ Google account ${account.email} re-authentication required (token revoked). Auto-refresh paused.`);
        } else {
          console.warn(`⚠️ Failed auto-refresh for ${account.email}: ${sanitizeMessage(err.message)}`);
        }
        return { ...account, isExpired: true, needsReauth: true };
      }
    } else {
      return { ...account, isExpired: true, needsReauth: true };
    }
  }

  return { ...account, isExpired: false };
}

/**
 * Verifies Gmail API profile to confirm 100% token validity
 */
export async function verifyGmailConnection(workspaceId = "ws_default") {
  const account = await getGoogleAccount(workspaceId);
  if (!account || !account.accessToken) {
    return { connected: false, reason: "No Google account connected" };
  }

  let activeAccount = account;
  const expiresTime = new Date(account.expiresAt).getTime();
  if (Date.now() >= expiresTime - 60000 || account.needsReauth || account.isRevoked) {
    if (account.refreshToken) {
      try {
        activeAccount = await refreshGoogleAccessToken(account);
      } catch (e) {
        if (e.message.includes("invalid_grant") || e.message.includes("expired or revoked")) {
          await saveGoogleAccount({ ...account, needsReauth: true, isRevoked: true });
          return { connected: false, expired: true, needsReauth: true, error: "Google access token has been revoked or expired. Re-authentication required." };
        }
        console.warn("⚠️ Token refresh warning in verifyGmailConnection:", sanitizeMessage(e.message));
      }
    }
  }

  try {
    const profileRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${activeAccount.accessToken}` },
    });

    const profileData = await profileRes.json().catch(() => ({}));

    if (profileRes.ok && profileData.emailAddress) {
      if (account.needsReauth || account.isRevoked) {
        await saveGoogleAccount({
          ...account,
          accessToken: activeAccount.accessToken,
          expiresAt: activeAccount.expiresAt,
          needsReauth: false,
          isRevoked: false,
        });
      }
      return {
        connected: true,
        verified: true,
        email: profileData.emailAddress,
        messagesTotal: profileData.messagesTotal,
        threadsTotal: profileData.threadsTotal,
        historyId: profileData.historyId,
        name: activeAccount.name,
        picture: activeAccount.picture,
        expiresAt: activeAccount.expiresAt,
      };
    } else {
      const errMsg = profileData.error?.message || `HTTP ${profileRes.status}`;
      return {
        connected: false,
        verified: false,
        error: sanitizeMessage(errMsg),
        email: activeAccount.email,
      };
    }
  } catch (err) {
    return {
      connected: false,
      verified: false,
      error: sanitizeMessage(err.message),
    };
  }
}

/**
 * Helper to parse name and email from RFC 822 header format like "John Doe <john@example.com>" or "john@example.com"
 */
function parseEmailHeader(headerVal) {
  if (!headerVal) return { name: "", email: "" };
  const match = headerVal.match(/(.*?)\s*<([^>]+)>/);
  if (match) {
    const name = match[1].replace(/^["']|["']$/g, "").trim();
    const email = match[2].trim().toLowerCase();
    return { name: name || email.split("@")[0], email };
  }
  const email = headerVal.trim().toLowerCase();
  return { name: email.split("@")[0], email };
}

/**
 * Syncs/fetches recent emails from Gmail API and ingests them into MongoDB & Unified Inbox.
 */
export async function syncGmailMessages(workspaceId = "ws_default", broadcastFn = null, options = {}) {
  const { limit = 50, fetchAll = false } = (typeof options === "object" && options !== null) ? options : {};
  const validAccount = await getValidGoogleAccount(workspaceId);
  if (!validAccount || !validAccount.accessToken) {
    return {
      connected: false,
      reason: "No active Google account connected for workspace",
    };
  }

  if (validAccount.isExpired || validAccount.needsReauth) {
    return {
      connected: false,
      expired: true,
      reason: "Google access token expired or revoked; re-authentication required",
    };
  }

  try {
    let allMessageStubs = [];
    let pageToken = null;
    const maxToFetch = fetchAll ? Math.max(limit, 150) : Math.min(limit, 50);

    do {
      const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
      const pageSize = Math.min(maxToFetch - allMessageStubs.length, 50);
      const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${pageSize}${pageParam}`, {
        headers: { Authorization: `Bearer ${validAccount.accessToken}` },
      });

      const listData = await listRes.json().catch(() => ({}));

      if (!listRes.ok) {
        const errMsg = listData.error?.message || `HTTP ${listRes.status}`;
        console.warn(`⚠️ Gmail API fetch messages failed: ${sanitizeMessage(errMsg)}`);
        if (allMessageStubs.length === 0) {
          return { connected: true, error: sanitizeMessage(errMsg) };
        }
        break;
      }

      const pageMessages = listData.messages || [];
      allMessageStubs.push(...pageMessages);
      pageToken = listData.nextPageToken || null;
    } while (fetchAll && pageToken && allMessageStubs.length < maxToFetch);

    const messages = allMessageStubs;
    if (messages.length === 0) {
      return { connected: true, count: 0, totalChecked: 0, syncedAt: new Date().toISOString() };
    }

    let newCount = 0;
    const syncedAt = new Date().toISOString();

    const BATCH_SIZE = 8;
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (m) => {
          try {
            const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`, {
              headers: { Authorization: `Bearer ${validAccount.accessToken}` },
            });

            const detail = await detailRes.json().catch(() => ({}));
            if (!detailRes.ok || !detail.id) return;

            const headers = detail.payload?.headers || [];
            const getHeader = (name) => headers.find((h) => h.name && h.name.toLowerCase() === name.toLowerCase())?.value || "";

            const fromVal = getHeader("From");
            const toVal = getHeader("To");
            const subject = getHeader("Subject") || "No Subject";
            const snippet = detail.snippet || "";
            const internalDate = detail.internalDate ? new Date(parseInt(detail.internalDate, 10)) : new Date();

            const fromObj = parseEmailHeader(fromVal);
            const toObj = parseEmailHeader(toVal);

            const accountEmail = String(validAccount.email || "").toLowerCase();
            const isOutbound = fromObj.email.toLowerCase() === accountEmail;

            const customerEmail = isOutbound ? toObj.email : fromObj.email;
            const customerName = isOutbound ? (toObj.name || toObj.email) : (fromObj.name || fromObj.email);

            if (!customerEmail) return;

            // Auto-upsert Contact if inbound customer message
            if (!isOutbound) {
              const contacts = await fetchContacts(workspaceId);
              const existingContact = contacts.find((c) => c.email && c.email.toLowerCase() === customerEmail);
              if (!existingContact) {
                await upsertContact({
                  id: `cnt_gmail_${customerEmail.replace(/[^a-zA-Z0-9]/g, "_")}`,
                  workspaceId,
                  name: customerName,
                  email: customerEmail,
                  source: "Gmail Ingestion",
                  stage: "New Lead",
                  status: "Lead",
                  channels: ["email"],
                  tags: ["Gmail", "Email"],
                });
              }
            }

            const convId = `conv_gmail_${detail.threadId}`;
            const summaryText = subject ? `Subject: ${subject} — ${snippet}` : snippet;

            const convDoc = {
              id: convId,
              workspaceId,
              customerName,
              channel: "Email",
              platform: "gmail",
              phone: customerEmail,
              email: customerEmail,
              unreadCount: isOutbound ? 0 : 1,
              lastMessage: summaryText,
              updatedAt: internalDate.toISOString(),
            };
            const conv = await upsertConversation(convDoc);

            const fullText = subject ? `Subject: ${subject}\n\n${snippet}` : snippet;

            const { doc: msgDoc, isNew } = await saveUnifiedMessage({
              id: `msg_gmail_${detail.id}`,
              workspaceId,
              conversationId: conv.id,
              integrationId: "gmail",
              platform: "gmail",
              externalMessageId: detail.id,
              sender: {
                name: isOutbound ? validAccount.name || "Agent" : customerName,
                email: isOutbound ? accountEmail : customerEmail,
                kind: isOutbound ? "agent" : "customer",
              },
              direction: isOutbound ? "outbound" : "inbound",
              text: fullText,
              status: "received",
              receivedAt: internalDate,
            });

            if (isNew) {
              newCount++;
              try {
                await saveMessage({
                  id: msgDoc.id,
                  conversationId: conv.id,
                  sender: isOutbound ? "agent" : "customer",
                  text: fullText,
                  timestamp: internalDate.toISOString(),
                  status: "received",
                });
              } catch (e) {
                // Legacy db non-fatal catch
              }

              if (broadcastFn && typeof broadcastFn === "function") {
                broadcastFn("new_message", {
                  message: msgDoc,
                  conversation: conv,
                  platform: "gmail",
                });
                broadcastFn("message:new", { conversation: conv, message: msgDoc });
              }
            }
          } catch (itemErr) {
            console.warn(`⚠️ Error processing Gmail message detail item: ${sanitizeMessage(itemErr.message)}`);
          }
        })
      );
    }

    if (newCount > 0) {
      console.log(`📩 [GMAIL AUTO-SYNC] Synced ${messages.length} email(s) from ${validAccount.email} (${newCount} new, ${messages.length - newCount} duplicate(s) skipped).`);
    }

    return {
      success: true,
      connected: true,
      count: newCount,
      totalChecked: messages.length,
      syncedAt,
    };
  } catch (err) {
    const safeMsg = sanitizeMessage(err.message);
    console.error("❌ Gmail Message Sync Error:", safeMsg);
    return { connected: false, error: safeMsg };
  }
}

let isGmailSyncRunning = false;

/**
 * Sends an email via Gmail API
 */
export async function sendGmailMessage({ to, subject = "Message from BUZZZ", text, threadId, workspaceId = "ws_default" }) {
  const validAccount = await getValidGoogleAccount(workspaceId);
  if (!validAccount || !validAccount.accessToken) {
    throw new Error("No active Google account connected for sending email.");
  }
  const fromEmail = validAccount.email;
  const rawEmail = [
    `From: ${fromEmail}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `MIME-Version: 1.0`,
    "",
    text,
  ].join("\r\n");

  const base64EncodedEmail = Buffer.from(rawEmail)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const body = { raw: base64EncodedEmail };
  if (threadId && !String(threadId).includes("sim")) {
    body.threadId = threadId;
  }

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${validAccount.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.threadId) {
      console.warn("⚠️ Send failed with threadId, retrying without threadId...");
      delete body.threadId;
      const retryRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validAccount.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const retryData = await retryRes.json().catch(() => ({}));
      if (retryRes.ok) {
        console.log(`✅ Outbound email sent successfully via Gmail API (fallback without threadId) to ${to} (id: ${retryData.id})`);
        return { success: true, id: retryData.id, threadId: retryData.threadId };
      }
    }
    const errMsg = data.error?.message || `HTTP ${res.status}`;
    console.error("❌ Gmail Send API Error:", errMsg);
    throw new Error(errMsg);
  }
  console.log(`✅ Outbound email sent successfully via Gmail API to ${to} (id: ${data.id})`);
  return { success: true, id: data.id, threadId: data.threadId };
}

export function startGmailMessagesAutoSyncScheduler(broadcastFn, intervalMs = 30000) {
  console.log(`⏰ Initializing Gmail background email sync scheduler (polling every ${intervalMs / 1000}s)...`);
  setInterval(async () => {
    if (isGmailSyncRunning) return;
    isGmailSyncRunning = true;
    try {
      await syncGmailMessages("ws_default", broadcastFn);
    } catch (e) {
      console.warn("⚠️ Background Gmail auto-sync error:", sanitizeMessage(e.message));
    } finally {
      isGmailSyncRunning = false;
    }
  }, intervalMs);
}

/**
 * Fetches connections/contacts from Google People API
 */
export async function fetchGooglePeopleContacts(workspaceId = "ws_default") {
  const validAccount = await getValidGoogleAccount(workspaceId);
  if (!validAccount || !validAccount.accessToken) {
    return {
      connected: false,
      error: "no_account",
      message: "No Google account connected. Please connect your Google account first.",
    };
  }

  if (validAccount.isExpired || validAccount.needsReauth) {
    return {
      connected: false,
      error: "token_expired",
      message: "Google access token expired. Re-authentication required.",
    };
  }

  try {
    const url = "https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers&pageSize=100";
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${validAccount.accessToken}` },
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const status = response.status;
      const errorObj = data.error || {};
      const message = errorObj.message || `HTTP ${status}`;
      const statusReason = errorObj.status || "";

      if (status === 403 || statusReason === "PERMISSION_DENIED") {
        if (
          message.includes("API has not been used") ||
          message.includes("disabled") ||
          message.includes("ACCESS_NOT_CONFIGURED") ||
          message.includes("SERVICE_DISABLED") ||
          message.includes("not enabled") ||
          message.includes("People API")
        ) {
          console.warn(`⚠️ Google People API not yet enabled or propagating: ${sanitizeMessage(message)}`);
          return {
            connected: false,
            state: "Needs attention",
            error: "people_api_disabled",
            message: "Google People API is not yet enabled in Google Cloud Console or propagation delay. Please enable People API or click 'Retry Sync' in a few minutes.",
            email: validAccount.email,
          };
        }
        if (message.includes("scope") || message.includes("permission") || message.includes("insufficient")) {
          console.warn(`⚠️ Google Contacts API insufficient scope error: ${sanitizeMessage(message)}`);
          return {
            connected: false,
            state: "Needs attention",
            error: "insufficient_scope",
            message: "Contacts API permission scope not granted. Please re-authorize Google account with contacts permission.",
            email: validAccount.email,
            reauthUrl: "/api/google/auth",
          };
        }
        return {
          connected: false,
          state: "Needs attention",
          error: "people_api_error",
          message: `Google People API Error: ${sanitizeMessage(message)}`,
          email: validAccount.email,
        };
      }

      if (status === 429 || statusReason === "RESOURCE_EXHAUSTED") {
        console.warn("⚠️ Google Contacts API rate limit reached (429)");
        return {
          connected: true,
          error: "rate_limit",
          message: "Google Contacts API rate limit reached. Please try again later.",
          email: validAccount.email,
        };
      }

      return {
        connected: false,
        state: "Needs attention",
        error: "api_error",
        message: sanitizeMessage(message),
        email: validAccount.email,
      };
    }

    const connections = data.connections || [];
    const formatted = connections.map((person) => {
      const googleContactId = person.resourceName || `people/${Date.now()}`;
      const name = person.names?.[0]?.displayName || person.names?.[0]?.givenName || "Unnamed Contact";
      const email = person.emailAddresses?.[0]?.value || "";
      const phone = person.phoneNumbers?.[0]?.value || "";

      return {
        id: googleContactId.replace("people/", "gc_"),
        googleContactId,
        name,
        email,
        phone,
        source: "Google Contacts",
        synced_at: new Date().toISOString(),
      };
    });

    return {
      connected: true,
      verified: true,
      count: formatted.length,
      contacts: formatted,
      email: validAccount.email,
    };
  } catch (err) {
    return {
      connected: false,
      error: "network_error",
      message: sanitizeMessage(err.message),
    };
  }
}

/**
 * Fetches contacts from Google People API and syncs/saves them to DB
 */
export async function syncGooglePeopleContacts(workspaceId = "ws_default") {
  const result = await fetchGooglePeopleContacts(workspaceId);

  if (!result.connected || result.error) {
    return result;
  }

  const syncedAt = new Date().toISOString();
  let syncedCount = 0;

  for (const c of result.contacts) {
    if (c.name || c.email || c.phone) {
      await upsertContact({
        id: c.id,
        workspaceId,
        name: c.name,
        email: c.email,
        phone: c.phone,
        source: "Google Contacts",
        stage: "Lead",
        status: "Synced",
        channels: [c.phone ? "whatsapp" : "email"].filter(Boolean),
        synced_at: syncedAt,
      });
      syncedCount++;
    }
  }

  console.log(`✅ Synced ${syncedCount} Google Contacts for workspace ${workspaceId}`);
  return {
    success: true,
    connected: true,
    count: syncedCount,
    syncedAt,
    contacts: result.contacts,
  };
}

/**
 * Background scheduler to auto-sync Google Contacts (delta via syncToken).
 * Uses importGoogleContacts() from contacts.js for full pagination + syncToken support.
 * Falls back to the legacy syncGooglePeopleContacts() if contacts.js isn't importable.
 */
export function startGoogleContactsAutoSyncScheduler(intervalMs = 86400000) {
  console.log(`⏰ Initializing Google Contacts background delta-sync scheduler (every ${intervalMs / 1000}s)...`);
  setInterval(async () => {
    try {
      console.log("🔄 [GOOGLE CONTACTS SCHEDULER] Running delta-sync...");
      // Lazy import to avoid circular dep at module load time
      const { importGoogleContacts } = await import("./contacts.js");
      const result = await importGoogleContacts("ws_default");
      if (result.success) {
        console.log(`✅ [GOOGLE CONTACTS SCHEDULER] imported=${result.imported} skipped=${result.skipped} errors=${result.errors}`);
      } else {
        console.warn("⚠️ [GOOGLE CONTACTS SCHEDULER] Sync returned error:", sanitizeMessage(result.message));
      }
    } catch (e) {
      console.warn("⚠️ [GOOGLE CONTACTS SCHEDULER] Error:", sanitizeMessage(e.message));
    }
  }, intervalMs);
}

