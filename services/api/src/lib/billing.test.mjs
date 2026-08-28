/**
 * Stripe Billing & Entitlements Unit Tests.
 */
import { createCheckoutSession, createPortalSession, processStripeWebhookEvent } from "./billing.js";
import { assertEntitlement, assertUsageLimit } from "./entitlements.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

const makeMockDb = () => {
  const store = {
    subscriptions: new Map(),
    billingEvents: [],
    usage: new Map(),
    audits: [],
  };

  return {
    getSubscription: async (wsId) => store.subscriptions.get(wsId) || null,
    saveSubscription: async (wsId, s) => {
      store.subscriptions.set(wsId, { workspace_id: wsId, ...s });
      return store.subscriptions.get(wsId);
    },
    recordBillingEvent: async (wsId, eventId, type, payload) => {
      store.billingEvents.push({ workspace_id: wsId, event_id: eventId, type, payload });
      return { ok: true };
    },
    getUsage: async (wsId, kind) => store.usage.get(`${wsId}_${kind}`) || 0,
    setUsage: (wsId, kind, val) => store.usage.set(`${wsId}_${kind}`, val),
    writeAudit: async (wsId, a) => {
      store.audits.push({ workspace_id: wsId, ...a });
      return { ok: true };
    },
  };
};

const db = makeMockDb();

/* 1. Checkout & Portal Sessions */
const session = await createCheckoutSession({
  workspaceId: "ws_alpha",
  plan: "pro",
  cycle: "monthly",
});
ok(session.sessionId && session.url.includes("cs_"), "creates checkout session");

const portal = await createPortalSession({
  workspaceId: "ws_alpha",
});
ok(portal.url.includes("billing"), "creates portal session");

/* 2. Stripe Webhook Processing (Idempotent) */
const webhookEvent = {
  id: "evt_test_123",
  type: "customer.subscription.updated",
  data: {
    object: {
      id: "sub_stripe_123",
      customer: "cus_123",
      metadata: { workspace_id: "ws_alpha", plan: "pro" },
      items: { data: [{ plan: { interval: "monthly" } }] },
      current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
    },
  },
};

const procRes = await processStripeWebhookEvent(db, webhookEvent);
ok(procRes.ok === true && procRes.processed === true, "processes stripe webhook");

const updatedSub = await db.getSubscription("ws_alpha");
ok(updatedSub.plan === "pro" && updatedSub.status === "active", "updates subscription state from webhook");

/* 3. Entitlements Verification */
let entOk = false;
try {
  await assertEntitlement(db, "ws_alpha", "copilot");
  entOk = true;
} catch (e) {}
ok(entOk === true, "allows copilot feature on pro plan");

/* 4. Plan Limits Enforcement */
db.setUsage("ws_alpha", "workflow_runs", 6000); // Exceeds Pro limit of 5000
let limitBlocked = false;
try {
  await assertUsageLimit(db, "ws_alpha", "workflow_runs");
} catch (err) {
  if (err.code === "usage_limit_exceeded") limitBlocked = true;
}
ok(limitBlocked === true, "enforces server-side monthly usage limit");

console.log(fails ? `billing: ${fails} FAILED` : "billing: all checks passed");
process.exit(fails ? 1 : 0);
