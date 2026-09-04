/**
 * Production Visual Workflow Routes.
 *
 * REST endpoints for Workflows CRUD, Graph editing, Version publishing,
 * Node Catalog, Execution Testing, and Run log inspection.
 */

import { Router } from "express";
import { executeWorkflow, validateWorkflowGraph, NODE_CATALOG } from "../lib/workflow-engine.js";

export function workflowRoutes({ db, broadcast = () => {} }) {
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
     NODE CATALOG
     ========================================================================= */

  r.get("/workflow-node-catalog", (req, res) => {
    const catalog = Object.entries(NODE_CATALOG).map(([id, n]) => ({
      id,
      name: n.name,
      category: n.category,
      type: n.type,
    }));
    res.json({ data: catalog, count: catalog.length });
  });

  /* =========================================================================
     WORKFLOW CRUD
     ========================================================================= */

  r.get("/workflows", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const workflows = await db.listWorkflows(wsId);
    res.json({ data: workflows, count: workflows.length });
  }));

  r.post("/workflows", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { name, description, nodes = [], edges = [], variables = [], settings = {} } = req.body || {};

    if (!name) return res.status(400).json({ code: "invalid_input", message: "Workflow name is required." });

    const workflow = await db.createWorkflow(wsId, {
      name,
      description,
      status: "draft",
      nodes,
      edges,
      variables,
      settings,
      createdBy: req.auth?.userId,
    });

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "workflow.created",
      targetType: "workflow",
      targetId: workflow.id,
      detail: { name },
    });

    res.status(201).json({ workflow });
  }));

  r.get("/workflows/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const workflow = await db.getWorkflow(wsId, req.params.id);
    if (!workflow) return res.status(404).json({ code: "not_found", message: "Workflow not found." });
    res.json({ workflow });
  }));

  r.patch("/workflows/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const updated = await db.updateWorkflow(wsId, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ code: "not_found", message: "Workflow not found." });
    res.json({ workflow: updated });
  }));

  r.delete("/workflows/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const del = await db.deleteWorkflow(wsId, req.params.id);
    if (!del) return res.status(404).json({ code: "not_found", message: "Workflow not found." });
    res.json({ ok: true, id: req.params.id });
  }));

  r.post("/workflows/:id/duplicate", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const orig = await db.getWorkflow(wsId, req.params.id);
    if (!orig) return res.status(404).json({ code: "not_found", message: "Workflow not found." });

    const dup = await db.createWorkflow(wsId, {
      name: `${orig.name} (Copy)`,
      description: orig.description,
      nodes: typeof orig.nodes === "string" ? JSON.parse(orig.nodes) : orig.nodes,
      edges: typeof orig.edges === "string" ? JSON.parse(orig.edges) : orig.edges,
      variables: typeof orig.variables === "string" ? JSON.parse(orig.variables) : orig.variables,
      settings: typeof orig.settings === "string" ? JSON.parse(orig.settings) : orig.settings,
      createdBy: req.auth?.userId,
    });

    res.status(201).json({ workflow: dup });
  }));

  /* =========================================================================
     VALIDATION & PUBLISHING
     ========================================================================= */

  r.post("/workflows/:id/validate", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const workflow = await db.getWorkflow(wsId, req.params.id);
    if (!workflow) return res.status(404).json({ code: "not_found", message: "Workflow not found." });

    const validation = validateWorkflowGraph(workflow);
    res.json(validation);
  }));

  r.post("/workflows/:id/publish", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const workflow = await db.getWorkflow(wsId, req.params.id);
    if (!workflow) return res.status(404).json({ code: "not_found", message: "Workflow not found." });

    const validation = validateWorkflowGraph(workflow);
    if (!validation.valid) {
      return res.status(400).json({ code: "validation_failed", errors: validation.errors });
    }

    const nextVer = (workflow.current_version || 1) + 1;
    await db.createWorkflowVersion(workflow.id, nextVer, workflow, req.auth?.userId);
    const updated = await db.updateWorkflow(wsId, req.params.id, { status: "published", current_version: nextVer });

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "workflow.published",
      targetType: "workflow",
      targetId: workflow.id,
      detail: { version: nextVer },
    });

    res.json({ ok: true, workflow: updated });
  }));

  r.post("/workflows/:id/pause", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const updated = await db.updateWorkflow(wsId, req.params.id, { status: "paused" });
    if (!updated) return res.status(404).json({ code: "not_found", message: "Workflow not found." });
    res.json({ ok: true, workflow: updated });
  }));

  /* =========================================================================
     WORKFLOW EXECUTION TESTING
     ========================================================================= */

  r.post("/workflows/:id/test", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const workflow = await db.getWorkflow(wsId, req.params.id);
    if (!workflow) return res.status(404).json({ code: "not_found", message: "Workflow not found." });

    const { triggerPayload = {} } = req.body || {};
    const execution = await executeWorkflow({
      db,
      workspaceId: wsId,
      workflow,
      triggerPayload,
      isTest: true,
      broadcast,
    });

    res.json(execution);
  }));

  /* =========================================================================
     RUN LOGS & NODE EXECUTIONS
     ========================================================================= */

  r.get("/workflows/:id/runs", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const runs = await db.listWorkflowRuns(wsId, req.params.id);
    res.json({ data: runs, count: runs.length });
  }));

  r.get("/workflows/:id/runs/:runId", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const run = await db.getWorkflowRun(wsId, req.params.runId);
    if (!run) return res.status(404).json({ code: "not_found", message: "Workflow run not found." });
    res.json({ run });
  }));

  r.get("/workflows/:id/runs/:runId/nodes", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const run = await db.getWorkflowRun(wsId, req.params.runId);
    if (!run) return res.status(404).json({ code: "not_found", message: "Workflow run not found." });

    const nodeExecs = await db.listNodeExecutions(req.params.runId);
    res.json({ data: nodeExecs, count: nodeExecs.length });
  }));

  return r;
}
