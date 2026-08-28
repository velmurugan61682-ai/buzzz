/**
 * Authentication Middleware & RBAC Permission Tests.
 */
import { createAuthMiddleware } from "./authenticate.js";
import { PERMISSIONS, ROLES, hasPermission } from "../lib/permissions.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

const fakeDb = {
  findSession: async (hash) => {
    if (hash === "valid_hash") {
      return { id: "s1", userId: "u1", expiresAt: new Date(Date.now() + 10000).toISOString() };
    }
    if (hash === "revoked_hash") {
      return { id: "s2", userId: "u1", revokedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10000).toISOString() };
    }
    return null;
  },
  findUserById: async (id) => {
    if (id === "u1") return { id: "u1", email: "user@buzzz.com", name: "Alex" };
    return null;
  },
  listMemberships: async (userId) => {
    if (userId === "u1") {
      return [
        { workspaceId: "ws_alpha", name: "Alpha Corp", role: "admin" },
        { workspaceId: "ws_beta", name: "Beta LLC", role: "viewer" },
      ];
    }
    return [];
  },
};

const authMw = createAuthMiddleware({ db: fakeDb });

const makeReqRes = (headers = {}, cookies = {}, body = {}, params = {}, query = {}) => {
  const req = { headers, cookies, body, params, query, id: "req_1" };
  let statusCode = 200;
  let jsonBody = null;
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
  return { req, res, getStatus: () => statusCode, getJson: () => jsonBody };
};

/* ---- 1. authenticate middleware ---- */
// 1a: Unauthenticated
{
  const { req, res, getStatus, getJson } = makeReqRes();
  let nextCalled = false;
  await authMw.authenticate(req, res, () => { nextCalled = true; });
  ok(!nextCalled, "authenticate stops unauthenticated requests");
  ok(getStatus() === 401, "returns 401 for unauthenticated request");
  ok(getJson().code === "unauthenticated", "error code is unauthenticated");
}

// 1b: Valid session token in cookie
{
  // We need the hash of the raw token to match fakeDb:
  // sha256("raw_token_1")
  const crypto = await import("node:crypto");
  const rawToken = "my_token";
  const hash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const customDb = {
    ...fakeDb,
    findSession: async (h) => (h === hash ? { id: "s1", userId: "u1", expiresAt: new Date(Date.now() + 10000).toISOString() } : null),
  };
  const mw = createAuthMiddleware({ db: customDb });

  const { req, res } = makeReqRes({}, { bz_session: rawToken });
  let nextCalled = false;
  await mw.authenticate(req, res, () => { nextCalled = true; });
  ok(nextCalled, "authenticate allows valid cookie session");
  ok(req.user?.id === "u1", "attaches authenticated user");
  ok(req.session?.id === "s1", "attaches active session");
}

/* ---- 2. requireWorkspace middleware ---- */
// 2a: Member reaches their own workspace
{
  const { req, res } = makeReqRes({ "x-workspace-id": "ws_alpha" });
  req.user = { id: "u1" };
  let nextCalled = false;
  await authMw.requireWorkspace(req, res, () => { nextCalled = true; });
  ok(nextCalled, "allows access to workspace where user is a member");
  ok(req.workspace?.id === "ws_alpha", "attaches verified workspace ID");
  ok(req.workspace?.role === "admin", "attaches verified workspace role");
}

// 2b: IDOR attack — user attempts to access foreign workspace
{
  const { req, res, getStatus, getJson } = makeReqRes({ "x-workspace-id": "ws_unauthorized_victim" });
  req.user = { id: "u1" };
  let nextCalled = false;
  await authMw.requireWorkspace(req, res, () => { nextCalled = true; });
  ok(!nextCalled, "blocks access to workspace user does not belong to");
  ok(getStatus() === 403, "returns 403 forbidden for cross-tenant access");
  ok(getJson().code === "not_a_member", "error code is not_a_member");
}

// 2c: Strips malicious workspace_id from request body
{
  const { req, res } = makeReqRes({ "x-workspace-id": "ws_alpha" }, {}, { workspace_id: "malicious_override", name: "Contact" });
  req.user = { id: "u1" };
  await authMw.requireWorkspace(req, res, () => {});
  ok(req.body.workspace_id === undefined, "strips client-supplied workspace_id from request body");
  ok(req.body.name === "Contact", "preserves legitimate body payload");
}

/* ---- 3. requirePermission & RBAC matrix ---- */
// Admin has contacts.create permission
{
  const { req, res } = makeReqRes();
  req.workspace = { id: "ws_alpha", role: "admin" };
  let nextCalled = false;
  authMw.requirePermission(PERMISSIONS.CONTACTS_CREATE)(req, res, () => { nextCalled = true; });
  ok(nextCalled, "Admin has contacts.create permission");
}

// Viewer does NOT have contacts.create permission
{
  const { req, res, getStatus, getJson } = makeReqRes();
  req.workspace = { id: "ws_beta", role: "viewer" };
  let nextCalled = false;
  authMw.requirePermission(PERMISSIONS.CONTACTS_CREATE)(req, res, () => { nextCalled = true; });
  ok(!nextCalled, "Viewer is denied contacts.create permission");
  ok(getStatus() === 403, "returns 403 forbidden");
  ok(getJson().code === "insufficient_permissions", "returns insufficient_permissions error code");
}

// Viewer has contacts.read permission
{
  const { req, res } = makeReqRes();
  req.workspace = { id: "ws_beta", role: "viewer" };
  let nextCalled = false;
  authMw.requirePermission(PERMISSIONS.CONTACTS_READ)(req, res, () => { nextCalled = true; });
  ok(nextCalled, "Viewer has contacts.read permission");
}

/* ---- 4. requireRole middleware ---- */
{
  const { req, res } = makeReqRes();
  req.workspace = { id: "ws_alpha", role: "admin" };
  let nextCalled = false;
  authMw.requireRole("owner", "admin")(req, res, () => { nextCalled = true; });
  ok(nextCalled, "requireRole permits matching role");
}

{
  const { req, res, getStatus } = makeReqRes();
  req.workspace = { id: "ws_beta", role: "viewer" };
  let nextCalled = false;
  authMw.requireRole("owner", "admin")(req, res, () => { nextCalled = true; });
  ok(!nextCalled, "requireRole rejects non-matching role");
  ok(getStatus() === 403, "requireRole returns 403");
}

console.log(fails ? `auth middleware: ${fails} FAILED` : "auth middleware: all checks passed");
process.exit(fails ? 1 : 0);
