/**
 * Integration Management Routes Tests.
 */
import { integrationRoutes } from "./integrations.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

const makeMockDb = () => {
  const store = {
    integrations: new Map(),
    audits: [],
  };

  return {
    listIntegrations: async (wsId) => Array.from(store.integrations.values()).filter((i) => i.workspace_id === wsId),
    getIntegration: async (wsId, provider) => store.integrations.get(`${wsId}_${provider}`) || null,
    saveIntegration: async (wsId, provider, data) => {
      store.integrations.set(`${wsId}_${provider}`, { workspace_id: wsId, provider, ...data });
      return store.integrations.get(`${wsId}_${provider}`);
    },
    deleteIntegration: async (wsId, provider) => {
      store.integrations.delete(`${wsId}_${provider}`);
      return { provider };
    },
    writeAudit: async (wsId, a) => {
      store.audits.push({ workspace_id: wsId, ...a });
      return { ok: true };
    },
  };
};

const db = makeMockDb();
const router = integrationRoutes({ db });

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

/* 1. List Integrations */
const listRes = await dispatch("GET", "/integrations");
ok(listRes.status === 200 && listRes.body.data.length >= 5, "lists all standard integrations");

/* 2. Test Connection */
const testRes = await dispatch("POST", "/integrations/gowhats/test");
ok(testRes.status === 200 && testRes.body.state === "connected", "tests and connects integration");

/* 3. Disconnect */
const discRes = await dispatch("POST", "/integrations/gowhats/disconnect");
ok(discRes.status === 200 && discRes.body.state === "not_connected", "disconnects integration");

console.log(fails ? `integrations: ${fails} FAILED` : "integrations: all checks passed");
process.exit(fails ? 1 : 0);
