/**
 * Binds every query in this request to the caller's workspace.
 * Handlers must use req.db, never a bare pool, so a handler that forgets
 * the scope cannot read another tenant's rows.
 */
export function isPublicRoute(req) {
  const path = req.path || "";
  const originalUrl = req.originalUrl || req.url || "";
  const publicRoutes = [
    "/webhooks/gowhats",
    "/webhooks/stripe",
    "/google/callback",
    "/google/webhook",
    "/api/v1/webhooks/gowhats",
    "/api/v1/webhooks/stripe",
    "/api/v1/google/callback",
    "/api/v1/google/webhook",
  ];
  return publicRoutes.some((route) => path.includes(route) || originalUrl.includes(route));
}

export function tenantScope(req, res, next) {
  if (isPublicRoute(req)) {
    return next();
  }
  const workspaceId = req.auth?.workspaceId;
  if (!workspaceId) {
    return res.status(401).json({ code: "unauthenticated", message: "No workspace on this session.", request_id: req.id });
  }
  if (req.body && "workspace_id" in req.body) delete req.body.workspace_id; // never trusted
  req.db = {
    query: (text, params = []) => {
      throw new Error("Database not configured. Set DATABASE_URL and port the query layer.");
    },
    workspaceId,
  };
  next();
}
