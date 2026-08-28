/**
 * GoWhats WhatsApp Adapter Tests.
 */
import crypto from "node:crypto";
import {
  verifyGoWhatsWebhookSignature,
  normalizeGoWhatsEvent,
  sendGoWhatsMessage,
  getGoWhatsCapabilities,
} from "./gowhats.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

/* 1. Capabilities */
const caps = getGoWhatsCapabilities();
ok(caps.channel === "whatsapp", "reports whatsapp channel");
ok(caps.sendText === true && caps.sendImage === true, "reports supported media types");

/* 2. Webhook Signature Verification */
const secret = "test_webhook_secret_key_123456";
const payload = { event: "message.received", from: "+1234567890", text: "Hello BUZZZ" };
const rawBody = JSON.stringify(payload);
const validSig = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

ok(verifyGoWhatsWebhookSignature(rawBody, validSig, secret) === true, "verifies valid signature");
ok(verifyGoWhatsWebhookSignature(rawBody, `sha256=${validSig}`, secret) === true, "verifies sha256= prefixed signature");
ok(verifyGoWhatsWebhookSignature(rawBody, "invalid_signature_hash", secret) === false, "rejects invalid signature");
ok(verifyGoWhatsWebhookSignature(rawBody, "", secret) === false, "rejects missing signature");

/* 3. Event Normalization */
// Inbound message
const normMsg = normalizeGoWhatsEvent({
  id: "gw_msg_001",
  from: "+1555987654",
  name: "Jane Doe",
  text: "Need support with my account",
});
ok(normMsg.type === "message", "normalizes as message");
ok(normMsg.direction === "inbound", "normalizes as inbound direction");
ok(normMsg.from === "+1555987654", "extracts sender number");
ok(normMsg.body === "Need support with my account", "extracts text body");

// Status update
const normStatus = normalizeGoWhatsEvent({
  event: "message.status",
  message_id: "gw_msg_001",
  status: "delivered",
});
ok(normStatus.type === "status_update", "normalizes status update event");
ok(normStatus.status === "delivered", "extracts delivery status");

/* 4. Outbound Sending (Mocked fetch) */
let requestedUrl = "";
let requestedBody = null;
const fakeFetch = async (url, opts) => {
  requestedUrl = url;
  requestedBody = JSON.parse(opts.body);
  return {
    ok: true,
    json: async () => ({ id: "gw_out_999", status: "sent" }),
  };
};

const sendRes = await sendGoWhatsMessage(
  { to: "+1555987654", body: "Hello from BUZZZ!" },
  { baseUrl: "https://api.gowhats.example.com", apiKey: "gw_key_abc", fetchFn: fakeFetch }
);
ok(sendRes.ok === true, "send message succeeds");
ok(sendRes.providerMessageId === "gw_out_999", "returns provider message ID");
ok(requestedUrl === "https://api.gowhats.example.com/api/v1/messages/send", "hits correct API endpoint");
ok(requestedBody.to === "+1555987654", "passes recipient phone");

console.log(fails ? `gowhats client: ${fails} FAILED` : "gowhats client: all checks passed");
process.exit(fails ? 1 : 0);
