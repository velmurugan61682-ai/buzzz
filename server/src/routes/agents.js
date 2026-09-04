/**
 * Production AI Agent & Copilot Routes.
 *
 * Provides REST endpoints for Agent CRUD, Builder configuration, Versioning,
 * Execution Testing, Copilot suggestions, and Tool catalogs.
 */

import { Router } from "express";
import { executeAgent, AGENT_TOOLS, generateCopilotSuggestions } from "../lib/agent-runtime.js";

export function agentRoutes({ db, broadcast = () => {} }) {
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

  /* =========================================================================
     TOOL CATALOG
     ========================================================================= */

  r.get("/agents/tools/catalog", (req, res) => {
    const tools = Object.entries(AGENT_TOOLS).map(([id, t]) => ({
      id,
      name: t.name,
      description: t.description,
      permission: t.permission,
    }));
    res.json({ data: tools, count: tools.length });
  });

  /* =========================================================================
     AGENT CRUD
     ========================================================================= */

  r.get("/agents", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const agents = await db.listAgents(wsId);
    res.json({ data: agents, count: agents.length });
  }));

  r.post("/agents", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { name, title, type = "support", autonomy = 1, role, purpose, instructions, tone, channels = [], tools = [], guardrails = [] } = req.body || {};

    if (!name) return res.status(400).json({ code: "invalid_input", message: "Agent name is required." });

    const agent = await db.createAgent(wsId, {
      name,
      title,
      type,
      status: "draft",
      autonomy,
      role,
      purpose,
      instructions,
      tone,
      channels,
      tools,
      guardrails,
      createdBy: req.auth?.userId,
    });

    // Create initial v1 version snapshot
    await db.createAgentVersion(agent.id, agent, req.auth?.userId);

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "agent.created",
      targetType: "agent",
      targetId: agent.id,
      detail: { name, type, autonomy },
    });

    res.status(201).json({ agent });
  }));

  r.get("/agents/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const agent = await db.getAgent(wsId, req.params.id);
    if (!agent) return res.status(404).json({ code: "not_found", message: "Agent not found." });
    res.json({ agent });
  }));

  r.patch("/agents/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const updated = await db.updateAgent(wsId, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ code: "not_found", message: "Agent not found." });

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "agent.updated",
      targetType: "agent",
      targetId: updated.id,
      detail: { patchKeys: Object.keys(req.body || {}) },
    });

    res.json({ agent: updated });
  }));

  r.delete("/agents/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const del = await db.deleteAgent(wsId, req.params.id);
    if (!del) return res.status(404).json({ code: "not_found", message: "Agent not found." });

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "agent.deleted",
      targetType: "agent",
      targetId: req.params.id,
    });

    res.json({ ok: true, id: req.params.id });
  }));

  r.post("/agents/:id/duplicate", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const orig = await db.getAgent(wsId, req.params.id);
    if (!orig) return res.status(404).json({ code: "not_found", message: "Agent not found." });

    const dup = await db.createAgent(wsId, {
      ...orig,
      name: `${orig.name} (Copy)`,
      status: "draft",
      createdBy: req.auth?.userId,
    });

    await db.createAgentVersion(dup.id, dup, req.auth?.userId);

    res.status(201).json({ agent: dup });
  }));

  /* =========================================================================
     AGENT VERSIONING & PUBLISHING
     ========================================================================= */

  r.get("/agents/:id/versions", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const agent = await db.getAgent(wsId, req.params.id);
    if (!agent) return res.status(404).json({ code: "not_found", message: "Agent not found." });

    const versions = await db.listAgentVersions(req.params.id);
    res.json({ data: versions, count: versions.length });
  }));

  r.post("/agents/:id/publish", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const agent = await db.getAgent(wsId, req.params.id);
    if (!agent) return res.status(404).json({ code: "not_found", message: "Agent not found." });

    const updated = await db.updateAgent(wsId, req.params.id, { status: "active" });
    const version = await db.createAgentVersion(agent.id, updated, req.auth?.userId);

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "agent.published",
      targetType: "agent",
      targetId: agent.id,
      detail: { versionId: version?.id },
    });

    res.json({ ok: true, agent: updated, version });
  }));

  r.post("/agents/:id/pause", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const updated = await db.updateAgent(wsId, req.params.id, { status: "paused" });
    if (!updated) return res.status(404).json({ code: "not_found", message: "Agent not found." });

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "agent.paused",
      targetType: "agent",
      targetId: req.params.id,
    });

    res.json({ ok: true, agent: updated });
  }));

  r.post("/agents/:id/rollback", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { versionId } = req.body || {};
    if (!versionId) return res.status(400).json({ code: "invalid_input", message: "versionId is required." });

    const version = await db.getAgentVersion(req.params.id, versionId);
    if (!version) return res.status(404).json({ code: "not_found", message: "Version snapshot not found." });

    const snapshot = typeof version.snapshot === "string" ? JSON.parse(version.snapshot) : version.snapshot;
    const updated = await db.updateAgent(wsId, req.params.id, {
      name: snapshot.name,
      role: snapshot.role,
      instructions: snapshot.instructions,
      tools: snapshot.tools,
      channels: snapshot.channels,
      autonomy: snapshot.autonomy,
    });

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "agent.rolled_back",
      targetType: "agent",
      targetId: req.params.id,
      detail: { versionId },
    });

    res.json({ ok: true, agent: updated });
  }));

  /* =========================================================================
     AGENT TESTING & EXECUTION
     ========================================================================= */

  r.post("/agents/:id/test", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const agent = await db.getAgent(wsId, req.params.id);
    if (!agent) return res.status(404).json({ code: "not_found", message: "Agent not found." });

    const { message, context = {} } = req.body || {};
    if (!message) return res.status(400).json({ code: "invalid_input", message: "Test message is required." });

    const execution = await executeAgent({
      db,
      workspaceId: wsId,
      agent,
      message,
      context,
      broadcast,
    });

    res.json(execution);
  }));

  /* =========================================================================
     COPILOT SUGGESTIONS
     ========================================================================= */

  r.post("/copilot/suggestions", handle(async (req, res) => {
    const { lastMessage = "", customer = null } = req.body || {};
    const suggestions = generateCopilotSuggestions({ lastMessage, customer });
    res.json({ suggestions });
  }));

  return r;
}
