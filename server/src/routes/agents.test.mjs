/**
 * AI Agents & Copilot Routes Integration Tests.
 */
import { agentRoutes } from "./agents.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

const makeMockDb = () => {
  const store = {
    agents: [],
    versions: [],
    audits: [],
  };

  return {
    listAgents: async (wsId) => store.agents.filter((a) => a.workspace_id === wsId),
    getAgent: async (wsId, id) => store.agents.find((a) => a.workspace_id === wsId && a.id === id) || null,
    createAgent: async (wsId, a) => {
      const agent = { id: `agent_${Date.now()}_${Math.random()}`, workspace_id: wsId, ...a, created_at: new Date().toISOString() };
      store.agents.push(agent);
      return agent;
    },
    updateAgent: async (wsId, id, patch) => {
      const a = store.agents.find((x) => x.workspace_id === wsId && x.id === id);
      if (!a) return null;
      Object.assign(a, patch);
      return a;
    },
    deleteAgent: async (wsId, id) => {
      store.agents = store.agents.filter((x) => !(x.workspace_id === wsId && x.id === id));
      return { id };
    },

    createAgentVersion: async (agentId, snapshot, createdBy) => {
      const v = { id: `ver_${Date.now()}`, agent_id: agentId, snapshot, created_by: createdBy, created_at: new Date().toISOString() };
      store.versions.push(v);
      return v;
    },
    listAgentVersions: async (agentId) => store.versions.filter((v) => v.agent_id === agentId),
    getAgentVersion: async (agentId, versionId) =>
      store.versions.find((v) => v.agent_id === agentId && v.id === versionId) || null,

    writeAudit: async (wsId, e) => {
      store.audits.push({ id: `aud_${Date.now()}`, workspace_id: wsId, ...e });
      return { ok: true };
    },

    getService: async () => ({ duration_minutes: 30, capacity: 1 }),
    listStaffSchedules: async () => [{ start_time: "09:00", end_time: "17:00", day_of_week: 1 }],
    getStaffAppointmentsForDate: async () => [],
    createAppointment: async (wsId, a) => ({ id: `appt_${Date.now()}`, workspace_id: wsId, ...a }),
    updateConversationState: async () => ({ ok: true }),
  };
};

const db = makeMockDb();
const broadcasts = [];
const router = agentRoutes({
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
   1. TOOL CATALOG
   ========================================================================= */
const catRes = await dispatch("GET", "/agents/tools/catalog");
ok(catRes.status === 200 && catRes.body.data.length >= 8, "returns tool catalog");

/* =========================================================================
   2. AGENT CRUD
   ========================================================================= */
const createRes = await dispatch("POST", "/agents", {
  body: {
    name: "Salon Booking Assistant",
    role: "Front Desk Concierge",
    autonomy: 2,
    tools: ["appointments.create_appointment", "appointments.check_availability"],
  },
});
ok(createRes.status === 201, "creates agent");
const agent = createRes.body.agent;
ok(agent.status === "draft", "initial status is draft");

const getRes = await dispatch("GET", `/agents/${agent.id}`);
ok(getRes.status === 200 && getRes.body.agent.id === agent.id, "retrieves agent by id");

// Duplicate
const dupRes = await dispatch("POST", `/agents/${agent.id}/duplicate`);
ok(dupRes.status === 201 && dupRes.body.agent.name.includes("Copy"), "duplicates agent");

/* =========================================================================
   3. VERSIONING, PUBLISHING, ROLLBACK
   ========================================================================= */
const pubRes = await dispatch("POST", `/agents/${agent.id}/publish`);
ok(pubRes.status === 200 && pubRes.body.agent.status === "active", "publishes agent");

const verListRes = await dispatch("GET", `/agents/${agent.id}/versions`);
ok(verListRes.status === 200 && verListRes.body.data.length >= 2, "lists version history");

// Rollback to v1
const v1Id = verListRes.body.data[1].id;
const rollRes = await dispatch("POST", `/agents/${agent.id}/rollback`, {
  body: { versionId: v1Id },
});
ok(rollRes.status === 200, "rolls back to version snapshot");

/* =========================================================================
   4. AGENT TEST RUN
   ========================================================================= */
const testRes = await dispatch("POST", `/agents/${agent.id}/test`, {
  body: { message: "Can I book an appointment tomorrow?" },
});
ok(testRes.status === 200, "agent test run succeeds");
ok(testRes.body.reply.includes("appointment has been successfully scheduled"), "returns test reply");

/* =========================================================================
   5. COPILOT SUGGESTIONS
   ========================================================================= */
const copilotRes = await dispatch("POST", "/copilot/suggestions", {
  body: { lastMessage: "Can you help me reschedule?" },
});
ok(copilotRes.status === 200 && copilotRes.body.suggestions.length > 0, "generates copilot suggestions");

/* =========================================================================
   6. TENANT ISOLATION
   ========================================================================= */
const foreignRes = await dispatch("GET", `/agents/${agent.id}`, {
  workspace: { id: "ws_foreign_beta", role: "admin" },
});
ok(foreignRes.status === 404, "cross-tenant agent access is blocked with 404");

console.log(fails ? `agent routes: ${fails} FAILED` : "agent routes: all checks passed");
process.exit(fails ? 1 : 0);
