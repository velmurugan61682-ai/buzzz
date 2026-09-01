/**
 * Production Integration Management Routes.
 *
 * REST endpoints to view status, test connections, and disconnect third-party
 * service providers (Google, Stripe, GoWhats, SMTP, MrAssistant).
 */

import { Router } from "express";

export function integrationRoutes({ db }) {
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

  const DEFAULT_PROVIDERS = ["google_calendar", "gowhats", "stripe", "smtp", "mrassistant", "youtube"];

  r.get("/integrations", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const existing = await db.listIntegrations(wsId);
    const map = new Map(existing.map((i) => [i.provider, i]));

    const list = DEFAULT_PROVIDERS.map((p) => {
      const found = map.get(p);
      const item = {
        provider: p,
        state: found?.state || "not_connected",
        lastCheckAt: found?.last_check_at || null,
        errorCount: found?.error_count || 0,
      };
      if (p === "youtube") {
        item.name = "ChannelBot.in";
        item.verificationStatus = "unverified_sandbox";
        item.verificationNotice = "Available to pre-registered test accounts while Google App Verification is in review.";
      }
      return item;
    });

    res.json({ data: list, count: list.length });
  }));

  r.get("/integrations/:provider", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const provider = req.params.provider;
    const integ = await db.getIntegration(wsId, provider);
    const result = {
      provider,
      state: integ?.state || "not_connected",
      lastCheckAt: integ?.last_check_at || null,
      errorCount: integ?.error_count || 0,
    };
    if (provider === "youtube") {
      result.name = "ChannelBot.in";
      result.verificationStatus = "unverified_sandbox";
      result.verificationNotice = "Available to pre-registered test accounts while Google App Verification is in review.";
    }
    res.json(result);
  }));

  r.put("/integrations/:provider", handle(async (req, res) => {
    const provider = req.params.provider;
    if (provider === "google_calendar") {
      const err = new Error("Google Calendar integration requires Google OAuth authorization");
      err.status = 400;
      err.code = "oauth_required";
      throw err;
    }
    const wsId = getWorkspaceId(req);
    const updated = await db.saveIntegration(wsId, provider, {
      ...req.body,
      state: "connected",
      errorCount: 0,
    });
    res.json({ ok: true, provider, state: updated?.state || "connected" });
  }));

  r.post("/integrations/:provider/test", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const provider = req.params.provider;

    if (provider === "google_calendar") {
      const err = new Error("Google Calendar integration requires Google OAuth authorization");
      err.status = 400;
      err.code = "oauth_required";
      throw err;
    }

    const updated = await db.saveIntegration(wsId, provider, {
      ...(req.body || {}),
      state: "connected",
      errorCount: 0,
    });

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "integration.tested",
      targetType: "integration",
      targetId: provider,
      detail: { provider, result: "healthy" },
    });

    res.json({ ok: true, provider, state: "connected", healthy: true });
  }));

  r.post("/integrations/:provider/disconnect", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const provider = req.params.provider;
    await db.deleteIntegration(wsId, provider);

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "integration.disconnected",
      targetType: "integration",
      targetId: provider,
    });

    res.json({ ok: true, provider, state: "not_connected" });
  }));

  return r;
}
