/**
 * Governance policy engine (server side).
 *
 * These are the SAME rules the app applies, kept in one file so BUZZZ AI,
 * agents, workflows, integrations and the public API all answer the authority
 * question identically. The web bundle carries a copy because it ships as a
 * single file; this module is the source of truth and the API enforces it
 * regardless of what any client believes.
 */
const ACTIONS = {
  CAN_READ_CRM:            { label: "Read CRM", min: 0, risk: "low", group: "CRM" },
  CAN_UPDATE_CONTACT:      { label: "Update contacts", min: 2, risk: "low", group: "CRM" },
  CAN_WRITE_CRM:           { label: "Create CRM records", min: 3, risk: "medium", group: "CRM" },
  CAN_DELETE_CRM:          { label: "Delete CRM records", min: 4, risk: "destructive", group: "CRM" },
  CAN_CREATE_DEAL:         { label: "Create deals", min: 4, risk: "medium", group: "Sales" },
  CAN_UPDATE_DEAL:         { label: "Move deals", min: 3, risk: "medium", group: "Sales" },
  CAN_CREATE_PAYMENT_LINK: { label: "Issue payment links", min: 4, risk: "high", group: "Sales" },
  CAN_SEND_WHATSAPP:       { label: "Send WhatsApp", min: 2, risk: "medium", group: "Messaging" },
  CAN_SEND_EMAIL:          { label: "Send email", min: 2, risk: "medium", group: "Messaging" },
  CAN_SEND_SMS:            { label: "Send SMS", min: 2, risk: "medium", group: "Messaging" },
  CAN_ASSIGN_CONVERSATION: { label: "Assign conversations", min: 2, risk: "low", group: "Messaging" },
  CAN_BOOK_APPOINTMENT:    { label: "Book appointments", min: 3, risk: "medium", group: "Scheduling" },
  CAN_CANCEL_APPOINTMENT:  { label: "Cancel appointments", min: 4, risk: "destructive", group: "Scheduling" },
  CAN_PLACE_CALL:          { label: "Place calls", min: 4, risk: "high", group: "Voice" },
  CAN_TRANSFER_CALL:       { label: "Transfer calls", min: 3, risk: "medium", group: "Voice" },
  CAN_POST_SOCIAL:         { label: "Publish social content", min: 4, risk: "high", group: "Social" },
  CAN_REPLY_SOCIAL:        { label: "Reply to comments", min: 2, risk: "medium", group: "Social" },
  CAN_CREATE_CAMPAIGN:     { label: "Create campaigns", min: 3, risk: "medium", group: "Campaigns" },
  CAN_START_CAMPAIGN:      { label: "Launch campaigns", min: 4, risk: "high", group: "Campaigns" },
  CAN_TRIGGER_WORKFLOW:    { label: "Trigger workflows", min: 3, risk: "medium", group: "Automation" },
  CAN_CREATE_TASK:         { label: "Create tasks", min: 2, risk: "low", group: "Automation" },
  CAN_ISSUE_REFUND:        { label: "Issue refunds", min: 4, risk: "destructive", group: "Support" },
  CAN_CREATE_TICKET:       { label: "Create tickets", min: 2, risk: "low", group: "Support" },
};
const RISK_TINT = { low: "bg-zinc-100 text-zinc-600 border-zinc-200", medium: "bg-sky-50 text-sky-700 border-sky-200", high: "bg-amber-50 text-amber-700 border-amber-200", destructive: "bg-red-50 text-red-700 border-red-200" };
/* the tool an action needs; no tool means no action, whatever the permission says */
const ACTION_TOOL = {
  CAN_READ_CRM: "CRM", CAN_UPDATE_CONTACT: "CRM", CAN_WRITE_CRM: "CRM", CAN_DELETE_CRM: "CRM",
  CAN_CREATE_DEAL: "CRM", CAN_UPDATE_DEAL: "CRM", CAN_CREATE_PAYMENT_LINK: "Payments",
  CAN_SEND_WHATSAPP: "GoWhats", CAN_SEND_EMAIL: "Gmail", CAN_SEND_SMS: "GoWhats", CAN_ASSIGN_CONVERSATION: "CRM",
  CAN_BOOK_APPOINTMENT: "Calendar", CAN_CANCEL_APPOINTMENT: "Calendar",
  CAN_PLACE_CALL: "MrAssistant.ai", CAN_TRANSFER_CALL: "MrAssistant.ai",
  CAN_POST_SOCIAL: "Publisher", CAN_REPLY_SOCIAL: "InstaxBot",
  CAN_CREATE_CAMPAIGN: "Campaigns", CAN_START_CAMPAIGN: "Campaigns",
  CAN_TRIGGER_WORKFLOW: "Workflows", CAN_CREATE_TASK: "CRM", CAN_ISSUE_REFUND: "Payments", CAN_CREATE_TICKET: "Ticketing",
};
const ALL_TOOLS = ["CRM", "Calendar", "Knowledge base", "Payments", "GoWhats", "InstaxBot", "Gmail", "MrAssistant.ai", "Ticketing", "Publisher", "Campaigns", "Workflows", "Analytics"];
const AGENT_CHANNELS = ["whatsapp", "instagram", "facebook", "email", "sms", "telegram", "voice", "webchat"];
const HANDOFF_TRIGGERS = ["Customer asks for a human", "Low confidence", "Complaint or anger", "Refund request", "Legal or compliance topic", "Repeated misunderstanding", "Guardrail blocked the reply", "Tool failure"];
const TONES = ["Professional", "Friendly", "Warm", "Concise", "Consultative", "Formal", "Casual", "Empathetic", "Confident"];
const AGENT_STATUS = ["Draft", "Active", "Paused", "Archived"];

/* ---- the gate every action passes through ---- */
const PROVIDER_BY_NAME = { "GoWhats": "gowhats", "WhatsApp": "gowhats", "InstaxBot": "instaxbot", "Instagram": "instaxbot",
  "MrAssistant.ai": "mrassistant", "Gmail": "gmail", "Google Calendar": "gcal", "Calendar": "gcal", "Google Business": "gbiz",
  "HubSpot": "hubspot", "Salesforce": "salesforce", "Calendly": "calendly", "Shopify": "shopify", "Stripe": "stripe",
  "Payments": "stripe", "Slack": "slack", "Zoom": "zoom", "Telegram": "telegram" };

function canAgentDo(agent, action, ctx = {}) {
  const spec = ACTIONS[action];
  const ceiling = ctx.ceiling !== undefined ? ctx.ceiling : 4;
  if (!spec) return { ok: false, why: "Unknown action.", code: "UNKNOWN" };
  if (!agent) return { ok: false, why: "No agent is assigned to this action.", code: "NO_AGENT" };
  if (agent.status === "Archived") return { ok: false, why: agent.name + " is archived.", code: "ARCHIVED" };
  if (agent.status !== "Active") return { ok: false, why: agent.name + " is " + agent.status.toLowerCase() + ", so it cannot act.", code: "INACTIVE" };
  if (!agent.perms || !agent.perms[action]) return { ok: false, why: agent.name + " does not have the " + spec.label.toLowerCase() + " permission.", code: "NO_PERMISSION" };
  const tool = ACTION_TOOL[action];
  if (tool && !(agent.tools || []).includes(tool)) return { ok: false, why: agent.name + " has not been given the " + tool + " tool, which this action needs.", code: "NO_TOOL" };
  if (tool && ctx.isConnected && (ctx.providerByName || {})[tool] && !ctx.isConnected((ctx.providerByName || {})[tool]))
    return { ok: false, why: tool + " is disconnected, so " + agent.name + " cannot use it right now. The permission is intact and returns when you reconnect.", code: "NO_INTEGRATION" };
  const effective = Math.min(agent.autonomy, ceiling);
  if (effective < spec.min) {
    const capped = agent.autonomy > ceiling;
    return { ok: false, needsApproval: effective >= spec.min - 1, code: "AUTONOMY",
      why: `${spec.label} needs autonomy Level ${spec.min}. ${agent.name} runs at Level ${effective}${capped ? ` (capped by the workspace ceiling of ${ceiling})` : ""}.` };
  }
  if (ctx.channel && (agent.channels || []).length && !agent.channels.includes(ctx.channel))
    return { ok: false, why: agent.name + " is not enabled on " + (ctx.channel) + ".", code: "NO_CHANNEL" };
  if (spec.risk === "destructive" && !(agent.allowDestructive))
    return { ok: false, needsApproval: true, code: "DESTRUCTIVE", why: spec.label + " is destructive, so it always waits for a human even at Level 4." };
  return { ok: true, why: `Allowed · Level ${effective} ≥ ${spec.min}, permission and ${tool || "no"} tool granted.`, code: "OK" };
}
const LEVEL_NAMES = ["Suggest only", "Approval required", "Low risk automation", "Business operations", "Full agentic operations"];

/* Actions that stay with a human whatever the level says. Level 4 is not
   unlimited authority; it is the top of the automatic range only. */
const ALWAYS_APPROVE = new Set(["CAN_DELETE_CRM", "CAN_ISSUE_REFUND", "CAN_CANCEL_APPOINTMENT"]);
const isDestructive = (action) => ALWAYS_APPROVE.has(action) || (ACTIONS[action] || {}).risk === "destructive";

/* Communication is not one thing: a reply to a customer who just wrote in is
   not the same act as a marketing blast, so they are governed differently. */
const COMMS_CLASS = { internal: 0, transactional: 0, reply: 0, outbound: 1, marketing: 2 };
function commsUplift(ctx) {
  const kind = ctx && ctx.commsKind;
  return kind && COMMS_CLASS[kind] !== undefined ? COMMS_CLASS[kind] : 0;
}

/* Bulk safeguards apply even at Level 4. */
const BULK_THRESHOLDS = { message: 50, campaign: 500, crm: 25, call: 20 };
function bulkBreach(action, ctx) {
  const n = (ctx && ctx.audienceSize) || 0;
  if (!n) return null;
  const kind = /CAMPAIGN/.test(action) ? "campaign" : /SEND_/.test(action) ? "message" : /CALL/.test(action) ? "call" : "crm";
  const limit = (ctx.bulkLimits && ctx.bulkLimits[kind]) || BULK_THRESHOLDS[kind];
  return n > limit ? { kind, n, limit } : null;
}

/* The most useful thing that can still happen when the action itself cannot. */
function degradeFor(action, effective) {
  const spec = ACTIONS[action] || { label: "that" };
  if (effective <= 0) return `draft ${spec.label.toLowerCase()} and show you exactly what it would do`;
  if (effective === 1) return `prepare ${spec.label.toLowerCase()} and send it for your approval`;
  return `prepare ${spec.label.toLowerCase()} and hold it for approval`;
}

/**
 * The single authority check.
 *
 * Returns a verdict rather than a boolean, because "no" is rarely the useful
 * answer: an action above the line becomes an approval item with the work
 * already prepared.
 */
function decide({ action, agent, ceiling = 4, ctx = {} }) {
  const spec = ACTIONS[action];
  const now = new Date().toISOString();
  const base = { action, actionLabel: spec ? spec.label : action, ceiling, at: now,
    agent: agent ? agent.name : "BUZZZ AI", requestedBy: ctx.requestedBy || "BUZZZ AI" };

  if (!spec) return { ...base, verdict: "deny", code: "UNKNOWN_ACTION", effective: 0, required: null,
    reason: `${action} is not a known action, so it cannot be authorised.`, fallback: null };

  /* BUZZZ AI acting on its own behalf is governed by the ceiling alone;
     an agent is additionally governed by its own level and permissions. */
  const agentLevel = agent ? (agent.autonomy ?? 0) : ceiling;
  const required = spec.min + commsUplift(ctx);
  const effective = Math.min(ceiling, agentLevel);

  const audit = { ...base, requested: required, effective, agentLevel,
    commsKind: ctx.commsKind || null, audienceSize: ctx.audienceSize || null };

  /* structural blockers first: approving these would not make them valid */
  if (agent) {
    const chk = canAgentDo(agent, action, { ceiling, isConnected: ctx.isConnected, channel: ctx.channel });
    if (!chk.ok && ["ARCHIVED", "INACTIVE", "NO_PERMISSION", "NO_TOOL", "NO_INTEGRATION", "NO_CHANNEL"].includes(chk.code)) {
      return { ...audit, verdict: "deny", code: chk.code, reason: chk.why,
        fallback: `I can still ${degradeFor(action, effective)}, but the blocker above has to be fixed first.` };
    }
  }
  /* destructive work always waits for a person, at every level */
  if (isDestructive(action)) {
    return { ...audit, verdict: "approve", code: "DESTRUCTIVE", required: Math.max(required, 4),
      reason: `${spec.label} cannot be undone, so it always waits for a human, even at Level 4.`,
      fallback: `prepared and waiting in the Approval Center` };
  }
  /* volume safeguards, independent of level */
  const bulk = bulkBreach(action, ctx);
  if (bulk) {
    return { ...audit, verdict: "approve", code: "BULK", required,
      reason: `${bulk.n} recipients is above the ${bulk.limit} limit for ${bulk.kind} actions, so this needs a person to release it.`,
      fallback: `prepared for ${bulk.n} recipients and waiting for approval` };
  }
  /* the level test itself */
  if (effective < required) {
    const capped = agent && agentLevel > ceiling;
    const why = `${spec.label} needs Level ${required} (${LEVEL_NAMES[Math.min(required, 4)]}). ` +
      `You are at Level ${effective}${capped ? `, because the workspace ceiling of ${ceiling} caps ${agent.name}'s Level ${agentLevel}` : ""}.`;
    /* Level 0 means nothing executes and nothing queues for execution either */
    if (effective <= 0) {
      return { ...audit, verdict: "prepare", code: "SUGGEST_ONLY", required, reason: why,
        fallback: `I can ${degradeFor(action, 0)}, but nothing will be sent or changed at Level 0.` };
    }
    return { ...audit, verdict: "approve", code: "AUTONOMY", required, reason: why,
      fallback: `I can ${degradeFor(action, effective)}.` };
  }
  return { ...audit, verdict: "allow", code: "OK", required,
    reason: `Allowed: Level ${effective} meets the Level ${required} this action needs.`, fallback: null };
}

/* What BUZZZ says when it cannot just do the thing. Names the action, the gap
   and the alternative, rather than "I can't do that". */
function explainDecision(d) {
  if (!d) return "";
  if (d.verdict === "allow") return "";
  const head = d.verdict === "deny" ? d.reason : d.reason;
  return [head, d.fallback].filter(Boolean).join(" ");
}

/* A compact record for the audit trail, with every field the brief asks for. */
function auditFor(d, extra = {}) {
  return { at: d.at, actor: d.requestedBy, agent: d.agent, action: d.action, label: d.actionLabel,
    requestedLevel: d.required, effectiveLevel: d.effective, ceiling: d.ceiling,
    verdict: d.verdict, code: d.code, reason: d.reason,
    approvalRequired: d.verdict === "approve", target: extra.target || null,
    integration: extra.integration || null, outcome: extra.outcome || null };
}

/* Natural language autonomy control. Returns an intent for the caller to
   apply after its own permission check; it never changes anything itself. */
function parseAutonomyCommand(text) {
  const t = String(text || "").toLowerCase();
  const lvl = (t.match(/level\s*([0-4])/) || [])[1];
  if (/pause (all )?(autonomous|ai|agent)/.test(t) || /stop (all )?(autonomous|automation)/.test(t))
    return { kind: "set_ceiling", level: 0, why: "Pausing all autonomous action" };
  if (/(which|what|who).*(level 4|full autonomy|highest)/.test(t)) return { kind: "query_agents", level: 4 };
  if (/why (couldn'?t|could not|did(n'?t| not))/.test(t)) return { kind: "explain_last" };
  if (lvl !== undefined && /(workspace|ceiling|my workspace)/.test(t)) return { kind: "set_ceiling", level: +lvl };
  if (lvl !== undefined && /(agent|assistant|bot)/.test(t)) return { kind: "set_agent", level: +lvl, agentHint: t };
  if (/without approval|require approval|need approval/.test(t)) return { kind: "require_approval", scope: /campaign|outbound/.test(t) ? "campaign" : "all" };
  return null;
}


export { ACTIONS, ACTION_TOOL, canAgentDo, decide, auditFor, explainDecision,
  parseAutonomyCommand, isDestructive, LEVEL_NAMES, BULK_THRESHOLDS };
