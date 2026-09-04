/**
 * WhatsApp Cloud API Integration Service for BUZZZ Platform.
 *
 * Uses Meta Graph API to send WhatsApp messages and manage business accounts.
 * Environment variables: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_BUSINESS_ACCOUNT_ID, WHATSAPP_API_VERSION.
 */

export const isWhatsAppConfigured = () => {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  return Boolean(token && phoneId && verifyToken);
};

export const getWhatsAppConfigStatus = () => {
  return {
    configured: isWhatsAppConfigured(),
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || null,
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || null,
    phoneNumber: process.env.WHATSAPP_PHONE_NUMBER || null,
    apiVersion: process.env.WHATSAPP_API_VERSION || "v20.0",
    webhookVerifyConfigured: Boolean(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN),
  };
};

export const sendWhatsAppMessage = async ({ to, text }) => {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const version = process.env.WHATSAPP_API_VERSION || "v20.0";

  if (!token || !phoneId) {
    throw new Error("WhatsApp Cloud API credentials not configured (missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID)");
  }

  // Format destination phone number (remove + or non-numeric characters)
  const cleanTo = String(to).replace(/\D/g, "");

  const url = `https://graph.facebook.com/${version}/${phoneId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: cleanTo,
    type: "text",
    text: { body: text },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMsg = data.error?.message || `WhatsApp API error HTTP ${response.status}`;
    // Strip any possible token from error message for security
    const safeMsg = errorMsg.replace(token, "[REDACTED_TOKEN]");
    throw new Error(safeMsg);
  }

  // Return the WhatsApp message id from response (data.messages[0].id)
  const whatsappMessageId = data.messages?.[0]?.id || null;
  return {
    whatsappMessageId,
    raw: data,
  };
};
