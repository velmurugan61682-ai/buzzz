/**
 * Meta WhatsApp Cloud API Adapter Tests.
 *
 * Tests the real adapter logic using injected fake fetch — no live API calls.
 * Updated to match the new function signatures (phoneNumberId required, Meta payload shape).
 */
import crypto from "node:crypto";
import {
  verifyGoWhatsWebhookSignature,
  normalizeGoWhatsEvent,
  sendGoWhatsMessage,
  getGoWhatsCapabilities,
  GoWhatsError,
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
const secret  = "test_webhook_secret_key_123456";
const payload = { event: "message.received", from: "+1234567890", text: "Hello BUZZZ" };
const rawBody = JSON.stringify(payload);
const validSig = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

ok(verifyGoWhatsWebhookSignature(rawBody, validSig, secret) === true, "verifies valid signature");
ok(verifyGoWhatsWebhookSignature(rawBody, `sha256=${validSig}`, secret) === true, "verifies sha256= prefixed signature");
ok(verifyGoWhatsWebhookSignature(rawBody, "invalid_signature_hash", secret) === false, "rejects invalid signature");
ok(verifyGoWhatsWebhookSignature(rawBody, "", secret) === false, "rejects missing signature");

/* 3. Event Normalization — legacy GoWhats shape */
const normMsg = normalizeGoWhatsEvent({
  id:   "gw_msg_001",
  from: "+1555987654",
  name: "Jane Doe",
  text: "Need support with my account",
});
ok(normMsg.type === "message",    "normalizes as message");
ok(normMsg.direction === "inbound", "normalizes as inbound direction");
ok(normMsg.from === "+1555987654",  "extracts sender number");
ok(normMsg.body === "Need support with my account", "extracts text body");

/* 3b. Event Normalization — Meta Cloud API shape */
const metaPayload = {
  entry: [{
    changes: [{
      value: {
        messages: [{
          id:        "wamid.HBgL123",
          from:      "919047484484",
          timestamp: "1700000000",
          text:      { body: "Hello from WhatsApp" },
        }],
        contacts: [{ profile: { name: "Test User" } }],
      },
    }],
  }],
};
const normMeta = normalizeGoWhatsEvent(metaPayload);
ok(normMeta.type === "message",             "Meta shape: normalizes as message");
ok(normMeta.direction === "inbound",        "Meta shape: normalizes as inbound");
ok(normMeta.from === "919047484484",        "Meta shape: extracts sender");
ok(normMeta.body === "Hello from WhatsApp", "Meta shape: extracts text body");
ok(normMeta.providerMessageId === "wamid.HBgL123", "Meta shape: extracts message ID");

/* 3c. Event Normalization — status update */
const normStatus = normalizeGoWhatsEvent({
  event:      "message.status",
  message_id: "gw_msg_001",
  status:     "delivered",
});
ok(normStatus.type === "status_update",  "normalizes status update event");
ok(normStatus.status === "delivered",    "extracts delivery status");

/* 4. Outbound Sending (Mocked fetch) — Meta payload shape */
let requestedUrl  = "";
let requestedBody = null;
let requestedHeaders = null;

const fakeFetch = async (url, opts) => {
  requestedUrl     = url;
  requestedBody    = JSON.parse(opts.body);
  requestedHeaders = opts.headers;
  return {
    ok:   true,
    json: async () => ({
      messaging_product: "whatsapp",
      contacts: [{ input: "+1555987654", wa_id: "15559876540" }],
      messages: [{ id: "wamid.HBgLtest999" }],
    }),
  };
};

const BASE   = "https://graph.facebook.com/v20.0";
const PHONE  = "987654321";
const KEY    = "gw_bearer_token_abc";

const sendRes = await sendGoWhatsMessage(
  { to: "+1555987654", body: "Hello from BUZZZ!" },
  { baseUrl: BASE, phoneNumberId: PHONE, apiKey: KEY, fetchFn: fakeFetch },
);
ok(sendRes.ok === true, "send message succeeds");
ok(sendRes.providerMessageId === "wamid.HBgLtest999", "returns provider message ID from Meta response");
ok(
  requestedUrl === `${BASE}/${PHONE}/messages`,
  `hits correct Meta endpoint: expected ${BASE}/${PHONE}/messages, got ${requestedUrl}`,
);
ok(requestedBody.to === "+1555987654",       "passes recipient phone in body");
ok(requestedBody.type === "text",            "sends as text type");
ok(requestedBody.messaging_product === "whatsapp", "sets messaging_product");
ok(requestedHeaders["Authorization"] === `Bearer ${KEY}`, "passes Authorization header");

/* 4b. Template message payload shape */
const fakeFetchTpl = async (url, opts) => ({
  ok:   true,
  json: async () => ({ messages: [{ id: "wamid.tpl001" }] }),
});

const tplRes = await sendGoWhatsMessage(
  { to: "+1555987654", template: { name: "hello_world", languageCode: "en_US" } },
  { baseUrl: BASE, phoneNumberId: PHONE, apiKey: KEY, fetchFn: fakeFetchTpl },
);
ok(tplRes.ok === true,                         "template send succeeds");
ok(tplRes.providerMessageId === "wamid.tpl001", "returns template message ID");

/* 5. Missing config throws configuration_error — no silent fallback */
let caughtConfigError = false;
try {
  await sendGoWhatsMessage(
    { to: "+1555987654", body: "test" },
    { baseUrl: BASE, phoneNumberId: "", apiKey: KEY, fetchFn: fakeFetch },
  );
} catch (e) {
  if (e instanceof GoWhatsError && e.code === "configuration_error") {
    caughtConfigError = true;
  }
}
ok(caughtConfigError, "throws configuration_error when phoneNumberId is missing (no silent mock fallback)");

let caughtMissingKey = false;
try {
  await sendGoWhatsMessage(
    { to: "+1555987654", body: "test" },
    { baseUrl: BASE, phoneNumberId: PHONE, apiKey: "", fetchFn: fakeFetch },
  );
} catch (e) {
  if (e instanceof GoWhatsError && e.code === "configuration_error") {
    caughtMissingKey = true;
  }
}
ok(caughtMissingKey, "throws configuration_error when apiKey is missing (no silent mock fallback)");

/* 6. Error mapping — auth_error from code 190 */
const fakeAuthFail = async () => ({
  ok:     false,
  status: 400,
  json:   async () => ({ error: { message: "App deleted", type: "OAuthException", code: 190 } }),
});
let caughtAuthError = false;
try {
  await sendGoWhatsMessage(
    { to: "+1555987654", body: "test" },
    { baseUrl: BASE, phoneNumberId: PHONE, apiKey: KEY, fetchFn: fakeAuthFail },
  );
} catch (e) {
  if (e instanceof GoWhatsError && e.code === "auth_error") {
    caughtAuthError = true;
  }
}
ok(caughtAuthError, "maps Meta error code 190 to internal auth_error");

/* 7. Error mapping — invalid_recipient from code 131026 */
const fakeInvalidRecipient = async () => ({
  ok:     false,
  status: 400,
  json:   async () => ({ error: { code: 131026, message: "Recipient not on WhatsApp" } }),
});
let caughtInvalidRecipient = false;
try {
  await sendGoWhatsMessage(
    { to: "123", body: "test" },
    { baseUrl: BASE, phoneNumberId: PHONE, apiKey: KEY, fetchFn: fakeInvalidRecipient },
  );
} catch (e) {
  if (e instanceof GoWhatsError && e.code === "invalid_recipient") {
    caughtInvalidRecipient = true;
  }
}
ok(caughtInvalidRecipient, "maps Meta error code 131026 to internal invalid_recipient");

/* 8. Error mapping — rate_limited from 429 */
const fakeRateLimit = async () => ({
  ok:     false,
  status: 429,
  json:   async () => ({ error: { code: 80007, message: "Rate limited" } }),
});
let caughtRateLimit = false;
try {
  await sendGoWhatsMessage(
    { to: "+1555987654", body: "test" },
    { baseUrl: BASE, phoneNumberId: PHONE, apiKey: KEY, fetchFn: fakeRateLimit },
  );
} catch (e) {
  if (e instanceof GoWhatsError && e.code === "rate_limited") {
    caughtRateLimit = true;
  }
}
ok(caughtRateLimit, "maps 429/rate limit to internal rate_limited error");

console.log(fails ? `gowhats client: ${fails} FAILED` : "gowhats client: all checks passed");
process.exit(fails ? 1 : 0);
