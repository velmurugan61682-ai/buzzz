/**
 * gowhats.in Third-Party WhatsApp Gateway Integration Service.
 *
 * Environment variables:
 * - GOWHATS_API_KEY: Gateway API authorization token
 * - GOWHATS_BASE_URL: Gateway base URL (e.g. https://gowhats.in/api)
 * - GOWHATS_INSTANCE_ID: Instance / device ID (optional)
 * - GOWHATS_WEBHOOK_VERIFY_SECRET: Webhook verification shared secret
 */

export const isGoWhatsConfigured = () => {
  const apiKey = process.env.CHANNELBOT_API_KEY || process.env.GOWHATS_API_KEY;
  const baseUrl = process.env.CHANNELBOT_BASE_URL || process.env.GOWHATS_BASE_URL;
  return Boolean(apiKey && baseUrl);
};

export const getGoWhatsConfigStatus = () => {
  return {
    configured: isGoWhatsConfigured(),
    baseUrl: process.env.CHANNELBOT_BASE_URL || process.env.GOWHATS_BASE_URL || null,
    instanceIdConfigured: Boolean(process.env.CHANNELBOT_INSTANCE_ID || process.env.GOWHATS_INSTANCE_ID),
    webhookSecretConfigured: Boolean(process.env.CHANNELBOT_WEBHOOK_VERIFY_SECRET || process.env.GOWHATS_WEBHOOK_VERIFY_SECRET),
  };
};

/**
 * Outbound WhatsApp message sending function via channelbot.in / gowhats.in gateway.
 * Includes automatic retry-once-on-5xx logic.
 */
export const sendWhatsAppMessage = async ({ to, text }) => {
  const apiKey = process.env.CHANNELBOT_API_KEY || process.env.GOWHATS_API_KEY;
  const baseUrl = process.env.CHANNELBOT_BASE_URL || process.env.GOWHATS_BASE_URL;
  const instanceId = process.env.CHANNELBOT_INSTANCE_ID || process.env.GOWHATS_INSTANCE_ID;

  if (!apiKey || !baseUrl) {
    throw new Error("channelbot.in / gowhats.in gateway is not fully configured (missing API key or base URL)");
  }

  // Clean destination phone number (remove non-digits)
  const cleanTo = String(to).replace(/\D/g, "");

  // TODO_CONFIRM: Verify exact endpoint path (e.g. /send vs /send-message) from gowhats.in dashboard
  const endpoint = `${baseUrl.replace(/\/$/, "")}/send`;

  // TODO_CONFIRM: Verify exact JSON body shape (number vs to, message vs text, apikey vs token, instance_id)
  const payload = {
    number: cleanTo,
    message: text,
    apikey: apiKey,
    ...(instanceId ? { instance_id: instanceId } : {}),
  };

  const executeFetch = async () => {
    // TODO_CONFIRM: Verify exact HTTP headers (Authorization: Bearer token vs x-api-key vs JSON body apikey)
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));
    return { response, data };
  };

  let attempt = await executeFetch();

  // Step 3: Retry-once-on-5xx logic
  if (!attempt.response.ok && attempt.response.status >= 500) {
    console.warn(`⚠️ gowhats.in gateway returned status ${attempt.response.status}. Retrying in 1000ms...`);
    await new Promise((res) => setTimeout(res, 1000));
    attempt = await executeFetch();
  }

  if (!attempt.response.ok) {
    const errorMsg = attempt.data.message || attempt.data.error || `gowhats.in API error HTTP ${attempt.response.status}`;
    // Security: ensure API key is never leaked in thrown error
    const safeMsg = String(errorMsg).replace(apiKey, "[REDACTED_KEY]");
    throw new Error(safeMsg);
  }

  // TODO_CONFIRM: Verify exact message ID field in gowhats.in response (message_id vs id vs data.id)
  const gowhatsMessageId = attempt.data.message_id || attempt.data.id || attempt.data.data?.id || `gw_${Date.now()}`;

  return {
    gowhatsMessageId,
    raw: attempt.data,
  };
};
