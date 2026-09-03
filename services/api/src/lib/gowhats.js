/**
 * Meta WhatsApp Cloud API — Channel Adapter.
 *
 * Handles outbound message dispatch via Meta's WhatsApp Cloud API
 * (graph.facebook.com), webhook signature validation, payload
 * normalisation, and full error mapping.
 *
 * Provider-agnostic design: the function signature and config shape are
 * identical to what a GoWhats (api.gowhats.in) adapter would require.
 * Swapping the underlying provider only requires changing:
 *   - baseUrl   (e.g. "https://graph.facebook.com/v20.0" → "https://api.gowhats.in/v1")
 *   - phoneNumberId (Meta-specific; GoWhats uses account_external_id)
 *   - The body shape built inside sendWhatsAppMessage()
 * No call site in lib/inbox.js needs to change.
 *
 * IMPORTANT — Token type note:
 * Meta distinguishes between:
 *   - Temporary User Access Token (~60 days): fine for development
 *   - Permanent System User Access Token: required for production
 * Before going live, create a System User in Meta Business Suite →
 * Business Settings → System Users, generate a token with scopes
 * whatsapp_business_messaging + whatsapp_business_management, and
 * store it via PUT /api/v1/integrations/gowhats with the phone number ID.
 */

import crypto from "node:crypto";
import { openCredential } from "./credential-store.js";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class GoWhatsError extends Error {
  /**
   * @param {string} code     - Machine-readable internal error code (never contains raw provider text)
   * @param {string} message  - Human-readable message (safe for logs; NOT for frontend responses)
   * @param {number} status   - HTTP status code to return to the caller
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name   = "GoWhatsError";
    this.code   = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Returns the static capability map for this channel adapter.
 * Call sites use this to decide which message types are available
 * without coupling to implementation details.
 */
export function getGoWhatsCapabilities() {
  return {
    channel:        "whatsapp",
    provider:       "meta_cloud_api", // will become "gowhats" once api.gowhats.in is live
    sendText:       true,
    sendImage:      true,
    sendVideo:      true,
    sendDocument:   true,
    sendTemplate:   true,
    reactions:      true,
    editing:        false,
    deletion:       true,
  };
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

/**
 * Verifies the HMAC-SHA256 signature of an incoming WhatsApp webhook from Meta.
 * Meta sends the signature in the X-Hub-Signature-256 header as "sha256=<hex>".
 *
 * @param {string|Buffer} payload   - Raw request body (string or Buffer)
 * @param {string}        signature - Value of X-Hub-Signature-256 header
 * @param {string}        secret    - App secret / webhook verify token
 * @returns {boolean}
 */
export function verifyGoWhatsWebhookSignature(payload, signature, secret) {
  if (!secret)    return true;  // no secret configured → skip in development
  if (!signature) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(typeof payload === "string" ? payload : JSON.stringify(payload))
    .digest("hex");

  const sig = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ---------------------------------------------------------------------------
// Webhook payload normalisation
// ---------------------------------------------------------------------------

/**
 * Normalises raw Meta Cloud API webhook payloads into the standard Buzzz
 * messaging event envelope.  The normalised shape is provider-agnostic so
 * inbox.js never imports anything Meta-specific.
 *
 * Meta webhook shape reference:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 *
 * @param {object} payload - Parsed JSON body from the webhook POST
 * @returns {{ type: string, ... }}
 */
export function normalizeGoWhatsEvent(payload) {
  if (!payload || typeof payload !== "object") {
    throw new GoWhatsError("invalid_payload", "Payload must be a JSON object");
  }

  // Meta Cloud API wraps events inside entry[].changes[]
  const entry   = payload.entry?.[0];
  const changes = entry?.changes?.[0];
  const value   = changes?.value;

  // ---- Status update (delivered / read / failed) --------------------------
  if (value?.statuses?.length) {
    const s = value.statuses[0];
    return {
      type:              "status_update",
      providerMessageId: s.id,
      status:            s.status,   // "sent" | "delivered" | "read" | "failed"
      error:             s.errors?.[0] || null,
      timestamp:         s.timestamp
        ? new Date(Number(s.timestamp) * 1000).toISOString()
        : new Date().toISOString(),
    };
  }

  // ---- Legacy GoWhats / generic shape (for non-Meta providers later) ------
  if (payload.event === "message.status" || payload.status) {
    return {
      type:              "status_update",
      providerMessageId: payload.message_id || payload.provider_message_id || payload.id,
      status:            payload.status,
      error:             payload.error || null,
      timestamp:         payload.timestamp
        ? new Date(payload.timestamp).toISOString()
        : new Date().toISOString(),
    };
  }

  // ---- Inbound message — Meta Cloud API shape -----------------------------
  if (value?.messages?.length) {
    const msg = value.messages[0];
    const contact = value.contacts?.[0];
    const from    = String(msg.from || "").trim();
    const body    = msg.text?.body || msg.caption || "";
    let   media   = null;
    if (msg.image)    media = { type: "image",    id: msg.image.id,    mimeType: msg.image.mime_type };
    if (msg.video)    media = { type: "video",    id: msg.video.id,    mimeType: msg.video.mime_type };
    if (msg.document) media = { type: "document", id: msg.document.id, mimeType: msg.document.mime_type, filename: msg.document.filename };
    if (msg.audio)    media = { type: "audio",    id: msg.audio.id,    mimeType: msg.audio.mime_type };

    return {
      type:              "message",
      direction:         "inbound",
      providerMessageId: msg.id || `meta_${Date.now()}`,
      from,
      author:            contact?.profile?.name || from || "WhatsApp User",
      body,
      media,
      isAiGenerated:     false,
      timestamp:         msg.timestamp
        ? new Date(Number(msg.timestamp) * 1000).toISOString()
        : new Date().toISOString(),
    };
  }

  // ---- Legacy GoWhats / generic inbound shape -----------------------------
  const msg = payload.message || payload;
  const from = String(msg.from || msg.sender || msg.phone || "").trim();
  const body = msg.body || msg.text || (typeof msg.content === "string" ? msg.content : "") || "";
  const providerMessageId = msg.id || msg.message_id || msg.provider_message_id || `gw_${Date.now()}`;

  return {
    type:              "message",
    direction:         "inbound",
    providerMessageId,
    from,
    author:            msg.name || from || "WhatsApp User",
    body,
    media:             msg.media || (msg.image_url ? { type: "image", url: msg.image_url } : null),
    isAiGenerated:     false,
    timestamp:         msg.timestamp
      ? new Date(msg.timestamp).toISOString()
      : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Meta error code → internal error code mapping
// ---------------------------------------------------------------------------

/**
 * Maps a Meta Graph API error object to the appropriate GoWhatsError.
 * Raw Meta error messages and fbtrace_id are intentionally swallowed here
 * and must never be forwarded to the frontend.
 *
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 *
 * @param {object} metaError - The error object from Meta's JSON response
 * @param {number} httpStatus - HTTP status code of the response
 * @returns {GoWhatsError}
 */
function mapMetaError(metaError, httpStatus) {
  const code    = metaError?.code;
  const subcode = metaError?.error_subcode;

  // Auth errors
  if (code === 190 || code === 102 || code === 10) {
    return new GoWhatsError(
      "auth_error",
      "WhatsApp token is invalid, expired, or the Meta App has been deleted. " +
      "Provide a valid System User token via the integration settings.",
      401,
    );
  }

  // Template not approved / not found
  if (code === 131030 || (code === 100 && subcode === 2388023)) {
    return new GoWhatsError(
      "template_not_approved",
      "The specified message template is not approved or does not exist for this WhatsApp Business Account.",
      422,
    );
  }

  // Invalid recipient (phone number)
  if (code === 131026 || code === 131021) {
    return new GoWhatsError(
      "invalid_recipient",
      "The recipient phone number is not a valid WhatsApp account.",
      422,
    );
  }

  // Rate limiting
  if (httpStatus === 429 || code === 131056 || code === 80007) {
    return new GoWhatsError(
      "rate_limited",
      "WhatsApp API rate limit reached. The message will be retried.",
      429,
    );
  }

  // Malformed payload / business policy errors
  if (httpStatus >= 400 && httpStatus < 500) {
    return new GoWhatsError(
      "invalid_payload",
      "The message could not be sent due to a request validation error.",
      400,
    );
  }

  // Provider-side 5xx
  return new GoWhatsError(
    "provider_unavailable",
    "The WhatsApp Cloud API is temporarily unavailable. Please retry.",
    502,
  );
}

// ---------------------------------------------------------------------------
// Outbound message dispatch — Meta WhatsApp Cloud API
// ---------------------------------------------------------------------------

/**
 * Builds the request body for the Meta Cloud API.
 *
 * Sending options (pick one per call):
 *   - template: { name, languageCode, components? }   → HSM template message
 *   - body (string):                                   → free-form text (within 24h window)
 *   - media:  { type: "image"|"video"|"document", url } → media message
 *
 * @private
 */
function buildMetaPayload({ to, body, media, template }) {
  const base = { messaging_product: "whatsapp", to };

  if (template) {
    return {
      ...base,
      type: "template",
      template: {
        name:     template.name,
        language: { code: template.languageCode || "en_US" },
        components: template.components || [],
      },
    };
  }

  if (media) {
    return {
      ...base,
      type:          media.type,                    // "image" | "video" | "document" | "audio"
      [media.type]:  { link: media.url, caption: body || undefined },
    };
  }

  return {
    ...base,
    type: "text",
    text: { body, preview_url: false },
  };
}

/**
 * Sends an outbound WhatsApp message via Meta's WhatsApp Cloud API.
 *
 * Config shape is intentionally compatible with a future GoWhats adapter;
 * only `baseUrl` and `phoneNumberId` differ between providers.
 *
 * @param {{ to: string, body?: string, media?: object, template?: object }} msg
 * @param {{
 *   baseUrl:       string,   // e.g. "https://graph.facebook.com/v20.0"
 *   phoneNumberId: string,   // Meta WhatsApp Phone Number ID
 *   apiKey:        string,   // Decrypted bearer token (never the sealed value)
 *   fetchFn?:      function, // injectable for unit tests only
 * }} config
 * @returns {Promise<{ ok: true, providerMessageId: string, status: string }>}
 * @throws {GoWhatsError}
 */
export async function sendGoWhatsMessage(
  { to, body, media = null, template = null },
  { baseUrl, phoneNumberId, apiKey, fetchFn = globalThis.fetch },
) {
  // ---- Input validation ---------------------------------------------------
  if (!to) {
    throw new GoWhatsError("invalid_recipient", "Recipient phone number is required");
  }
  if (!body && !media && !template) {
    throw new GoWhatsError("empty_message", "Message body, media, or template is required");
  }

  // ---- Configuration guard — no silent fallback ---------------------------
  //
  // CRITICAL: this block previously returned a SIMULATED SUCCESS when
  // baseUrl or apiKey were missing.  That masked misconfiguration silently.
  // It has been removed entirely.  An unconfigured adapter is a hard error.
  //
  if (!baseUrl) {
    throw new GoWhatsError(
      "configuration_error",
      "WhatsApp adapter is not configured: baseUrl is missing. " +
      "Set WHATSAPP_BASE_URL or configure the integration via PUT /api/v1/integrations/gowhats.",
      500,
    );
  }
  if (!phoneNumberId) {
    throw new GoWhatsError(
      "configuration_error",
      "WhatsApp adapter is not configured: phoneNumberId is missing. " +
      "Set WHATSAPP_PHONE_NUMBER_ID or configure the integration via PUT /api/v1/integrations/gowhats.",
      500,
    );
  }
  if (!apiKey) {
    throw new GoWhatsError(
      "configuration_error",
      "WhatsApp adapter is not configured: API token is missing. " +
      "Store a valid Meta System User token via PUT /api/v1/integrations/gowhats.",
      500,
    );
  }

  // ---- Build and send request ---------------------------------------------
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/${phoneNumberId}/messages`;
  const reqBody  = buildMetaPayload({ to, body, media, template });

  const res = await fetchFn(endpoint, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(reqBody),
  });

  // ---- Parse response -----------------------------------------------------
  let resBody = {};
  try {
    resBody = await res.json();
  } catch {
    // Non-JSON response (network error, unexpected proxy page, etc.)
    if (!res.ok) {
      throw new GoWhatsError(
        "provider_unavailable",
        "WhatsApp Cloud API returned an unreadable response.",
        502,
      );
    }
  }

  // ---- Map errors ---------------------------------------------------------
  if (!res.ok) {
    // resBody.error is Meta's standard error envelope
    throw mapMetaError(resBody?.error, res.status);
  }

  // ---- Success ------------------------------------------------------------
  // Meta success shape: { messaging_product: "whatsapp", contacts: [...], messages: [{ id }] }
  const messageId = resBody.messages?.[0]?.id || `meta_out_${Date.now()}`;
  return {
    ok:                true,
    providerMessageId: messageId,
    status:            "sent",
  };
}

// ---------------------------------------------------------------------------
// Credential-store-aware wrapper (used by inbox.js and integrations.js)
// ---------------------------------------------------------------------------

/**
 * Loads the sealed token from the integration DB row, decrypts it, and
 * calls sendGoWhatsMessage().  This is the function that call sites should
 * use — it is the boundary between the credential store and the API adapter.
 *
 * @param {{ to, body, media, template }} msg
 * @param {{
 *   workspaceId:   string,
 *   db:            object,   // db handle from createDb()
 *   credentialKey: string,   // CREDENTIAL_ENCRYPTION_KEY (hex)
 *   baseUrl:       string,
 *   phoneNumberId: string,
 *   fetchFn?:      function,
 * }} ctx
 */
export async function sendWhatsAppMessageFromStore(msg, ctx) {
  const { workspaceId, db, credentialKey, baseUrl, phoneNumberId, fetchFn } = ctx;

  // Load from the integrations table
  const integ = await db.getIntegration(workspaceId, "gowhats");
  if (!integ || !integ.credential_ref) {
    throw new GoWhatsError(
      "configuration_error",
      "WhatsApp integration is not connected. Configure it via the Integrations settings.",
      500,
    );
  }

  // Decrypt at call time — the sealed value never leaves this scope as plaintext
  const apiKey = openCredential(integ.credential_ref, credentialKey);

  // NOTE: apiKey is intentionally NOT logged. The log line below only
  // confirms successful decryption without revealing the secret.
  console.info(
    `[gowhats] credential decrypted for workspace=${workspaceId} ` +
    `integration_id=${integ.id || "n/a"} — proceeding with send`,
  );

  return sendGoWhatsMessage(msg, { baseUrl, phoneNumberId, apiKey, fetchFn });
}
