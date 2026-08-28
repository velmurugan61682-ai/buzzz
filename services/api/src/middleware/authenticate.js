/**
 * Authentication and Authorization Middlewares.
 *
 * Verifies session credentials (HttpOnly cookie or Bearer token),
 * validates workspace membership, enforces RBAC roles and permissions,
 * and attaches verified workspace context.
 */

import { currentSession, AuthError } from "../lib/auth.js";
import { hasPermission } from "../lib/permissions.js";

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

export function createAuthMiddleware({ db }) {
  /**
   * Authenticates the user session from cookie or Authorization header.
   */
  const authenticate = async (req, res, next) => {
    try {
      if (isPublicRoute(req)) {
        return next();
      }

      let token = null;
      if (req.cookies && req.cookies.bz_session) {
        token = req.cookies.bz_session;
      } else if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
        token = req.headers.authorization.slice(7).trim();
      }

      if (!token) {
        return res.status(401).json({
          code: "unauthenticated",
          message: "Sign in to access this resource.",
          request_id: req.id,
        });
      }

      const active = await currentSession({ token }, { db });
      if (!active || !active.user) {
        return res.status(401).json({
          code: "invalid_session",
          message: "Session expired or invalid. Please sign in again.",
          request_id: req.id,
        });
      }

      req.user = active.user;
      req.session = active.session;
      req.auth = { userId: active.user.id };
      next();
    } catch (err) {
      next(err);
    }
  };

  /**
   * Resolves and verifies the target workspace membership.
   * Never trusts a workspace_id blindly without verifying database membership.
   */
  const requireWorkspace = async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          code: "unauthenticated",
          message: "Sign in to access workspace resources.",
          request_id: req.id,
        });
      }

      const workspaceId =
        req.headers["x-workspace-id"] ||
        req.params.workspaceId ||
        (req.query && req.query.workspaceId) ||
        (req.body && req.body.workspaceId);

      if (!workspaceId || typeof workspaceId !== "string") {
        return res.status(400).json({
          code: "missing_workspace",
          message: "Workspace ID is required.",
          request_id: req.id,
        });
      }

      const memberships = await db.listMemberships(req.user.id);
      const membership = memberships.find((m) => m.workspaceId === workspaceId);

      if (!membership) {
        return res.status(403).json({
          code: "not_a_member",
          message: "You do not have access to this workspace.",
          request_id: req.id,
        });
      }

      req.workspace = {
        id: workspaceId,
        name: membership.name,
        role: membership.role,
      };
      req.auth = {
        userId: req.user.id,
        workspaceId,
        role: membership.role,
      };

      // Strip any malicious client-supplied workspace_id payload overrides
      if (req.body && typeof req.body === "object" && "workspace_id" in req.body) {
        delete req.body.workspace_id;
      }

      next();
    } catch (err) {
      next(err);
    }
  };

  /**
   * Enforces a specific RBAC permission.
   */
  const requirePermission = (permission) => (req, res, next) => {
    if (!req.workspace || !req.workspace.role) {
      return res.status(403).json({
        code: "no_workspace_context",
        message: "Workspace context required for permission check.",
        request_id: req.id,
      });
    }

    if (!hasPermission(req.workspace.role, permission)) {
      return res.status(403).json({
        code: "insufficient_permissions",
        message: `Your role (${req.workspace.role}) does not have permission '${permission}'.`,
        request_id: req.id,
      });
    }

    next();
  };

  /**
   * Enforces one of the specified workspace roles.
   */
  const requireRole = (...allowedRoles) => (req, res, next) => {
    if (!req.workspace || !req.workspace.role) {
      return res.status(403).json({
        code: "no_workspace_context",
        message: "Workspace context required for role check.",
        request_id: req.id,
      });
    }

    const role = req.workspace.role.toLowerCase();
    const allowed = allowedRoles.map((r) => r.toLowerCase());

    if (!allowed.includes(role)) {
      return res.status(403).json({
        code: "forbidden",
        message: `Requires one of roles: [${allowedRoles.join(", ")}]. Current role: ${req.workspace.role}`,
        request_id: req.id,
      });
    }

    next();
  };

  return {
    authenticate,
    requireWorkspace,
    requirePermission,
    requireRole,
  };
}

// Backward-compatible default middleware stub export
export function authenticate(req, res, next) {
  if (isPublicRoute(req)) {
    return next();
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token && (!req.cookies || !req.cookies.bz_session)) {
    return res.status(401).json({ code: "unauthenticated", message: "A bearer token or session is required.", request_id: req.id });
  }
  next();
}
