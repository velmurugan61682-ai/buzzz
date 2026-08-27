/**
 * Data access layer.
 *
 * Every read and write goes through here, for one reason: workspace isolation
 * has to be enforced in a single place. A query that forgets its tenant filter
 * is the failure that leaks one customer's data into another's screen, so the
 * scoped helpers below make the filter impossible to omit rather than merely
 * conventional.
 *
 * `pool` is any pg-compatible client ({ query(text, params) }), so this is
 * testable without a live database.
 */

export class DbError extends Error {
  constructor(message, code = "db_error") { super(message); this.name = "DbError"; this.code = code; }
}

/* A query that touches tenant data must carry a workspace id. This is checked
   at runtime, not left to review. */
function assertScope(workspaceId) {
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new DbError("A workspace id is required for this query", "missing_scope");
  }
  return workspaceId;
}

export function createDb(pool, { now = () => new Date().toISOString() } = {}) {
  const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
  const many = async (text, params) => (await pool.query(text, params)).rows;

  /* ---- transactions ----
     Provisioning creates a workspace, a membership, agents and workflows. A
     half-created workspace is worse than none, so callers get all or nothing. */
  const tx = async (fn) => {
    await pool.query("BEGIN");
    try {
      const out = await fn({ one, many });
      await pool.query("COMMIT");
      return out;
    } catch (e) {
      await pool.query("ROLLBACK");
      throw e;
    }
  };

  return {
    tx,

    /* ---- users and auth ---- */
    findUserByEmail: (email) => one("SELECT * FROM users WHERE lower(email) = lower($1)", [email]),
    findUserById: (id) => one("SELECT * FROM users WHERE id = $1", [id]),
    createUser: ({ email, name, passwordHash, emailVerified = false }) =>
      one(`INSERT INTO users (email, name, password_hash, email_verified)
           VALUES ($1,$2,$3,$4) RETURNING *`, [email, name, passwordHash, emailVerified]),
    updatePassword: (userId, hash) => one("UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id", [userId, hash]),
    markEmailVerified: (userId) => one("UPDATE users SET email_verified = true WHERE id = $1 RETURNING id", [userId]),

    createSession: ({ userId, tokenHash, ip, userAgent, expiresAt }) =>
      one(`INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`, [userId, tokenHash, ip, userAgent, expiresAt]),
    findSession: (tokenHash) => one("SELECT * FROM sessions WHERE token_hash = $1", [tokenHash]),
    revokeSession: (tokenHash, at) => one("UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 RETURNING id", [tokenHash, at]),
    revokeAllSessions: (userId, at, keepHash = null) =>
      pool.query(`UPDATE sessions SET revoked_at = $2
                  WHERE user_id = $1 AND revoked_at IS NULL AND ($3::text IS NULL OR token_hash <> $3)`,
        [userId, at, keepHash]),

    createEmailVerification: ({ userId, tokenHash, expiresAt }) =>
      one("INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1,$2,$3) RETURNING *", [userId, tokenHash, expiresAt]),
    findEmailVerification: (tokenHash) => one("SELECT * FROM email_verifications WHERE token_hash = $1", [tokenHash]),
    consumeEmailVerification: (id, at) => one("UPDATE email_verifications SET consumed_at = $2 WHERE id = $1 RETURNING id", [id, at]),

    createPasswordReset: ({ userId, tokenHash, expiresAt }) =>
      one("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3) RETURNING *", [userId, tokenHash, expiresAt]),
    findPasswordReset: (tokenHash) => one("SELECT * FROM password_resets WHERE token_hash = $1", [tokenHash]),
    consumePasswordReset: (id, at) => one("UPDATE password_resets SET consumed_at = $2 WHERE id = $1 RETURNING id", [id, at]),

    recordFailedLogin: ({ email, ip, at }) =>
      pool.query("INSERT INTO login_attempts (email, ip, at) VALUES ($1,$2,$3)", [email, ip, at || now()]),
    recentFailedLogins: async (email, since) =>
      Number((await one("SELECT count(*)::int AS n FROM login_attempts WHERE email = $1 AND at >= $2", [email, since]) || {}).n || 0),
    clearFailedLogins: (email) => pool.query("DELETE FROM login_attempts WHERE email = $1", [email]),

    /* ---- workspaces and membership ---- */
    listMemberships: (userId) =>
      many(`SELECT m.workspace_id AS "workspaceId", m.user_id AS "userId", m.role,
                   m.onboarding_complete AS "onboardingComplete", m.onboarding_step AS "onboardingStep",
                   m.last_active_at AS "lastActiveAt", w.name, w.status
            FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
            WHERE m.user_id = $1 AND w.status <> 'deleted'
            ORDER BY m.last_active_at DESC NULLS LAST`, [userId]),
    createWorkspace: ({ name, industry, region, timezone, currency, ownerId }) =>
      tx(async ({ one: q }) => {
        const ws = await q(`INSERT INTO workspaces (name, industry, region, timezone, currency)
                            VALUES ($1,$2,$3,$4,$5) RETURNING *`, [name, industry, region, timezone, currency]);
        await q(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [ws.id, ownerId]);
        return ws;
      }),
    setOnboardingState: (workspaceId, userId, { complete, step }) =>
      one(`UPDATE workspace_members SET onboarding_complete = COALESCE($3, onboarding_complete),
             onboarding_step = COALESCE($4, onboarding_step), last_active_at = now()
           WHERE workspace_id = $1 AND user_id = $2 RETURNING *`,
        [assertScope(workspaceId), userId, complete ?? null, step ?? null]),
    setWorkspaceStatus: (workspaceId, status) =>
      one("UPDATE workspaces SET status = $2 WHERE id = $1 RETURNING id, status", [assertScope(workspaceId), status]),

    /* ---- tenant scoped records ----
       Each of these takes the workspace id first and asserts it, so a caller
       cannot accidentally query across tenants. */
    listContacts: (workspaceId, { limit = 100, offset = 0 } = {}) =>
      many(`SELECT * FROM contacts WHERE workspace_id = $1 AND archived = false
            ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [assertScope(workspaceId), limit, offset]),
    getContact: (workspaceId, id) =>
      one("SELECT * FROM contacts WHERE workspace_id = $1 AND id = $2", [assertScope(workspaceId), id]),
    createContact: (workspaceId, c) =>
      one(`INSERT INTO contacts (workspace_id, name, email, phone, company, source, status, owner_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [assertScope(workspaceId), c.name, c.email, c.phone, c.company, c.source, c.status || "New", c.ownerId]),
    updateContact: (workspaceId, id, patch) => {
      const keys = Object.keys(patch);
      if (!keys.length) throw new DbError("Nothing to update", "empty_patch");
      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
      return one(`UPDATE contacts SET ${sets}, updated_at = now()
                  WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [assertScope(workspaceId), id, ...keys.map((k) => patch[k])]);
    },

    listConversations: (workspaceId, { limit = 50 } = {}) =>
      many(`SELECT * FROM conversations WHERE workspace_id = $1 ORDER BY last_message_at DESC LIMIT $2`,
        [assertScope(workspaceId), limit]),
    listAgents: (workspaceId) =>
      many("SELECT * FROM agents WHERE workspace_id = $1 ORDER BY created_at", [assertScope(workspaceId)]),
    listWorkflows: (workspaceId) =>
      many("SELECT * FROM workflows WHERE workspace_id = $1 ORDER BY created_at", [assertScope(workspaceId)]),
    getAppointment: (workspaceId, id) =>
      one("SELECT * FROM appointments WHERE workspace_id = $1 AND id = $2", [assertScope(workspaceId), id]),
    attachGoogleEvent: (workspaceId, apptId, f) =>
      one(`UPDATE appointments SET google_event_id = COALESCE($3, google_event_id),
             meet_url = COALESCE($4, meet_url), meet_id = COALESCE($5, meet_id),
             google_html_link = COALESCE($6, google_html_link), synced_at = $7,
             meeting_state = CASE WHEN COALESCE($4, meet_url) IS NOT NULL THEN 'ready' ELSE meeting_state END
           WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [assertScope(workspaceId), apptId, f.googleEventId, f.meetUrl, f.meetId, f.htmlLink, f.syncedAt || now()]),
    clearGoogleEvent: (workspaceId, apptId) =>
      one(`UPDATE appointments SET google_event_id = NULL, meet_url = NULL, meet_id = NULL,
             meeting_state = 'cancelled' WHERE workspace_id = $1 AND id = $2 RETURNING id`,
        [assertScope(workspaceId), apptId]),

    /* ---- google connection ---- */
    getGoogleConnection: (workspaceId) =>
      one(`SELECT id, workspace_id AS "workspaceId", email, refresh_token_sealed AS "refreshTokenSealed",
                  access_token AS "accessToken", expires_at AS "expiresAt", scope,
                  needs_reconnect AS "needsReconnect"
           FROM google_connections WHERE workspace_id = $1`, [assertScope(workspaceId)]),
    saveGoogleConnection: (c) =>
      one(`INSERT INTO google_connections (workspace_id, user_id, refresh_token_sealed, access_token, expires_at, scope, needs_reconnect)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (workspace_id) DO UPDATE SET refresh_token_sealed = EXCLUDED.refresh_token_sealed,
             access_token = EXCLUDED.access_token, expires_at = EXCLUDED.expires_at,
             scope = EXCLUDED.scope, needs_reconnect = false, updated_at = now()
           RETURNING id`,
        [assertScope(c.workspaceId), c.userId, c.refreshTokenSealed, c.accessToken, c.expiresAt, c.scope, c.needsReconnect || false]),
    updateGoogleTokens: (workspaceId, t) =>
      one(`UPDATE google_connections SET access_token = $2, expires_at = $3, updated_at = now()
           WHERE workspace_id = $1 RETURNING id`, [assertScope(workspaceId), t.accessToken, t.expiresAt]),
    deleteGoogleConnection: (workspaceId) =>
      pool.query("DELETE FROM google_connections WHERE workspace_id = $1", [assertScope(workspaceId)]),
    saveOAuthState: ({ state, workspaceId, userId, expiresAt }) =>
      one("INSERT INTO google_oauth_states (state, workspace_id, user_id, expires_at) VALUES ($1,$2,$3,$4) RETURNING state",
        [state, assertScope(workspaceId), userId, expiresAt]),
    consumeOAuthState: (state) =>
      one(`UPDATE google_oauth_states SET consumed_at = now()
           WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()
           RETURNING state, workspace_id AS "workspaceId", user_id AS "userId"`, [state]),

    /* ---- staff ---- */
    findStaffUserByEmail: (email) => one("SELECT * FROM staff_users WHERE lower(email) = lower($1)", [email]),
    findStaffUser: (id) => one("SELECT * FROM staff_users WHERE id = $1", [id]),
    createStaffSession: ({ staffUserId, tokenHash, ip, expiresAt }) =>
      one(`INSERT INTO staff_sessions (staff_user_id, token_hash, ip, expires_at)
           VALUES ($1,$2,$3,$4) RETURNING *`, [staffUserId, tokenHash, ip, expiresAt]),
    findStaffSession: (tokenHash) =>
      one(`SELECT id, staff_user_id AS "staffUserId", expires_at AS "expiresAt", revoked_at AS "revokedAt"
           FROM staff_sessions WHERE token_hash = $1`, [tokenHash]),
    createSupportGrant: (g) =>
      one(`INSERT INTO support_grants (staff_user_id, workspace_id, reason, read_only, expires_at)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [g.staffUserId, assertScope(g.workspaceId), g.reason, g.readOnly, g.expiresAt]),
    activeSupportGrant: (staffUserId, workspaceId) =>
      one(`SELECT * FROM support_grants WHERE staff_user_id = $1 AND workspace_id = $2
             AND ended_at IS NULL AND expires_at > now()`, [staffUserId, assertScope(workspaceId)]),

    /* ---- audit ----
       Append only by database rule; there is deliberately no update or delete
       method here for anyone to reach for. */
    writeAudit: (workspaceId, e) =>
      one(`INSERT INTO audit_events (workspace_id, actor_type, actor_id, action, target_type, target_id,
             outcome, severity, requested_level, effective_level, ip, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [workspaceId || null, e.actorType || "system", e.actorId || null, e.action,
         e.targetType || null, e.targetId || null, e.outcome || "ok", e.severity || "info",
         e.requestedLevel ?? null, e.effectiveLevel ?? null, e.ip || null, e.detail ? JSON.stringify(e.detail) : null]),
    listAuditEvents: ({ workspaceId = null, limit = 200 } = {}) =>
      many(`SELECT * FROM audit_events WHERE ($1::uuid IS NULL OR workspace_id = $1)
            ORDER BY at DESC LIMIT $2`, [workspaceId, limit]),

    /* ---- platform metrics ----
       Counted from the tables. Anything the platform cannot measure returns
       null rather than zero, because the console draws a hard line between
       "none" and "not measured". */
    platformMetrics: async () => {
      const row = await one(`
        SELECT
          (SELECT count(*)::int FROM workspaces WHERE status = 'active')                      AS workspaces,
          (SELECT count(DISTINCT user_id)::int FROM sessions
             WHERE created_at > now() - interval '7 days' AND revoked_at IS NULL)             AS "activeUsers7d",
          (SELECT count(*)::int FROM users WHERE created_at > now() - interval '7 days')      AS "signups7d",
          (SELECT count(*)::int FROM messages WHERE created_at::date = current_date)          AS "messagesToday",
          (SELECT count(*)::int FROM audit_events
             WHERE actor_type = 'agent' AND at > now() - interval '24 hours')                 AS "aiActions24h",
          (SELECT count(*)::int FROM approvals WHERE status = 'Pending')                      AS "approvalsPending",
          (SELECT count(*)::int FROM workflow_runs
             WHERE status = 'Failed' AND started_at > now() - interval '24 hours')            AS "workflowFailures24h",
          (SELECT count(*)::int FROM audit_events
             WHERE action LIKE 'integration.%' AND outcome = 'failed'
               AND at > now() - interval '24 hours')                                          AS "integrationFailures24h",
          (SELECT count(*)::int FROM audit_events
             WHERE severity IN ('error','critical') AND at > now() - interval '24 hours')     AS "apiErrors24h"
      `);
      return { ...row, storageBytes: null, mrr: null, churn: null };   // billing is not wired up
    },
    listWorkspaceSummaries: ({ limit = 100 } = {}) =>
      many(`SELECT w.id, w.name, w.industry, w.region, w.status, w.created_at AS "createdAt",
                   (SELECT count(*)::int FROM workspace_members m WHERE m.workspace_id = w.id) AS members,
                   (SELECT count(*)::int FROM agents a WHERE a.workspace_id = w.id)            AS agents,
                   (SELECT max(m2.last_active_at) FROM workspace_members m2 WHERE m2.workspace_id = w.id) AS "lastActiveAt"
            FROM workspaces w WHERE w.status <> 'deleted'
            ORDER BY w.created_at DESC LIMIT $1`, [limit]),
    listUsers: ({ limit = 100 } = {}) =>
      many(`SELECT id, email, name, email_verified AS "emailVerified", status, created_at AS "createdAt"
            FROM users ORDER BY created_at DESC LIMIT $1`, [limit]),
    systemHealth: async () => {
      const t0 = Date.now();
      await pool.query("SELECT 1");
      return { database: { ok: true, latencyMs: Date.now() - t0 }, api: { ok: true } };
    },
  };
}
