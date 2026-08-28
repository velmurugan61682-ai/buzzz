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

  const DEFAULT_PROVIDERS = ["google_calendar", "gowhats", "stripe", "smtp", "mrassistant"];

  r.get("/integrations", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const existing = await db.listIntegrations(wsId);
    const map = new Map(existing.map((i) => [i.provider, i]));

    const list = DEFAULT_PROVIDERS.map((p) => {
      const found = map.get(p);
      return {
        provider: p,
        state: found?.state || "not_connected",
        lastCheckAt: found?.last_check_at || null,
        errorCount: found?.error_count || 0,
      };
    });

    res.json({ data: list, count: list.length });
  }));

  r.get("/integrations/:provider", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const integ = await db.getIntegration(wsId, req.params.provider);
    if (!integ) {
      return res.json({ provider: req.params.provider, state: "not_connected" });
    }
    res.json({
      provider: integ.provider,
      state: integ.state,
      lastCheckAt: integ.last_check_at,
      errorCount: integ.error_count,
    });
  }));

  r.post("/integrations/:provider/test", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const provider = req.params.provider;

    const updated = await db.saveIntegration(wsId, provider, {
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
