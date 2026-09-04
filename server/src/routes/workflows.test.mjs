/**
 * Visual Workflow Automation Routes Integration Tests.
 */
import { workflowRoutes } from "./workflows.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

const makeMockDb = () => {
  const store = {
    workflows: [],
    versions: [],
    runs: [],
    nodeExecs: [],
    audits: [],
  };

  return {
    listWorkflows: async (wsId) => store.workflows.filter((w) => w.workspace_id === wsId),
    getWorkflow: async (wsId, id) => store.workflows.find((w) => w.workspace_id === wsId && w.id === id) || null,
    createWorkflow: async (wsId, w) => {
      const wf = { id: `wf_${Date.now()}_${Math.random()}`, workspace_id: wsId, ...w, created_at: new Date().toISOString() };
      store.workflows.push(wf);
      return wf;
    },
    updateWorkflow: async (wsId, id, patch) => {
      const wf = store.workflows.find((x) => x.workspace_id === wsId && x.id === id);
      if (!wf) return null;
      Object.assign(wf, patch);
      return wf;
    },
    deleteWorkflow: async (wsId, id) => {
      store.workflows = store.workflows.filter((x) => !(x.workspace_id === wsId && x.id === id));
      return { id };
    },
    createWorkflowVersion: async (wfId, version, graph, publishedBy) => {
      const v = { id: `ver_${Date.now()}`, workflow_id: wfId, version, graph, published_by: publishedBy, published_at: new Date().toISOString() };
      store.versions.push(v);
      return v;
    },

    createWorkflowRun: async (wsId, r) => {
      const run = { id: `run_${Date.now()}`, workspace_id: wsId, workflow_id: r.workflowId, ...r, started_at: new Date().toISOString() };
      store.runs.push(run);
      return run;
    },
    updateWorkflowRun: async (wsId, id, patch) => {
      const run = store.runs.find((x) => x.workspace_id === wsId && x.id === id);
      if (run) Object.assign(run, patch);
      return run;
    },
    listWorkflowRuns: async (wsId, wfId) =>
      store.runs.filter((r) => r.workspace_id === wsId && r.workflow_id === wfId),
    getWorkflowRun: async (wsId, runId) =>
      store.runs.find((r) => r.workspace_id === wsId && r.id === runId) || null,

    recordNodeExecution: async (runId, n) => {
      const exec = { id: `ne_${Date.now()}_${Math.random()}`, run_id: runId, ...n };
      store.nodeExecs.push(exec);
      return exec;
    },
    listNodeExecutions: async (runId) => store.nodeExecs.filter((e) => e.run_id === runId),

    createContact: async (wsId, data) => ({ id: `cont_${Date.now()}`, workspace_id: wsId, ...data }),
    writeAudit: async (wsId, a) => {
      store.audits.push({ id: `aud_${Date.now()}`, workspace_id: wsId, ...a });
      return { ok: true };
    },
  };
};

const db = makeMockDb();
const broadcasts = [];
const router = workflowRoutes({
  db,
  broadcast: (wsId, event, data) => broadcasts.push({ wsId, event, data }),
});

const dispatch = async (method, path, { headers = {}, body = {}, query = {}, params = {}, workspace = { id: "ws_alpha", role: "admin" } } = {}) => {
  let matchedHandler = null;
  const pathParts = path.split("/").filter(Boolean);

  for (const layer of router.stack) {
    if (layer.route && layer.route.methods[method.toLowerCase()]) {
      const routeParts = layer.route.path.split("/").filter(Boolean);
      if (routeParts.length === pathParts.length) {
        let match = true;
        const extractedParams = { ...params };
        for (let i = 0; i < routeParts.length; i++) {
          if (routeParts[i].startsWith(":")) {
            extractedParams[routeParts[i].slice(1)] = pathParts[i];
          } else if (routeParts[i] !== pathParts[i]) {
            match = false;
            break;
          }
        }
        if (match) {
          matchedHandler = layer.route.stack[0].handle;
          params = extractedParams;
          break;
        }
      }
    }
  }

  if (!matchedHandler) {
    throw new Error(`No route found for ${method} ${path}`);
  }

  let statusCode = 200;
  let jsonBody = null;

  const req = {
    method,
    headers: { "x-workspace-id": workspace.id, ...headers },
    body,
    query,
    params,
    workspace,
    auth: { userId: "u1", workspaceId: workspace.id, role: workspace.role },
  };

  const res = {
    status: (code) => {
      statusCode = code;
      return res;
    },
    json: (data) => {
      jsonBody = data;
      return res;
    },
  };

  await matchedHandler(req, res, (err) => {
    if (err) {
      statusCode = err.status || 500;
      jsonBody = { code: err.code || "error", message: err.message };
    }
  });

  return { status: statusCode, body: jsonBody };
};

/* =========================================================================
   1. NODE CATALOG
   ========================================================================= */
const catRes = await dispatch("GET", "/workflow-node-catalog");
ok(catRes.status === 200 && catRes.body.data.length >= 10, "returns workflow node catalog");

/* =========================================================================
   2. WORKFLOW CRUD
   ========================================================================= */
const createRes = await dispatch("POST", "/workflows", {
  body: {
    name: "Appointment Confirmation Flow",
    description: "Automated booking confirmations and follow-ups",
    nodes: [
      { id: "t1", type: "trigger.appointment_created" },
      { id: "a1", type: "action.send_whatsapp", config: { body: "Your appointment is confirmed!" } },
    ],
    edges: [{ id: "e1", sourceNodeId: "t1", targetNodeId: "a1" }],
  },
});
ok(createRes.status === 201, "creates workflow");
const wf = createRes.body.workflow;

const getRes = await dispatch("GET", `/workflows/${wf.id}`);
ok(getRes.status === 200 && getRes.body.workflow.id === wf.id, "retrieves workflow by id");

// Duplicate
const dupRes = await dispatch("POST", `/workflows/${wf.id}/duplicate`);
ok(dupRes.status === 201 && dupRes.body.workflow.name.includes("Copy"), "duplicates workflow");

/* =========================================================================
   3. VALIDATE & PUBLISH
   ========================================================================= */
const valRes = await dispatch("POST", `/workflows/${wf.id}/validate`);
ok(valRes.status === 200 && valRes.body.valid === true, "validates workflow graph");

const pubRes = await dispatch("POST", `/workflows/${wf.id}/publish`);
ok(pubRes.status === 200 && pubRes.body.workflow.status === "published", "publishes workflow");

/* =========================================================================
   4. EXECUTION TESTING
   ========================================================================= */
const testRes = await dispatch("POST", `/workflows/${wf.id}/test`, {
  body: { triggerPayload: { phone: "+123456789", customerName: "Emma" } },
});
ok(testRes.status === 200 && testRes.body.status === "completed", "runs workflow execution test");

/* =========================================================================
   5. RUN LOGS & NODE EXECUTIONS
   ========================================================================= */
const runsRes = await dispatch("GET", `/workflows/${wf.id}/runs`);
ok(runsRes.status === 200 && runsRes.body.data.length >= 1, "lists workflow runs");

const runId = runsRes.body.data[0].id;
const nodesRes = await dispatch("GET", `/workflows/${wf.id}/runs/${runId}/nodes`);
ok(nodesRes.status === 200 && nodesRes.body.data.length >= 2, "inspects node execution logs");

/* =========================================================================
   6. TENANT ISOLATION
   ========================================================================= */
const foreignRes = await dispatch("GET", `/workflows/${wf.id}`, {
  workspace: { id: "ws_foreign_beta", role: "admin" },
});
ok(foreignRes.status === 404, "cross-tenant workflow access is blocked with 404");

console.log(fails ? `workflow routes: ${fails} FAILED` : "workflow routes: all checks passed");
process.exit(fails ? 1 : 0);
