/**
 * Unit Test Suite for Email Dispatcher & SMTP Transport
 */
import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import { sendEmail, EmailError, EMAIL_TEMPLATES } from "./email.js";
import { sealCredential } from "./credential-store.js";

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) {
    console.error("  FAIL:", msg);
    fails++;
  }
};

const credKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const wsId = "11111111-1111-1111-1111-111111111111";

class MockDb {
  constructor(integ = null) {
    this.integ = integ;
    this.notifications = [];
  }

  async getIntegration(workspaceId, provider) {
    if (provider === "smtp") return this.integ;
    return null;
  }

  async recordNotification(workspaceId, notif) {
    this.notifications.push({ workspaceId, ...notif });
    return { id: "notif_100", ...notif };
  }
}

async function runEmailTests() {
  console.log("=== Email Dispatcher & SMTP Transport Test Suite ===");

  /* 1. Missing recipient validation */
  let invalidRecipientError = false;
  try {
    await sendEmail({ to: "" });
  } catch (e) {
    if (e instanceof EmailError && e.code === "invalid_recipient") {
      invalidRecipientError = true;
    }
  }
  ok(invalidRecipientError, "throws EmailError on missing recipient");

  /* 2. Successful SMTP send with mock transport */
  const sealedPass = sealCredential("smtp_password_secret_123", credKey);
  const mockDb1 = new MockDb({
    id: "integ_smtp_1",
    credential_ref: sealedPass,
    config: { host: "smtp.mailtrap.io", port: 587, user: "user@buzzz.io", from: "noreply@buzzz.io" },
  });

  let sentMailOpts = null;
  const mockTransporter1 = {
    sendMail: async (opts) => {
      sentMailOpts = opts;
      return { messageId: "msg_999" };
    },
  };

  const res1 = await sendEmail({
    db: mockDb1,
    workspaceId: wsId,
    to: "test@client.com",
    template: "welcome",
    params: { name: "Alice" },
    credentialKey: credKey,
    transporterFn: mockTransporter1,
  });

  ok(res1.ok === true, "sendEmail returns ok: true on successful dispatch");
  ok(sentMailOpts.to === "test@client.com", "passes recipient to transport");
  ok(sentMailOpts.subject === EMAIL_TEMPLATES.welcome({ name: "Alice" }).subject, "formats template subject");
  ok(mockDb1.notifications.length === 1, "records notification in DB");
  ok(mockDb1.notifications[0].status === "delivered", "records notification status as delivered");

  /* 3. Transient error retry success */
  let attempts = 0;
  const mockTransporterTransient = {
    sendMail: async (opts) => {
      attempts++;
      if (attempts === 1) {
        const err = new Error("Connection reset by peer");
        err.code = "ECONNRESET";
        throw err;
      }
      return { messageId: "msg_retry_success" };
    },
  };

  const mockDb2 = new MockDb({
    id: "integ_smtp_2",
    credential_ref: sealedPass,
    config: { host: "smtp.mailtrap.io" },
  });

  const res2 = await sendEmail({
    db: mockDb2,
    workspaceId: wsId,
    to: "test@client.com",
    template: "appointment_reminder",
    credentialKey: credKey,
    transporterFn: mockTransporterTransient,
  });

  ok(res2.ok === true, "succeeds on transient retry");
  ok(attempts === 2, "attempted send twice on transient ECONNRESET error");
  ok(mockDb2.notifications[0].status === "delivered", "records status as delivered after successful retry");

  /* 4. Terminal SMTP failure records 'failed' status */
  const mockTransporterFatal = {
    sendMail: async () => {
      const err = new Error("Invalid Auth");
      err.code = "EAUTH";
      throw err;
    },
  };

  const mockDb3 = new MockDb({
    id: "integ_smtp_3",
    credential_ref: sealedPass,
    config: { host: "smtp.mailtrap.io" },
  });

  let caughtDeliveryErr = false;
  try {
    await sendEmail({
      db: mockDb3,
      workspaceId: wsId,
      to: "test@client.com",
      credentialKey: credKey,
      transporterFn: mockTransporterFatal,
    });
  } catch (e) {
    if (e instanceof EmailError && e.code === "delivery_failed") {
      caughtDeliveryErr = true;
    }
  }

  ok(caughtDeliveryErr, "throws EmailError on persistent send failure");
  ok(mockDb3.notifications.length === 1, "records notification in DB on failure");
  ok(mockDb3.notifications[0].status === "failed", "honestly records status as failed on SMTP error");

  console.log(fails ? `email client: ${fails} FAILED` : "email client: all checks passed");
  process.exit(fails ? 1 : 0);
}

runEmailTests().catch((err) => {
  console.error("email test suite FAILED:", err);
  process.exit(1);
});
