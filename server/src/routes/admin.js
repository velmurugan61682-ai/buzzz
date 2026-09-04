/**
 * Admin (staff) routes.
 *
 * Two rules govern everything here:
 *   1. Authorization is checked on the server for every endpoint. The console
 *      hiding a button is not access control.
 *   2. No endpoint invents a figure. If a metric cannot be read, it is absent,
 *      because an operations dashboard is used to make decisions.
 */
import { Router } from "express";
import { requireStaff, verifyPassword, publicUser, newToken, hashToken, AuthError } from "../lib/auth.js";

/* Staff sessions are separate from customer sessions: a different cookie, a
   different table, and a shorter life, because this console can see more. */
export const STAFF_SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // one working day

export function adminRoutes({ db, now = Date.now }) {
  const r = Router();

  /* Every route below this line requires a valid staff session. */
  const staffOnly = (role) => async (req, res, next) => {
    try {
      const token = req.cookies && req.cookies.bz_staff;
      const session = token ? await db.findStaffSession(hashToken(token)) : null;
      if (!session || session.revokedAt || new Date(session.expiresAt).getTime() <= now()) {
        return res.status(401).json({ code: "not_authenticated", message: "Staff sign in required." });
      }
      const staff = await db.findStaffUser(session.staffUserId);
      if (!staff || staff.status !== "active") {
        return res.status(403).json({ code: "inactive", message: "This staff account is not active." });
      }
      const check = requireStaff({ staff }, role);
      if (!check.ok) {
        /* a failed authorization attempt is itself worth recording */
        await db.writeAudit(null, { actorType: "staff", actorId: staff.id, action: "admin.access.denied",
          detail: { path: req.path, need: role, have: staff.role }, severity: "warn" });
        return res.status(403).json({ code: check.reason, message: "Your role does not allow that." });
      }
      req.staff = staff;
      next();
    } catch (e) { next(e); }
  };

  r.post("/login", async (req, res, next) => {
    try {
      const email = String((req.body || {}).email || "").trim().toLowerCase();
      const staff = await db.findStaffUserByEmail(email);
      const ok = staff ? verifyPassword((req.body || {}).password, staff.passwordHash) : false;
      if (!staff || !ok || staff.status !== "active") {
        await db.recordFailedLogin({ email, ip: req.ip, at: new Date(now()).toISOString() });
        /* identical response either way: this endpoint must not confirm which
           addresses belong to BUZZZ staff */
        return res.status(401).json({ code: "invalid_credentials", message: "That email and password do not match." });
      }
      const token = newToken();
      await db.createStaffSession({ staffUserId: staff.id, tokenHash: token.hash, ip: req.ip,
        createdAt: new Date(now()).toISOString(), expiresAt: new Date(now() + STAFF_SESSION_TTL_MS).toISOString() });
      await db.writeAudit(null, { actorType: "staff", actorId: staff.id, action: "admin.login", severity: "info" });
      res.cookie("bz_staff", token.raw, { httpOnly: true, secure: true, sameSite: "strict", maxAge: STAFF_SESSION_TTL_MS });
      res.json({ staff: { id: staff.id, email: staff.email, name: staff.name, role: staff.role } });
    } catch (e) { next(e); }
  });

  /* Operational metrics, every one of them counted rather than estimated. */
  r.get("/overview", staffOnly("support"), async (req, res, next) => {
    try {
      const m = await db.platformMetrics();
      res.json({
        workspaces: m.workspaces, activeUsers: m.activeUsers7d, newSignups: m.signups7d,
        messagesToday: m.messagesToday, aiActions: m.aiActions24h, approvalsWaiting: m.approvalsPending,
        failedWorkflows: m.workflowFailures24h, integrationFailures: m.integrationFailures24h,
        apiErrors: m.apiErrors24h, storageBytes: m.storageBytes,
        /* billing figures come from the billing provider, not from us. If that
           is not wired up, the field is absent rather than zero, because zero
           MRR and unknown MRR are very different things. */
        mrr: m.mrr ?? null, churn: m.churn ?? null,
        generatedAt: new Date(now()).toISOString(),
      });
    } catch (e) { next(e); }
  });

  r.get("/workspaces", staffOnly("support"), async (req, res, next) => {
    try {
      /* deliberately a summary: no customer messages, contacts or documents are
         returned by a listing endpoint */
      res.json({ workspaces: await db.listWorkspaceSummaries({ limit: 100 }) });
    } catch (e) { next(e); }
  });

  r.get("/users", staffOnly("support"), async (req, res, next) => {
    try {
      const users = await db.listUsers({ limit: 100 });
      /* publicUser strips the hash; the listing never carries credentials */
      res.json({ users: users.map(publicUser) });
    } catch (e) { next(e); }
  });

  r.get("/ai-operations", staffOnly("ops"), async (req, res, next) => {
    try { res.json({ operations: await db.listAiOperations({ limit: 200 }) }); } catch (e) { next(e); }
  });

  r.get("/errors", staffOnly("support"), async (req, res, next) => {
    try { res.json({ groups: await db.listErrorGroups({ limit: 100 }) }); } catch (e) { next(e); }
  });

  r.get("/audit", staffOnly("ops"), async (req, res, next) => {
    try { res.json({ events: await db.listAuditEvents({ limit: 200, ...req.query }) }); } catch (e) { next(e); }
  });

  r.get("/health", staffOnly("support"), async (req, res, next) => {
    try { res.json(await db.systemHealth()); } catch (e) { next(e); }
  });

  /* Looking inside a customer workspace: reasoned, time boxed, logged, and
     read only unless a superadmin says otherwise. */
  r.post("/support-grants", staffOnly("support"), async (req, res, next) => {
    try {
      const { workspaceId, reason, minutes = 30, readOnly = true } = req.body || {};
      if (!workspaceId) return res.status(400).json({ code: "bad_request", message: "workspaceId is required." });
      if (!reason || String(reason).trim().length < 12) {
        return res.status(400).json({ code: "reason_required", message: "Give a fuller reason, including the ticket." });
      }
      if (!readOnly && req.staff.role !== "superadmin") {
        return res.status(403).json({ code: "write_requires_superadmin", message: "Write access needs a superadmin." });
      }
      const capped = Math.min(Number(minutes) || 30, 120);   // no open ended access
      const grant = await db.createSupportGrant({
        staffUserId: req.staff.id, workspaceId, reason: String(reason).trim(),
        readOnly: !!readOnly, grantedAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + capped * 60000).toISOString(),
      });
      /* written to the customer's own audit trail, not just ours */
      await db.writeAudit(workspaceId, { actorType: "staff", actorId: req.staff.id,
        action: "support.access.granted", detail: { reason, minutes: capped, readOnly: !!readOnly },
        severity: "warn" });
      res.status(201).json({ grant });
    } catch (e) { next(e); }
  });

  r.post("/workspaces/:id/suspend", staffOnly("superadmin"), async (req, res, next) => {
    try {
      const { reason, confirm } = req.body || {};
      /* suspension stops a customer working: it takes a senior role, a reason
         and an explicit confirmation, never a single click */
      if (confirm !== req.params.id) {
        return res.status(400).json({ code: "confirm_required",
          message: "Type the workspace id to confirm suspension." });
      }
      if (!reason || String(reason).trim().length < 12) {
        return res.status(400).json({ code: "reason_required", message: "A written reason is required." });
      }
      await db.setWorkspaceStatus(req.params.id, "suspended");
      await db.writeAudit(req.params.id, { actorType: "staff", actorId: req.staff.id,
        action: "workspace.suspended", detail: { reason }, severity: "critical" });
      res.json({ status: "suspended" });
    } catch (e) { next(e); }
  });

  return r;
}
