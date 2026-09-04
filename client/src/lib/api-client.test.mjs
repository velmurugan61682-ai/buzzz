/**
 * API Client Unit Tests.
 *
 * Verifies API request header formatting, workspace_id passing, error handling, and API methods.
 */

import { api, apiRequest, ApiError } from "./api-client.js";

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) {
    console.error("  FAIL:", msg);
    fails++;
  }
};

// Mock global fetch
let lastCall = null;
global.fetch = async (url, opts) => {
  lastCall = { url, opts };
  if (url.includes("/error")) {
    return {
      ok: false,
      status: 400,
      json: async () => ({ code: "bad_request", message: "Invalid payload" }),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ([{ id: "1", name: "Test Entity" }]),
  };
};

(async () => {
  // Test contact fetch
  const contacts = await api.getContacts("ws_100");
  ok(Array.isArray(contacts), "api.getContacts returns an array");
  ok(lastCall.opts.headers["x-workspace-id"] === "ws_100", "x-workspace-id header correctly set");

  // Test error handling
  try {
    await apiRequest("/error", { workspaceId: "ws_100" });
    ok(false, "Should throw ApiError on non-2xx status");
  } catch (err) {
    ok(err instanceof ApiError, "Throws instance of ApiError");
    ok(err.status === 400, "Preserves HTTP status");
    ok(err.code === "bad_request", "Preserves API error code");
  }

  console.log(fails ? `api client test: ${fails} FAILED` : "api client test: all checks passed");
  process.exit(fails ? 1 : 0);
})();
