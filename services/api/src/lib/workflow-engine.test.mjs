/**
 * Visual Workflow Engine Unit Tests.
 */
import {
  interpolateVariables,
  evaluateCondition,
  validateWorkflowGraph,
  executeWorkflow,
} from "./workflow-engine.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

/* 1. Variable Interpolation */
const ctx = {
  contact: { name: "John Doe", phone: "+123456789" },
  trigger: { intent: "appointment_booking" },
  nodes: {
    checkAvail: { output: { startsAt: "2026-09-01T14:00:00Z" } },
  },
};

const str1 = interpolateVariables("Hello {{contact.name}}, your slot is {{nodes.checkAvail.output.startsAt}}", ctx);
ok(str1 === "Hello John Doe, your slot is 2026-09-01T14:00:00Z", "interpolates nested variables correctly");

/* 2. Condition Evaluation */
ok(evaluateCondition("sales", "equals", "sales") === true, "evaluates equals condition");
ok(evaluateCondition("premium customer", "contains", "premium") === true, "evaluates contains condition");
ok(evaluateCondition(100, "greater_than", 50) === true, "evaluates greater_than condition");
ok(evaluateCondition("", "is_empty", "") === true, "evaluates is_empty condition");

/* 3. Graph Validation */
const invalidGraph = { nodes: [{ id: "n1", type: "action.send_whatsapp" }] };
const valRes1 = validateWorkflowGraph(invalidGraph);
ok(valRes1.valid === false && valRes1.errors.some((e) => e.includes("trigger")), "fails when trigger node is missing");

const validGraph = {
  nodes: [
    { id: "t1", type: "trigger.whatsapp_message" },
    { id: "a1", type: "action.crm_create_contact" },
  ],
  edges: [{ id: "e1", sourceNodeId: "t1", targetNodeId: "a1" }],
};
const valRes2 = validateWorkflowGraph(validGraph);
ok(valRes2.valid === true, "validates valid graph");

/* 4. Graph Execution */
const makeMockDb = () => {
  const store = {
    contacts: [],
    runs: [],
    nodeExecs: [],
    audits: [],
  };

  return {
    createWorkflowRun: async (wsId, r) => {
      const run = { id: `run_${Date.now()}`, workspace_id: wsId, ...r };
      store.runs.push(run);
      return run;
    },
    updateWorkflowRun: async (wsId, id, patch) => {
      const run = store.runs.find((x) => x.id === id);
      if (run) Object.assign(run, patch);
      return run;
    },
    recordNodeExecution: async (runId, n) => {
      const record = { id: `ne_${Date.now()}_${Math.random()}`, run_id: runId, ...n };
      store.nodeExecs.push(record);
      return record;
    },
    createContact: async (wsId, data) => {
      const c = { id: `cont_${Date.now()}`, workspace_id: wsId, ...data };
      store.contacts.push(c);
      return c;
    },
    writeAudit: async (wsId, a) => {
      store.audits.push({ id: `aud_${Date.now()}`, workspace_id: wsId, ...a });
      return { ok: true };
    },
  };
};

const db = makeMockDb();
const fullWorkflow = {
  id: "wf_lead_intake",
  nodes: [
    { id: "node_trig", type: "trigger.whatsapp_message" },
    { id: "node_cond", type: "condition.if_else", config: { field: "{{trigger.intent}}", operator: "equals", value: "new_lead" } },
    { id: "node_crm", type: "action.crm_create_contact", config: { name: "{{trigger.name}}", phone: "{{trigger.phone}}" } },
    { id: "node_msg", type: "action.send_whatsapp", config: { to: "{{trigger.phone}}", body: "Welcome {{trigger.name}}!" } },
  ],
  edges: [
    { id: "e1", sourceNodeId: "node_trig", targetNodeId: "node_cond" },
    { id: "e2", sourceNodeId: "node_cond", condition: "true", targetNodeId: "node_crm" },
    { id: "e3", sourceNodeId: "node_crm", targetNodeId: "node_msg" },
  ],
};

const execRes = await executeWorkflow({
  db,
  workspaceId: "ws_alpha",
  workflow: fullWorkflow,
  triggerPayload: { intent: "new_lead", name: "David Miller", phone: "+1987654321" },
});

ok(execRes.ok === true, "executes graph workflow successfully");
ok(execRes.nodeExecutions.length === 4, "executes all 4 nodes across branch");
ok(execRes.context.nodes.node_crm.output.name === "David Miller", "populates node output with created CRM contact");

console.log(fails ? `workflow engine: ${fails} FAILED` : "workflow engine: all checks passed");
process.exit(fails ? 1 : 0);
