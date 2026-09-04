/**
 * Production Billing & Subscriptions Routes.
 *
 * REST endpoints for Stripe checkout sessions, customer portal, subscription
 * status inspection, and webhook processing.
 */

import { Router } from "express";
import { createCheckoutSession, createPortalSession, processStripeWebhookEvent } from "../lib/billing.js";
import { getWorkspacePlan } from "../lib/entitlements.js";

export function billingRoutes({ db }) {
  const r = Router();

  const handle = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      next(e);
    }
  };

  const getWorkspaceId = (req) => {
    const wsId = req.workspace?.id || req.auth?.workspaceId || req.headers["x-workspace-id"];
    if (!wsId) {
      const err = new Error("Workspace context is required");
      err.status = 400;
      throw err;
    }
    return wsId;
  };

  r.get("/billing/subscription", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const sub = await db.getSubscription(wsId);
    const plan = await getWorkspacePlan(db, wsId);
    res.json({
      subscription: sub || { plan: "free", status: "active" },
      plan,
    });
  }));

  r.post("/billing/checkout", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { plan, cycle = "monthly", successUrl, cancelUrl } = req.body || {};
    const session = await createCheckoutSession({
      workspaceId: wsId,
      plan,
      cycle,
      successUrl,
      cancelUrl,
    });
    res.json(session);
  }));

  r.post("/billing/portal", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { returnUrl } = req.body || {};
    const portal = await createPortalSession({
      workspaceId: wsId,
      returnUrl,
    });
    res.json(portal);
  }));

  r.post("/billing/cancel", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const updated = await db.saveSubscription(wsId, {
      plan: "free",
      status: "canceled",
    });
    res.json({ ok: true, subscription: updated });
  }));

  r.post("/webhooks/stripe", handle(async (req, res) => {
    const event = req.body;
    const result = await processStripeWebhookEvent(db, event);
    res.json(result);
  }));

  return r;
}
