/**
 * Production Visual Workflow Automation Engine.
 *
 * Graph-based workflow execution runtime with modular node registry,
 * safe variable interpolation, condition evaluation, and execution logging.
 */

import { getAvailableSlots } from "./scheduling.js";
import { sendGoWhatsMessage } from "./gowhats.js";
import { executeAgent } from "./agent-runtime.js";

export class WorkflowError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Resolves template variables like {{contact.name}} or {{nodes.checkAvail.output.startsAt}}
 */
export function interpolateVariables(template, context) {
  if (typeof template !== "string") return template;
  return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const keys = path.trim().split(".");
    let current = context;
    for (const k of keys) {
      if (current === undefined || current === null) return "";
      current = current[k];
    }
    return current !== undefined && current !== null ? String(current) : "";
  });
}

/**
 * Safe expression evaluator for condition nodes.
 */
export function evaluateCondition(fieldValue, operator, targetValue) {
  const left = String(fieldValue ?? "").trim().toLowerCase();
  const right = String(targetValue ?? "").trim().toLowerCase();

  switch (operator) {
    case "equals":
    case "==":
      return left === right;
    case "not_equals":
    case "!=":
      return left !== right;
    case "contains":
      return left.includes(right);
    case "starts_with":
      return left.startsWith(right);
    case "ends_with":
      return left.endsWith(right);
    case "greater_than":
    case ">":
      return Number(fieldValue) > Number(targetValue);
    case "less_than":
    case "<":
      return Number(fieldValue) < Number(targetValue);
    case "exists":
      return fieldValue !== undefined && fieldValue !== null && fieldValue !== "";
    case "is_empty":
      return fieldValue === undefined || fieldValue === null || fieldValue === "";
    default:
      return left === right;
  }
}

/**
 * Node Catalog Registry.
 */
export const NODE_CATALOG = {
  // Triggers
  "trigger.manual": { name: "Manual Trigger", category: "Triggers", type: "trigger" },
  "trigger.webhook": { name: "Incoming Webhook", category: "Triggers", type: "trigger" },
  "trigger.whatsapp_message": { name: "Incoming WhatsApp", category: "Triggers", type: "trigger" },
  "trigger.lead_created": { name: "New Lead Created", category: "Triggers", type: "trigger" },
  "trigger.appointment_created": { name: "Appointment Created", category: "Triggers", type: "trigger" },

  // CRM Actions
  "action.crm_create_contact": {
    name: "Create Contact",
    category: "CRM",
    type: "action",
    handler: async (db, wsId, config, ctx) => {
      const name = interpolateVariables(config.name || "New Contact", ctx);
      const phone = interpolateVariables(config.phone || "", ctx);
      const email = interpolateVariables(config.email || "", ctx);
      return await db.createContact(wsId, { name, phone: phone || null, email: email || null, source: "workflow" });
    },
  },
  "action.crm_create_deal": {
    name: "Create Deal",
    category: "CRM",
    type: "action",
    handler: async (db, wsId, config, ctx) => {
      const name = interpolateVariables(config.name || "New Opportunity", ctx);
      const valueMinor = Number(config.valueMinor || 0);
      return await db.createDeal(wsId, { name, valueMinor, stage: config.stage || "Qualification" });
    },
  },
  "action.crm_create_task": {
    name: "Create Task",
    category: "CRM",
    type: "action",
    handler: async (db, wsId, config, ctx) => {
      const title = interpolateVariables(config.title || "Follow-up task", ctx);
      return await db.createTask(wsId, { title, priority: config.priority || "medium" });
    },
  },

  // Messaging Actions
  "action.send_whatsapp": {
    name: "Send WhatsApp",
    category: "Messaging",
    type: "action",
    handler: async (db, wsId, config, ctx) => {
      const to = interpolateVariables(config.to || ctx.contact?.phone || ctx.trigger?.phone || "", ctx);
      const body = interpolateVariables(config.body || "", ctx);
      const baseUrl = config.baseUrl || process.env.GOWHATS_BASE_URL || process.env.WHATSAPP_BASE_URL || "https://api.gowhats.in";
      const phoneNumberId = config.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || "910269858845190";
      const apiKey = config.apiKey || process.env.GOWHATS_API_KEY || process.env.WHATSAPP_TOKEN || "mock_api_key";
      const fetchFn = config.fetchFn || (async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.wf_${Date.now()}` }] }) }));
      return await sendGoWhatsMessage({ to, body }, { baseUrl, phoneNumberId, apiKey, fetchFn });
    },
  },
  "action.create_internal_note": {
    name: "Create Internal Note",
    category: "Messaging",
    type: "action",
    handler: async (db, wsId, config, ctx) => {
      const convId = config.conversationId || ctx.conversation?.id;
      const note = interpolateVariables(config.note || "", ctx);
      if (!convId) return { skipped: true, reason: "No conversation context" };
      return await db.createMessage(wsId, {
        conversationId: convId,
        direction: "outbound",
        author: "Workflow Engine",
        body: `[INTERNAL NOTE] ${note}`,
        deliveryStatus: "internal",
      });
    },
  },
  "action.escalate_to_human": {
    name: "Escalate to Human",
    category: "Messaging",
    type: "action",
    handler: async (db, wsId, config, ctx) => {
      const convId = config.conversationId || ctx.conversation?.id;
      if (!convId) return { skipped: true, reason: "No conversation context" };
      return await db.updateConversationState(wsId, convId, "escalated");
    },
  },

  // Appointment Actions
  "action.check_availability": {
    name: "Check Availability",
    category: "Appointments",
    type: "action",
    handler: async (db, wsId, config, ctx) => {
      const date = interpolateVariables(config.date || new Date().toISOString().slice(0, 10), ctx);
      return await getAvailableSlots(db, {
        workspaceId: wsId,
        serviceId: config.serviceId || null,
        staffId: config.staffId || null,
        date,
      });
    },
  },
  "action.create_appointment": {
    name: "Create Appointment",
    category: "Appointments",
    type: "action",
    handler: async (db, wsId, config, ctx) => {
      const startsAt = interpolateVariables(config.startsAt || ctx.nodes?.checkAvailability?.output?.availableSlots?.[0]?.startsAt || new Date().toISOString(), ctx);
      return await db.createAppointment(wsId, {
        contactId: config.contactId || ctx.contact?.id || null,
        serviceId: config.serviceId || null,
        staffId: config.staffId || null,
        startsAt,
        durationMinutes: Number(config.durationMinutes || 30),
        status: "confirmed",
        source: "workflow",
      });
    },
  },

  // AI Actions
  "action.run_ai_agent": {
    name: "Run AI Agent",
    category: "AI",
    type: "action",
    handler: async (db, wsId, config, ctx) => {
      let agent = null;
      if (config.agentId) {
        agent = await db.getAgent(wsId, config.agentId);
      }
      if (!agent) {
        agent = {
          id: "workflow_default_agent",
          name: "Workflow Assistant",
          role: "Automated Operator",
          tools: ["appointments.create_appointment", "crm.create_contact"],
        };
      }
      const prompt = interpolateVariables(config.prompt || ctx.trigger?.text || ctx.message?.body || "", ctx);
      return await executeAgent({
        db,
        workspaceId: wsId,
        agent,
        message: prompt,
        context: ctx,
      });
    },
  },

  // Logic & Conditions
  "condition.if_else": {
    name: "If / Else Condition",
    category: "Conditions",
    type: "condition",
    evaluator: (config, ctx) => {
      const val = interpolateVariables(config.field || "", ctx);
      const passed = evaluateCondition(val, config.operator || "equals", config.value);
      return passed ? "true" : "false";
    },
  },
  "condition.switch": {
    name: "Switch Branching",
    category: "Conditions",
    type: "condition",
    evaluator: (config, ctx) => {
      const val = interpolateVariables(config.field || "", ctx).toLowerCase();
      const cases = config.cases || [];
      const match = cases.find((c) => String(c.value).toLowerCase() === val);
      return match ? match.port || match.value : "default";
    },
  },

  // Utilities
  "utility.set_variable": {
    name: "Set Variable",
    category: "Utilities",
    type: "utility",
    handler: async (db, wsId, config, ctx) => {
      const key = config.key || "var";
      const val = interpolateVariables(config.value || "", ctx);
      return { [key]: val };
    },
  },
  "utility.delay": {
    name: "Delay",
    category: "Utilities",
    type: "utility",
    handler: async (db, wsId, config) => {
      return { delayedMs: Number(config.ms || 0) };
    },
  },
  "utility.http_request": {
    name: "HTTP Webhook / API Call",
    category: "Utilities",
    type: "utility",
    handler: async (db, wsId, config, ctx) => {
      const urlStr = interpolateVariables(config.url || "", ctx);
      if (!urlStr) throw new Error("URL is required for HTTP node");

      let parsedUrl;
      try {
        parsedUrl = new URL(urlStr);
      } catch {
        throw new Error(`Invalid URL: ${urlStr}`);
      }

      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error(`Forbidden URL protocol: ${parsedUrl.protocol}. Only http and https are allowed.`);
      }

      const host = parsedUrl.hostname.toLowerCase();
      const isPrivate =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host === "0.0.0.0" ||
        host === "169.254.169.254" ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
        /^169\.254\./.test(host);

      if (isPrivate) {
        throw new Error(`SSRF Blocked: Outbound requests to private/internal network address (${host}) are forbidden.`);
      }

      const method = (config.method || "GET").toUpperCase();
      const headers = config.headers || {};
      const body = config.body ? interpolateVariables(config.body, ctx) : undefined;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Number(config.timeoutMs || 5000));

      try {
        const res = await (config.fetchImpl || globalThis.fetch)(urlStr, {
          method,
          headers: { "Content-Type": "application/json", ...headers },
          body: method !== "GET" && method !== "HEAD" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
          signal: ctrl.signal,
        });
        const responseData = await res.json().catch(() => ({}));
        return { status: res.status, ok: res.ok, data: responseData };
      } finally {
        clearTimeout(timer);
      }
    },
  },
};

/**
 * Validates graph structure before publishing.
 */
export function validateWorkflowGraph(workflow) {
  const errors = [];
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];

  if (nodes.length === 0) {
    errors.push("Workflow must contain at least one node.");
    return { valid: false, errors };
  }

  // Must have at least one trigger node
  const hasTrigger = nodes.some((n) => n.type && n.type.startsWith("trigger."));
  if (!hasTrigger) {
    errors.push("Workflow must contain at least one trigger node.");
  }

  // Check valid connections
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const edge of edges) {
    if (!nodeIds.has(edge.sourceNodeId)) {
      errors.push(`Edge references missing source node: ${edge.sourceNodeId}`);
    }
    if (!nodeIds.has(edge.targetNodeId)) {
      errors.push(`Edge references missing target node: ${edge.targetNodeId}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Executes a workflow graph from start to end.
 */
export async function executeWorkflow({
  db,
  workspaceId,
  workflow,
  triggerPayload = {},
  isTest = false,
  broadcast = () => {},
}) {
  if (!workspaceId) throw new WorkflowError("invalid_workspace", "Workspace ID is required");
  if (!workflow) throw new WorkflowError("invalid_workflow", "Workflow is required");

  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];

  const triggerNode = nodes.find((n) => n.type && n.type.startsWith("trigger.")) || nodes[0];
  if (!triggerNode) {
    throw new WorkflowError("missing_trigger", "Workflow has no start trigger node.");
  }

  const runContext = {
    workspaceId,
    trigger: triggerPayload,
    variables: {},
    nodes: {},
  };

  // Create workflow run in database
  const run = await db.createWorkflowRun(workspaceId, {
    workflowId: workflow.id,
    version: workflow.current_version || 1,
    status: "running",
    context: runContext,
    isTest,
  });

  broadcast(workspaceId, "workflow.run.started", { runId: run.id, workflowId: workflow.id });

  const executedNodeIds = new Set();
  const nodeExecutions = [];
  let currentNode = triggerNode;
  const MAX_STEPS = 20;
  let step = 0;

  while (currentNode && step < MAX_STEPS) {
    step++;
    executedNodeIds.add(currentNode.id);
    const nodeDef = NODE_CATALOG[currentNode.type];
    let output = {};
    let branch = "default";
    const startTime = new Date().toISOString();

    try {
      if (nodeDef?.handler) {
        output = await nodeDef.handler(db, workspaceId, currentNode.config || {}, runContext);
      } else if (nodeDef?.evaluator) {
        branch = nodeDef.evaluator(currentNode.config || {}, runContext);
        output = { selectedBranch: branch };
      } else {
        output = { executed: true, timestamp: new Date().toISOString() };
      }

      runContext.nodes[currentNode.id] = { output, branch };
      if (currentNode.name) {
        runContext.nodes[currentNode.name] = { output, branch };
      }

      const execRecord = await db.recordNodeExecution(run.id, {
        nodeId: currentNode.id,
        nodeType: currentNode.type,
        status: "completed",
        branch,
        startedAt: startTime,
        finishedAt: new Date().toISOString(),
        input: currentNode.config,
        output,
      });
      nodeExecutions.push(execRecord);

      // Find next node following matching edge
      const matchingEdge = edges.find((e) => {
        if (e.sourceNodeId !== currentNode.id) return false;
        if (e.condition && e.condition !== branch) return false;
        if (e.sourcePort && e.sourcePort !== branch && e.sourcePort !== "default") return false;
        return true;
      });

      if (matchingEdge) {
        currentNode = nodes.find((n) => n.id === matchingEdge.targetNodeId);
      } else {
        currentNode = null; // Reached end of branch
      }
    } catch (err) {
      await db.recordNodeExecution(run.id, {
        nodeId: currentNode.id,
        nodeType: currentNode.type,
        status: "failed",
        note: err.message,
        startedAt: startTime,
        finishedAt: new Date().toISOString(),
      });
      await db.updateWorkflowRun(workspaceId, run.id, {
        status: "failed",
        error: err.message,
        finished_at: new Date().toISOString(),
      });
      broadcast(workspaceId, "workflow.run.failed", { runId: run.id, error: err.message });
      throw err;
    }
  }

  await db.updateWorkflowRun(workspaceId, run.id, {
    status: "completed",
    context: runContext,
    finished_at: new Date().toISOString(),
  });

  await db.writeAudit(workspaceId, {
    actorType: "workflow",
    actorId: workflow.id,
    action: "workflow.run.completed",
    targetType: "workflow_run",
    targetId: run.id,
    detail: { stepsExecuted: nodeExecutions.length, isTest },
  });

  broadcast(workspaceId, "workflow.run.completed", { runId: run.id, steps: nodeExecutions.length });

  return {
    ok: true,
    runId: run.id,
    status: "completed",
    context: runContext,
    nodeExecutions,
  };
}
