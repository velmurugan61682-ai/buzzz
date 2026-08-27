/**
 * Verifies the bearer token and attaches req.auth = { userId, workspaceId, role }.
 * The workspace is taken from the token and never from the request body,
 * because a client-supplied workspace id is a tenant boundary waiting to fail.
 */
export function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ code: "unauthenticated", message: "A bearer token is required.", request_id: req.id });
  }
  // TODO(port): verify signature, expiry and revocation against the session store.
  return res.status(501).json({
    code: "not_implemented",
    message: "Authentication is specified but not yet implemented. See docs/PRODUCTION_READINESS.md.",
    request_id: req.id,
  });
}
