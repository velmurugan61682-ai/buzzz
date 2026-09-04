/**
 * Integration Management Routes Tests.
 */
import { integrationRoutes } from "./integrations.js";
import { sealCredential } from "../lib/credential-store.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

// Use a real 64-char hex key so sealCredential/openCredential work in tests
const TEST_CRED_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const makeMockDb = () => {
  const store = {
    integrations: new Map(),
    audits: [],
  };

  return {
    listIntegrations: async (wsId) => Array.from(store.integrations.values()).filter((i) => i.workspace_id === wsId),
    getIntegration: async (wsId, provider) => store.integrations.get(`${wsId}_${provider}`) || null,
    saveIntegration: async (wsId, provider, data) => {
      const existing = store.integrations.get(`${wsId}_${provider}`) || {};
      // Mirror the real DB layer: camelCase input → snake_case storage
      const row = {
        workspace_id:   wsId,
        provider,
        ...existing,
        state:          data.state          ?? existing.state,
        credential_ref: data.credentialRef  ?? data.credential_ref ?? existing.credential_ref ?? null,
        config:         data.config         ?? existing.config,
        error_count:    data.errorCount     ?? existing.error_count ?? 0,
      };
      store.integrations.set(`${wsId}_${provider}`, row);
      return row;
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

// Pass credentialKey so seal/open works, and a whatsappBaseUrl for the /test endpoint
const router = integrationRoutes({
  db,
  config: {
    credentialKey:   TEST_CRED_KEY,
    whatsappBaseUrl: "https://graph.facebook.com/v20.0",
  },
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

/* 1. List Integrations */
const listRes = await dispatch("GET", "/integrations");
ok(listRes.status === 200 && listRes.body.data.length >= 6, "lists all standard integrations including youtube");

const ytInteg = listRes.body.data.find((i) => i.provider === "youtube");
ok(ytInteg && ytInteg.name === "ChannelBot.in", "includes ChannelBot.in integration label");
ok(ytInteg && ytInteg.verificationStatus === "unverified_sandbox", "includes unverified_sandbox verificationStatus for YouTube");

/* 2. PUT gowhats — seals the apiKey into credential_ref */
const putRes = await dispatch("PUT", "/integrations/gowhats", {
  body: { apiKey: "test_meta_token_abc123", phoneNumberId: "987654321" },
});
ok(putRes.status === 200 && putRes.body.state === "connected", "PUT gowhats returns connected state");
ok(!putRes.body.credential_ref, "PUT response does not leak credential_ref to caller");

// Verify the integration was stored with a sealed credential_ref (not plaintext)
const storedInteg = await db.getIntegration("ws_alpha", "gowhats");
ok(storedInteg && !!storedInteg.credential_ref, "integration row has a credential_ref after PUT");
ok(storedInteg && storedInteg.credential_ref !== "test_meta_token_abc123", "credential_ref is sealed, not plaintext");

/* 3. POST /integrations/gowhats/test — needs the credential already in DB.
   It calls Meta's /me endpoint — mock the fetch to simulate a valid token response.
   We inject a fake global fetch for this test only. */
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (url.includes("/me")) {
    return { ok: true, json: async () => ({ id: "123", name: "Test System User" }) };
  }
  return { ok: false, json: async () => ({ error: { code: 999 } }) };
};

const testRes = await dispatch("POST", "/integrations/gowhats/test");
ok(testRes.status === 200 && testRes.body.healthy === true, "POST /test returns healthy when token validates");
ok(testRes.status === 200 && testRes.body.state === "connected", "POST /test returns connected state");

// Restore real fetch
globalThis.fetch = realFetch;

/* 4. PUT gowhats with an invalid credential (simulates user providing bad token) */
const badPutRes = await dispatch("PUT", "/integrations/youtube", {
  body: { apiKey: "yt_f792a2c02f9a11c03dd5e43e0e892742c0c2d05ef58e3cd896c26e8b" },
});
ok(badPutRes.status === 200 && badPutRes.body.state === "connected", "saves API key and connects ChannelBot.in integration");

const ytTestRes = await dispatch("POST", "/integrations/youtube/test", {
  body: { apiKey: "yt_f792a2c02f9a11c03dd5e43e0e892742c0c2d05ef58e3cd896c26e8b" },
});
ok(ytTestRes.status === 200 && ytTestRes.body.state === "connected", "tests ChannelBot.in integration cleanly");

/* 5. Disconnect */
const discRes = await dispatch("POST", "/integrations/gowhats/disconnect");
ok(discRes.status === 200 && discRes.body.state === "not_connected", "disconnects integration");

console.log(fails ? `integrations: ${fails} FAILED` : "integrations: all checks passed");
process.exit(fails ? 1 : 0);
