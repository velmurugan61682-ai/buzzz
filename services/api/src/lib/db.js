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
  constructor(message, code = "db_error") {
    super(message);
    this.name = "DbError";
    this.code = code;
  }
}

export class DuplicateError extends Error {
  constructor(field, message = `A record with this ${field} already exists in this workspace.`) {
    super(message);
    this.name = "DuplicateError";
    this.code = "duplicate_value";
    this.status = 409;
    this.field = field;
  }
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
  const handleQuery = async (fn, text, params) => {
    try {
      return await fn(text, params);
    } catch (err) {
      if (err.code === "23505" || err.code === "duplicate_value") {
        let field = "name";
        const constraint = String(err.constraint || err.detail || err.message || "").toLowerCase();
        if (constraint.includes("email")) field = "email";
        else if (constraint.includes("phone")) field = "phone";
        else if (constraint.includes("slug")) field = "slug";
        throw new DuplicateError(field, err.message || `A duplicate record with this ${field} already exists.`);
      }
      throw err;
    }
  };

  const one = async (text, params) => {
    const res = await handleQuery((t, p) => pool.query(t, p), text, params);
    return res.rows[0] || null;
  };
  const many = async (text, params) => {
    const res = await handleQuery((t, p) => pool.query(t, p), text, params);
    return res.rows;
  };

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
      one(
        `INSERT INTO users (email, name, password_hash, email_verified)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [email, name, passwordHash, emailVerified]
      ),
    updatePassword: (userId, hash) =>
      one("UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id", [userId, hash]),
    markEmailVerified: (userId) =>
      one("UPDATE users SET email_verified = true WHERE id = $1 RETURNING id", [userId]),

    createSession: ({ userId, tokenHash, ip, userAgent, expiresAt }) =>
      one(
        `INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [userId, tokenHash, ip, userAgent, expiresAt]
      ),
    findSession: (tokenHash) => one("SELECT * FROM sessions WHERE token_hash = $1", [tokenHash]),
    revokeSession: (tokenHash, at) =>
      one("UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 RETURNING id", [tokenHash, at]),
    revokeAllSessions: (userId, at, keepHash = null) =>
      pool.query(
        `UPDATE sessions SET revoked_at = $2
         WHERE user_id = $1 AND revoked_at IS NULL AND ($3::text IS NULL OR token_hash <> $3)`,
        [userId, at, keepHash]
      ),

    createEmailVerification: ({ userId, tokenHash, expiresAt }) =>
      one(
        "INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1,$2,$3) RETURNING *",
        [userId, tokenHash, expiresAt]
      ),
    findEmailVerification: (tokenHash) =>
      one("SELECT * FROM email_verifications WHERE token_hash = $1", [tokenHash]),
    consumeEmailVerification: (id, at) =>
      one("UPDATE email_verifications SET consumed_at = $2 WHERE id = $1 RETURNING id", [id, at]),

    createPasswordReset: ({ userId, tokenHash, expiresAt }) =>
      one(
        "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3) RETURNING *",
        [userId, tokenHash, expiresAt]
      ),
    findPasswordReset: (tokenHash) =>
      one("SELECT * FROM password_resets WHERE token_hash = $1", [tokenHash]),
    consumePasswordReset: (id, at) =>
      one("UPDATE password_resets SET consumed_at = $2 WHERE id = $1 RETURNING id", [id, at]),

    recordFailedLogin: ({ email, ip, at }) =>
      pool.query("INSERT INTO login_attempts (email, ip, at) VALUES ($1,$2,$3)", [
        email,
        ip,
        at || now(),
      ]),
    recentFailedLogins: async (email, since) =>
      Number(
        (
          await one(
            "SELECT count(*)::int AS n FROM login_attempts WHERE email = $1 AND at >= $2",
            [email, since]
          ) || {}
        ).n || 0
      ),
    clearFailedLogins: (email) =>
      pool.query("DELETE FROM login_attempts WHERE email = $1", [email]),

    /* ---- passkeys and mfa ---- */
    savePasskeyChallenge: ({ challenge, userId, purpose, expiresAt }) =>
      one(
        `INSERT INTO passkey_challenges (challenge, user_id, purpose, expires_at)
         VALUES ($1,$2,$3,$4) RETURNING challenge`,
        [challenge, userId, purpose, expiresAt]
      ),
    consumePasskeyChallenge: (challenge) =>
      one(
        `UPDATE passkey_challenges SET consumed_at = now()
         WHERE challenge = $1 AND consumed_at IS NULL AND expires_at > now()
         RETURNING challenge, user_id AS "userId", purpose`,
        [challenge]
      ),
    savePasskeyCredential: (c) =>
      one(
        `INSERT INTO passkey_credentials (credential_id, user_id, public_key, counter, device_type, backed_up, transports)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING credential_id`,
        [c.credentialId, c.userId, c.publicKey, c.counter, c.deviceType, c.backedUp, c.transports]
      ),
    listPasskeyCredentials: (userId) =>
      many(
        `SELECT credential_id AS "credentialId", public_key AS "publicKey", counter, transports
         FROM passkey_credentials WHERE user_id = $1`,
        [userId]
      ),
    saveTotpSecret: (userId, secret) =>
      one(
        `INSERT INTO totp_secrets (user_id, secret) VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET secret = EXCLUDED.secret, confirmed_at = NULL RETURNING user_id`,
        [userId, secret]
      ),
    confirmTotpSecret: (userId) =>
      one("UPDATE totp_secrets SET confirmed_at = now() WHERE user_id = $1 RETURNING user_id", [userId]),
    getTotpSecret: (userId) =>
      one(`SELECT secret, confirmed_at AS "confirmedAt" FROM totp_secrets WHERE user_id = $1`, [userId]),
    saveMfaRecoveryCodes: (userId, codeHashes) =>
      pool.query(
        `INSERT INTO mfa_recovery_codes (user_id, code_hash)
         SELECT $1, unnest($2::text[])`,
        [userId, codeHashes]
      ),
    consumeMfaRecoveryCode: (userId, codeHash) =>
      one(
        `UPDATE mfa_recovery_codes SET used_at = now()
         WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`,
        [userId, codeHash]
      ),

    /* ---- oauth states ---- */
    saveOAuthLoginState: ({ state, provider, verifier, redirectTo, expiresAt }) =>
      one(
        `INSERT INTO oauth_login_states (state, provider, verifier, redirect_to, expires_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING state`,
        [state, provider, verifier, redirectTo, expiresAt]
      ),
    consumeOAuthLoginState: (state) =>
      one(
        `UPDATE oauth_login_states SET consumed_at = now()
         WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()
         RETURNING state, provider, verifier, redirect_to AS "redirectTo"`,
        [state]
      ),

    /* ---- workspaces and membership ---- */
    listMemberships: (userId) =>
      many(
        `SELECT m.workspace_id AS "workspaceId", m.user_id AS "userId", m.role,
                m.onboarding_complete AS "onboardingComplete", m.onboarding_step AS "onboardingStep",
                m.last_active_at AS "lastActiveAt", w.name, w.status
         FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = $1 AND w.status <> 'deleted'
         ORDER BY m.last_active_at DESC NULLS LAST`,
        [userId]
      ),
    createWorkspace: ({ name, industry, region, timezone, currency, ownerId }) =>
      tx(async ({ one: q }) => {
        const ws = await q(
          `INSERT INTO workspaces (name, industry, region, timezone, currency)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [name, industry, region, timezone, currency]
        );
        await q(
          `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')`,
          [ws.id, ownerId]
        );
        return ws;
      }),
    setOnboardingState: (workspaceId, userId, { complete, step }) =>
      one(
        `UPDATE workspace_members SET onboarding_complete = COALESCE($3, onboarding_complete),
           onboarding_step = COALESCE($4, onboarding_step), last_active_at = now()
         WHERE workspace_id = $1 AND user_id = $2 RETURNING *`,
        [assertScope(workspaceId), userId, complete ?? null, step ?? null]
      ),
    setWorkspaceStatus: (workspaceId, status) =>
      one("UPDATE workspaces SET status = $2 WHERE id = $1 RETURNING id, status", [
        assertScope(workspaceId),
        status,
      ]),

    /* ---- contacts & identities ---- */
    listContacts: (workspaceId, { limit = 100, offset = 0 } = {}) =>
      many(
        `SELECT * FROM contacts WHERE workspace_id = $1 AND archived = false
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [assertScope(workspaceId), limit, offset]
      ),
    getContact: (workspaceId, id) =>
      one("SELECT * FROM contacts WHERE workspace_id = $1 AND id = $2", [
        assertScope(workspaceId),
        id,
      ]),
    createContact: (workspaceId, c) =>
      one(
        `INSERT INTO contacts (workspace_id, name, email, phone, company, source, status, owner_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          assertScope(workspaceId),
          c.name,
          c.email,
          c.phone,
          c.company,
          c.source,
          c.status || "New",
          c.ownerId,
        ]
      ),
    updateContact: async (workspaceId, id, patch) => {
      const keys = Object.keys(patch);
      if (!keys.length) throw new DbError("Nothing to update", "empty_patch");

      if (patch.email) {
        const existing = await one(
          `SELECT id, name FROM contacts WHERE workspace_id = $1 AND lower(email) = lower($2) AND id != $3 AND archived = false`,
          [assertScope(workspaceId), patch.email, id]
        );
        if (existing) {
          throw new DuplicateError("email", `Email '${patch.email}' is already used by contact '${existing.name}'.`);
        }
      }

      if (patch.phone) {
        const existing = await one(
          `SELECT id, name FROM contacts WHERE workspace_id = $1 AND phone = $2 AND id != $3 AND archived = false`,
          [assertScope(workspaceId), patch.phone, id]
        );
        if (existing) {
          throw new DuplicateError("phone", `Phone number '${patch.phone}' is already used by contact '${existing.name}'.`);
        }
      }

      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
      return one(
        `UPDATE contacts SET ${sets}, updated_at = now()
         WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [assertScope(workspaceId), id, ...keys.map((k) => patch[k])]
      );
    },

    /* ---- companies ---- */
    listCompanies: (workspaceId, { limit = 100, offset = 0 } = {}) =>
      many(
        `SELECT * FROM companies WHERE workspace_id = $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [assertScope(workspaceId), limit, offset]
      ),
    getCompany: (workspaceId, id) =>
      one("SELECT * FROM companies WHERE workspace_id = $1 AND id = $2", [
        assertScope(workspaceId),
        id,
      ]),
    createCompany: (workspaceId, c) =>
      one(
        `INSERT INTO companies (workspace_id, name, parent_id, country, domain, industry)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [assertScope(workspaceId), c.name, c.parentId || null, c.country, c.domain, c.industry]
      ),
    updateCompany: (workspaceId, id, patch) => {
      const keys = Object.keys(patch);
      if (!keys.length) throw new DbError("Nothing to update", "empty_patch");
      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
      return one(
        `UPDATE companies SET ${sets} WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [assertScope(workspaceId), id, ...keys.map((k) => patch[k])]
      );
    },
    deleteCompany: (workspaceId, id) =>
      pool.query("DELETE FROM companies WHERE workspace_id = $1 AND id = $2", [
        assertScope(workspaceId),
        id,
      ]),

    /* ---- deals ---- */
    listDeals: (workspaceId, { limit = 100, offset = 0 } = {}) =>
      many(
        `SELECT * FROM deals WHERE workspace_id = $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [assertScope(workspaceId), limit, offset]
      ),
    getDeal: (workspaceId, id) =>
      one("SELECT * FROM deals WHERE workspace_id = $1 AND id = $2", [
        assertScope(workspaceId),
        id,
      ]),
    createDeal: (workspaceId, d) =>
      one(
        `INSERT INTO deals (workspace_id, name, contact_id, company_id, value_minor, currency, stage, probability, owner_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          assertScope(workspaceId),
          d.name,
          d.contactId || null,
          d.companyId || null,
          d.valueMinor || 0,
          d.currency || "USD",
          d.stage || "Lead",
          d.probability ?? 20,
          d.ownerId || null,
        ]
      ),
    updateDeal: (workspaceId, id, patch) => {
      const keys = Object.keys(patch);
      if (!keys.length) throw new DbError("Nothing to update", "empty_patch");
      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
      return one(
        `UPDATE deals SET ${sets} WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [assertScope(workspaceId), id, ...keys.map((k) => patch[k])]
      );
    },
    deleteDeal: (workspaceId, id) =>
      pool.query("DELETE FROM deals WHERE workspace_id = $1 AND id = $2", [
        assertScope(workspaceId),
        id,
      ]),

    /* ---- tasks ---- */
    listTasks: (workspaceId, { limit = 100, offset = 0, status = null } = {}) =>
      many(
        `SELECT * FROM tasks WHERE workspace_id = $1 AND ($4::text IS NULL OR status = $4)
         ORDER BY due_date ASC NULLS LAST, created_at DESC LIMIT $2 OFFSET $3`,
        [assertScope(workspaceId), limit, offset, status]
      ),
    getTask: (workspaceId, id) =>
      one("SELECT * FROM tasks WHERE workspace_id = $1 AND id = $2", [
        assertScope(workspaceId),
        id,
      ]),
    createTask: (workspaceId, t) =>
      one(
        `INSERT INTO tasks (workspace_id, title, description, status, priority, due_date, assignee_id, contact_id, company_id, deal_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          assertScope(workspaceId),
          t.title,
          t.description || null,
          t.status || "pending",
          t.priority || "medium",
          t.dueDate || null,
          t.assigneeId || null,
          t.contactId || null,
          t.companyId || null,
          t.dealId || null,
          t.createdBy || null,
        ]
      ),
    updateTask: (workspaceId, id, patch) => {
      const keys = Object.keys(patch);
      if (!keys.length) throw new DbError("Nothing to update", "empty_patch");
      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
      return one(
        `UPDATE tasks SET ${sets}, updated_at = now()
         WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [assertScope(workspaceId), id, ...keys.map((k) => patch[k])]
      );
    },
    deleteTask: (workspaceId, id) =>
      pool.query("DELETE FROM tasks WHERE workspace_id = $1 AND id = $2", [
        assertScope(workspaceId),
        id,
      ]),

    /* ---- conversations and messages ---- */
    listConversations: (workspaceId, { limit = 50 } = {}) =>
      many(
        `SELECT * FROM conversations WHERE workspace_id = $1 ORDER BY last_message_at DESC LIMIT $2`,
        [assertScope(workspaceId), limit]
      ),
    getConversation: (workspaceId, id) =>
      one("SELECT * FROM conversations WHERE workspace_id = $1 AND id = $2", [
        assertScope(workspaceId),
        id,
      ]),
    createConversation: (workspaceId, c) =>
      one(
        `INSERT INTO conversations (workspace_id, contact_id, channel, state, assignee_id, agent_id, ai_enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          assertScope(workspaceId),
          c.contactId || null,
          c.channel,
          c.state || "open",
          c.assigneeId || null,
          c.agentId || null,
          c.aiEnabled ?? true,
        ]
      ),
    updateConversationState: (workspaceId, id, state) =>
      one(
        `UPDATE conversations SET state = $3, last_message_at = now()
         WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [assertScope(workspaceId), id, state]
      ),
    listMessages: (workspaceId, conversationId, { limit = 100, offset = 0 } = {}) =>
      many(
        `SELECT * FROM messages WHERE workspace_id = $1 AND conversation_id = $2
         ORDER BY created_at ASC LIMIT $3 OFFSET $4`,
        [assertScope(workspaceId), conversationId, limit, offset]
      ),
    createMessage: (workspaceId, m) =>
      tx(async ({ one: q }) => {
        const msg = await q(
          `INSERT INTO messages (workspace_id, conversation_id, direction, author, body, media, provider_message_id, delivery_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            assertScope(workspaceId),
            m.conversationId,
            m.direction,
            m.author,
            m.body,
            m.media ? JSON.stringify(m.media) : null,
            m.providerMessageId || null,
            m.deliveryStatus || "sent",
          ]
        );
        await q(
          `UPDATE conversations SET last_message_at = now() WHERE workspace_id = $1 AND id = $2`,
          [assertScope(workspaceId), m.conversationId]
        );
        return msg;
      }),
    findContactByPhoneOrEmail: (workspaceId, { phone, email }) =>
      one(
        `SELECT * FROM contacts WHERE workspace_id = $1 AND archived = false
         AND (($2::text IS NOT NULL AND (phone = $2 OR phone_norm = $2))
              OR ($3::citext IS NOT NULL AND email = $3::citext))
         LIMIT 1`,
        [assertScope(workspaceId), phone || null, email || null]
      ),
    findConversationByContact: (workspaceId, contactId, channel) =>
      one(
        `SELECT * FROM conversations WHERE workspace_id = $1 AND contact_id = $2 AND channel = $3
         ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
        [assertScope(workspaceId), contactId, channel]
      ),
    assignConversation: (workspaceId, id, { assigneeId, queueId }) =>
      one(
        `UPDATE conversations SET assignee_id = COALESCE($3, assignee_id), queue_id = COALESCE($4, queue_id)
         WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [assertScope(workspaceId), id, assigneeId || null, queueId || null]
      ),
    updateMessageDeliveryStatus: (workspaceId, providerMessageId, status) =>
      one(
        `UPDATE messages SET delivery_status = $3
         WHERE workspace_id = $1 AND provider_message_id = $2 RETURNING *`,
        [assertScope(workspaceId), providerMessageId, status]
      ),
    recordWebhookDelivery: ({ workspaceId = null, provider, eventId, status = "received", error = null }) =>
      one(
        `INSERT INTO webhook_deliveries (workspace_id, provider, event_id, status, error)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (provider, event_id) DO UPDATE SET attempts = webhook_deliveries.attempts + 1, status = EXCLUDED.status, error = EXCLUDED.error
         RETURNING *`,
        [workspaceId, provider, eventId, status, error]
      ),
    findWebhookDelivery: (provider, eventId) =>
      one(`SELECT * FROM webhook_deliveries WHERE provider = $1 AND event_id = $2`, [provider, eventId]),
    listQueues: (workspaceId) =>
      many(`SELECT * FROM queues WHERE workspace_id = $1 ORDER BY created_at`, [assertScope(workspaceId)]),
    createQueue: (workspaceId, q) =>
      one(
        `INSERT INTO queues (workspace_id, name, channels, intents, strategy, sla_minutes, fallback_role)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          assertScope(workspaceId),
          q.name,
          q.channels || [],
          q.intents || [],
          q.strategy || "round_robin",
          q.slaMinutes || 30,
          q.fallbackRole || null,
        ]
      ),
    listAppointments: (workspaceId, { limit = 100, offset = 0 } = {}) =>
      many(
        `SELECT * FROM appointments WHERE workspace_id = $1
         ORDER BY starts_at ASC LIMIT $2 OFFSET $3`,
        [assertScope(workspaceId), limit, offset]
      ),
    getAppointment: (workspaceId, id) =>
      one("SELECT * FROM appointments WHERE workspace_id = $1 AND id = $2", [
        assertScope(workspaceId),
        id,
      ]),
    createAppointment: (workspaceId, a) =>
      one(
        `INSERT INTO appointments (workspace_id, contact_id, staff_id, service_id, location_id, starts_at, duration_minutes, status, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          assertScope(workspaceId),
          a.contactId || null,
          a.staffId || null,
          a.serviceId || null,
          a.locationId || null,
          a.startsAt,
          a.durationMinutes,
          a.status || "pending",
          a.source || "web",
        ]
      ),
    updateAppointment: (workspaceId, id, patch) => {
      const keys = Object.keys(patch);
      if (!keys.length) throw new DbError("Nothing to update", "empty_patch");
      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
      return one(
        `UPDATE appointments SET ${sets} WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [assertScope(workspaceId), id, ...keys.map((k) => patch[k])]
      );
    },
    attachGoogleEvent: (workspaceId, apptId, f) =>
      one(
        `UPDATE appointments SET google_event_id = COALESCE($3, google_event_id),
           meet_url = COALESCE($4, meet_url), meet_id = COALESCE($5, meet_id),
           google_html_link = COALESCE($6, google_html_link), synced_at = $7,
           meeting_state = CASE WHEN COALESCE($4, meet_url) IS NOT NULL THEN 'ready' ELSE meeting_state END
         WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [
          assertScope(workspaceId),
          apptId,
          f.googleEventId,
          f.meetUrl,
          f.meetId,
          f.htmlLink,
          f.syncedAt || now(),
        ]
      ),
    clearGoogleEvent: (workspaceId, apptId) =>
      one(
        `UPDATE appointments SET google_event_id = NULL, meet_url = NULL, meet_id = NULL,
           meeting_state = 'cancelled' WHERE workspace_id = $1 AND id = $2 RETURNING id`,
        [assertScope(workspaceId), apptId]
      ),

    /* ---- locations ---- */
    listLocations: (workspaceId) =>
      many(`SELECT * FROM locations WHERE workspace_id = $1 AND is_active = true ORDER BY name ASC`, [
        assertScope(workspaceId),
      ]),
    getLocation: (workspaceId, id) =>
      one(`SELECT * FROM locations WHERE workspace_id = $1 AND id = $2`, [assertScope(workspaceId), id]),
    createLocation: (workspaceId, loc) =>
      one(
        `INSERT INTO locations (workspace_id, name, timezone, address, phone, operating_hours)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          assertScope(workspaceId),
          loc.name,
          loc.timezone || "UTC",
          loc.address || null,
          loc.phone || null,
          loc.operatingHours ? JSON.stringify(loc.operatingHours) : null,
        ]
      ),
    updateLocation: (workspaceId, id, patch) => {
      const keys = Object.keys(patch);
      if (!keys.length) throw new DbError("Nothing to update", "empty_patch");
      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
      return one(
        `UPDATE locations SET ${sets} WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [assertScope(workspaceId), id, ...keys.map((k) => patch[k])]
      );
    },

    /* ---- services ---- */
    listServices: (workspaceId, { category = null } = {}) =>
      many(
        `SELECT * FROM services WHERE workspace_id = $1 AND is_active = true
         AND ($2::text IS NULL OR category = $2) ORDER BY name ASC`,
        [assertScope(workspaceId), category]
      ),
    getService: (workspaceId, id) =>
      one(`SELECT * FROM services WHERE workspace_id = $1 AND id = $2`, [assertScope(workspaceId), id]),
    createService: (workspaceId, svc) =>
      one(
        `INSERT INTO services (workspace_id, name, category, description, duration_minutes, buffer_before_minutes, buffer_after_minutes, price_minor, currency, capacity, is_virtual)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          assertScope(workspaceId),
          svc.name,
          svc.category || "General",
          svc.description || null,
          svc.durationMinutes || 30,
          svc.bufferBeforeMinutes || 0,
          svc.bufferAfterMinutes || 0,
          svc.priceMinor || 0,
          svc.currency || "USD",
          svc.capacity || 1,
          svc.isVirtual || false,
        ]
      ),
    updateService: (workspaceId, id, patch) => {
      const keys = Object.keys(patch);
      if (!keys.length) throw new DbError("Nothing to update", "empty_patch");
      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
      return one(
        `UPDATE services SET ${sets} WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [assertScope(workspaceId), id, ...keys.map((k) => patch[k])]
      );
    },

    /* ---- staff schedules ---- */
    listStaffSchedules: (workspaceId, staffId) =>
      many(
        `SELECT * FROM staff_schedules WHERE workspace_id = $1 AND staff_id = $2 AND is_active = true ORDER BY day_of_week ASC`,
        [assertScope(workspaceId), staffId]
      ),
    setStaffSchedule: (workspaceId, { staffId, dayOfWeek, startTime, endTime }) =>
      one(
        `INSERT INTO staff_schedules (workspace_id, staff_id, day_of_week, start_time, end_time)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [assertScope(workspaceId), staffId, dayOfWeek, startTime, endTime]
      ),
    getStaffAppointmentsForDate: (workspaceId, staffId, startDate, endDate) =>
      many(
        `SELECT * FROM appointments WHERE workspace_id = $1 AND staff_id = $2
         AND status NOT IN ('cancelled') AND starts_at >= $3 AND starts_at < $4
         ORDER BY starts_at ASC`,
        [assertScope(workspaceId), staffId, startDate, endDate]
      ),

    /* ---- agents ---- */
    listAgents: (workspaceId) =>
      many("SELECT * FROM agents WHERE workspace_id = $1 ORDER BY created_at", [
        assertScope(workspaceId),
      ]),
    getAgent: (workspaceId, id) =>
      one("SELECT * FROM agents WHERE workspace_id = $1 AND id = $2", [
        assertScope(workspaceId),
        id,
      ]),
    createAgent: (workspaceId, a) =>
      one(
        `INSERT INTO agents (workspace_id, name, title, type, status, autonomy, role, purpose, instructions, tone, channels, tools, guardrails, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [
          assertScope(workspaceId),
          a.name,
          a.title || null,
          a.type || "support",
          a.status || "draft",
          a.autonomy ?? 1,
          a.role || null,
          a.purpose || null,
          a.instructions ? JSON.stringify(a.instructions) : null,
          a.tone || "helpful",
          a.channels || [],
          a.tools || [],
          a.guardrails || [],
          a.createdBy || null,
        ]
      ),
    updateAgent: async (workspaceId, id, patch) => {
      const keys = Object.keys(patch);
      if (!keys.length) throw new DbError("Nothing to update", "empty_patch");

      if (patch.name) {
        const existing = await one(
          `SELECT id, name FROM agents WHERE workspace_id = $1 AND lower(name) = lower($2) AND id != $3`,
          [assertScope(workspaceId), patch.name, id]
        );
        if (existing) {
          throw new DuplicateError("name", `Agent name '${patch.name}' is already used in this workspace.`);
        }
      }

      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
      return one(
        `UPDATE agents SET ${sets} WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [assertScope(workspaceId), id, ...keys.map((k) => patch[k])]
      );
    },
    createAgentVersion: (agentId, snapshot, createdBy) =>
      one(
        `INSERT INTO agent_versions (agent_id, snapshot, created_by)
         VALUES ($1,$2,$3) RETURNING *`,
        [agentId, JSON.stringify(snapshot), createdBy || null]
      ),
    listAgentVersions: (agentId) =>
      many(`SELECT * FROM agent_versions WHERE agent_id = $1 ORDER BY created_at DESC`, [agentId]),
    getAgentVersion: (agentId, versionId) =>
      one(`SELECT * FROM agent_versions WHERE agent_id = $1 AND id = $2`, [agentId, versionId]),
    deleteAgent: (workspaceId, id) =>
      one(`DELETE FROM agents WHERE workspace_id = $1 AND id = $2 RETURNING id`, [
        assertScope(workspaceId),
        id,
      ]),

    /* ---- workflows ---- */
    listWorkflows: (workspaceId) =>
      many("SELECT * FROM workflows WHERE workspace_id = $1 ORDER BY created_at", [
        assertScope(workspaceId),
      ]),
    getWorkflow: (workspaceId, id) =>
      one("SELECT * FROM workflows WHERE workspace_id = $1 AND id = $2", [
        assertScope(workspaceId),
        id,
      ]),
    createWorkflow: (workspaceId, w) =>
      one(
        `INSERT INTO workflows (workspace_id, name, description, status, current_version, nodes, edges, variables, settings, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          assertScope(workspaceId),
          w.name,
          w.description || null,
          w.status || "draft",
          w.currentVersion || 1,
          w.nodes ? JSON.stringify(w.nodes) : "[]",
          w.edges ? JSON.stringify(w.edges) : "[]",
          w.variables ? JSON.stringify(w.variables) : "[]",
          w.settings ? JSON.stringify(w.settings) : "{}",
          w.createdBy || null,
        ]
      ),
    updateWorkflow: async (workspaceId, id, patch) => {
      const keys = Object.keys(patch);
      if (!keys.length) throw new DbError("Nothing to update", "empty_patch");

      if (patch.name) {
        const existing = await one(
          `SELECT id, name FROM workflows WHERE workspace_id = $1 AND lower(name) = lower($2) AND id != $3 AND status != 'archived'`,
          [assertScope(workspaceId), patch.name, id]
        );
        if (existing) {
          throw new DuplicateError("name", `Workflow name '${patch.name}' is already used in this workspace.`);
        }
      }

      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
      return one(
        `UPDATE workflows SET ${sets}, updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [assertScope(workspaceId), id, ...keys.map((k) => (typeof patch[k] === "object" && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]))]
      );
    },
    deleteWorkflow: (workspaceId, id) =>
      one(`DELETE FROM workflows WHERE workspace_id = $1 AND id = $2 RETURNING id`, [
        assertScope(workspaceId),
        id,
      ]),
    createWorkflowVersion: (workflowId, version, graph, publishedBy) =>
      one(
        `INSERT INTO workflow_versions (workflow_id, version, graph, published_at, published_by)
         VALUES ($1,$2,$3,now(),$4) RETURNING *`,
        [workflowId, version, JSON.stringify(graph), publishedBy || null]
      ),
    getWorkflowVersion: (workflowId, version) =>
      one(
        `SELECT * FROM workflow_versions WHERE workflow_id = $1 AND version = $2`,
        [workflowId, version]
      ),
    createWorkflowRun: (workspaceId, r) =>
      one(
        `INSERT INTO workflow_runs (workspace_id, workflow_id, version, event_id, idempotency_key, status, context, is_test)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          assertScope(workspaceId),
          r.workflowId,
          r.version || 1,
          r.eventId || null,
          r.idempotencyKey || null,
          r.status || "running",
          JSON.stringify(r.context || {}),
          r.isTest || false,
        ]
      ),
    updateWorkflowRun: (workspaceId, id, patch) => {
      const keys = Object.keys(patch);
      if (!keys.length) throw new DbError("Nothing to update", "empty_patch");
      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
      return one(
        `UPDATE workflow_runs SET ${sets} WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [assertScope(workspaceId), id, ...keys.map((k) => (typeof patch[k] === "object" && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]))]
      );
    },
    listWorkflowRuns: (workspaceId, workflowId, { limit = 50 } = {}) =>
      many(
        `SELECT * FROM workflow_runs WHERE workspace_id = $1 AND workflow_id = $2
         ORDER BY started_at DESC LIMIT $3`,
        [assertScope(workspaceId), workflowId, limit]
      ),
    getWorkflowRun: (workspaceId, id) =>
      one(`SELECT * FROM workflow_runs WHERE workspace_id = $1 AND id = $2`, [
        assertScope(workspaceId),
        id,
      ]),
    recordNodeExecution: (runId, n) =>
      one(
        `INSERT INTO node_executions (run_id, node_id, node_type, status, branch, note, started_at, finished_at, input, output)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          runId,
          n.nodeId,
          n.nodeType,
          n.status || "completed",
          n.branch || null,
          n.note || null,
          n.startedAt || new Date().toISOString(),
          n.finishedAt || new Date().toISOString(),
          n.input ? JSON.stringify(n.input) : null,
          n.output ? JSON.stringify(n.output) : null,
        ]
      ),
    listNodeExecutions: (runId) =>
      many(`SELECT * FROM node_executions WHERE run_id = $1 ORDER BY started_at ASC`, [runId]),

    /* ---- campaigns ---- */
    listCampaigns: (workspaceId) =>
      many("SELECT * FROM campaigns WHERE workspace_id = $1 ORDER BY created_at DESC", [
        assertScope(workspaceId),
      ]),
    getCampaign: (workspaceId, id) =>
      one("SELECT * FROM campaigns WHERE workspace_id = $1 AND id = $2", [
        assertScope(workspaceId),
        id,
      ]),
    createCampaign: (workspaceId, c) =>
      one(
        `INSERT INTO campaigns (workspace_id, name, channel, status, audience, body, variant_body, schedule)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          assertScope(workspaceId),
          c.name,
          c.channel,
          c.status || "draft",
          c.audience ? JSON.stringify(c.audience) : null,
          c.body || null,
          c.variantBody || null,
          c.schedule ? JSON.stringify(c.schedule) : null,
        ]
      ),

    /* ---- knowledge base ---- */
    listKbSources: (workspaceId) =>
      many("SELECT * FROM kb_sources WHERE workspace_id = $1 AND archived = false ORDER BY created_at", [
        assertScope(workspaceId),
      ]),
    getKbSource: (workspaceId, id) =>
      one("SELECT * FROM kb_sources WHERE workspace_id = $1 AND id = $2", [
        assertScope(workspaceId),
        id,
      ]),
    createKbSource: (workspaceId, s) =>
      one(
        `INSERT INTO kb_sources (workspace_id, name, type, collection, priority, status, url, refresh_cadence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          assertScope(workspaceId),
          s.name,
          s.type,
          s.collection || null,
          s.priority || 3,
          s.status || "ready",
          s.url || null,
          s.refreshCadence || null,
        ]
      ),
    deleteKbSource: (workspaceId, id) =>
      one("UPDATE kb_sources SET archived = true WHERE workspace_id = $1 AND id = $2 RETURNING id", [
        assertScope(workspaceId),
        id,
      ]),

    /* ---- approvals ---- */
    listApprovals: (workspaceId, { status = null, limit = 50 } = {}) =>
      many(
        `SELECT * FROM approvals WHERE workspace_id = $1 AND ($3::text IS NULL OR status = $3)
         ORDER BY created_at DESC LIMIT $2`,
        [assertScope(workspaceId), limit, status]
      ),
    getApproval: (workspaceId, id) =>
      one("SELECT * FROM approvals WHERE workspace_id = $1 AND id = $2", [
        assertScope(workspaceId),
        id,
      ]),
    createApproval: (workspaceId, a) =>
      one(
        `INSERT INTO approvals (workspace_id, agent_id, requested_by, action_key, category, title, body, risk, required_role, status, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          assertScope(workspaceId),
          a.agentId || null,
          a.requestedBy || null,
          a.actionKey,
          a.category,
          a.title || null,
          a.body || null,
          a.risk || "medium",
          a.requiredRole || "Admin",
          a.status || "pending",
          a.idempotencyKey || null,
        ]
      ),
    decideApproval: (workspaceId, id, { decidedBy, status, rejectReason }) =>
      one(
        `UPDATE approvals SET status = $3, decided_by = $4, decided_at = now(), reject_reason = $5
         WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [assertScope(workspaceId), id, status, decidedBy, rejectReason || null]
      ),

    /* ---- google connection ---- */
    getGoogleConnection: (workspaceId) =>
      one(
        `SELECT id, workspace_id AS "workspaceId", email, refresh_token_sealed AS "refreshTokenSealed",
                access_token AS "accessToken", expires_at AS "expiresAt", scope,
                needs_reconnect AS "needsReconnect"
         FROM google_connections WHERE workspace_id = $1`,
        [assertScope(workspaceId)]
      ),
    saveGoogleConnection: (c) =>
      one(
        `INSERT INTO google_connections (workspace_id, user_id, refresh_token_sealed, access_token, expires_at, scope, needs_reconnect)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (workspace_id) DO UPDATE SET refresh_token_sealed = EXCLUDED.refresh_token_sealed,
           access_token = EXCLUDED.access_token, expires_at = EXCLUDED.expires_at,
           scope = EXCLUDED.scope, needs_reconnect = false, updated_at = now()
         RETURNING id`,
        [
          assertScope(c.workspaceId),
          c.userId,
          c.refreshTokenSealed,
          c.accessToken,
          c.expiresAt,
          c.scope,
          c.needsReconnect || false,
        ]
      ),
    updateGoogleTokens: (workspaceId, t) =>
      one(
        `UPDATE google_connections SET access_token = $2, expires_at = $3, updated_at = now()
         WHERE workspace_id = $1 RETURNING id`,
        [assertScope(workspaceId), t.accessToken, t.expiresAt]
      ),
    deleteGoogleConnection: (workspaceId) =>
      pool.query("DELETE FROM google_connections WHERE workspace_id = $1", [
        assertScope(workspaceId),
      ]),
    saveOAuthState: ({ state, workspaceId, userId, expiresAt }) =>
      one(
        "INSERT INTO google_oauth_states (state, workspace_id, user_id, expires_at) VALUES ($1,$2,$3,$4) RETURNING state",
        [state, assertScope(workspaceId), userId, expiresAt]
      ),
    consumeOAuthState: (state) =>
      one(
        `UPDATE google_oauth_states SET consumed_at = now()
         WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()
         RETURNING state, workspace_id AS "workspaceId", user_id AS "userId"`,
        [state]
      ),

    /* ---- staff ---- */
    findStaffUserByEmail: (email) =>
      one("SELECT * FROM staff_users WHERE lower(email) = lower($1)", [email]),
    findStaffUser: (id) => one("SELECT * FROM staff_users WHERE id = $1", [id]),
    createStaffSession: ({ staffUserId, tokenHash, ip, expiresAt }) =>
      one(
        `INSERT INTO staff_sessions (staff_user_id, token_hash, ip, expires_at)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [staffUserId, tokenHash, ip, expiresAt]
      ),
    findStaffSession: (tokenHash) =>
      one(
        `SELECT id, staff_user_id AS "staffUserId", expires_at AS "expiresAt", revoked_at AS "revokedAt"
         FROM staff_sessions WHERE token_hash = $1`,
        [tokenHash]
      ),
    createSupportGrant: (g) =>
      one(
        `INSERT INTO support_grants (staff_user_id, workspace_id, reason, read_only, expires_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [g.staffUserId, assertScope(g.workspaceId), g.reason, g.readOnly, g.expiresAt]
      ),
    activeSupportGrant: (staffUserId, workspaceId) =>
      one(
        `SELECT * FROM support_grants WHERE staff_user_id = $1 AND workspace_id = $2
           AND ended_at IS NULL AND expires_at > now()`,
        [staffUserId, assertScope(workspaceId)]
      ),

    /* ---- audit & activity ---- */
    writeAudit: (workspaceId, e) =>
      one(
        `INSERT INTO audit_events (workspace_id, actor_type, actor_id, action, target_type, target_id,
           outcome, severity, requested_level, effective_level, ip, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          workspaceId || null,
          e.actorType || "system",
          e.actorId || null,
          e.action,
          e.targetType || null,
          e.targetId || null,
          e.outcome || "ok",
          e.severity || "info",
          e.requestedLevel ?? null,
          e.effectiveLevel ?? null,
          e.ip || null,
          e.detail ? JSON.stringify(e.detail) : null,
        ]
      ),
    listAuditEvents: ({ workspaceId = null, limit = 200 } = {}) =>
      many(
        `SELECT * FROM audit_events WHERE ($1::uuid IS NULL OR workspace_id = $1)
         ORDER BY at DESC LIMIT $2`,
        [workspaceId, limit]
      ),

    /* ---- platform metrics ---- */
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
      return { ...row, storageBytes: null, mrr: null, churn: null };
    },
    listWorkspaceSummaries: ({ limit = 100 } = {}) =>
      many(
        `SELECT w.id, w.name, w.industry, w.region, w.status, w.created_at AS "createdAt",
                (SELECT count(*)::int FROM workspace_members m WHERE m.workspace_id = w.id) AS members,
                (SELECT count(*)::int FROM agents a WHERE a.workspace_id = w.id)            AS agents,
                (SELECT max(m2.last_active_at) FROM workspace_members m2 WHERE m2.workspace_id = w.id) AS "lastActiveAt"
         FROM workspaces w WHERE w.status <> 'deleted'
         ORDER BY w.created_at DESC LIMIT $1`,
        [limit]
      ),
    listUsers: ({ limit = 100 } = {}) =>
      many(
        `SELECT id, email, name, email_verified AS "emailVerified", status, created_at AS "createdAt"
         FROM users ORDER BY created_at DESC LIMIT $1`,
        [limit]
      ),
    /* ---- subscriptions & billing ---- */
    getSubscription: (workspaceId) =>
      one("SELECT * FROM subscriptions WHERE workspace_id = $1", [assertScope(workspaceId)]),
    saveSubscription: (workspaceId, s) =>
      one(
        `INSERT INTO subscriptions (workspace_id, plan, cycle, status, region, currency, current_period_end, trial_ends_at, provider_customer_id, provider_subscription_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (workspace_id) DO UPDATE SET
           plan = EXCLUDED.plan, cycle = EXCLUDED.cycle, status = EXCLUDED.status,
           region = EXCLUDED.region, currency = EXCLUDED.currency,
           current_period_end = EXCLUDED.current_period_end, trial_ends_at = EXCLUDED.trial_ends_at,
           provider_customer_id = EXCLUDED.provider_customer_id, provider_subscription_id = EXCLUDED.provider_subscription_id
         RETURNING *`,
        [
          assertScope(workspaceId),
          s.plan || "free",
          s.cycle || "monthly",
          s.status || "active",
          s.region || "US",
          s.currency || "USD",
          s.currentPeriodEnd || null,
          s.trialEndsAt || null,
          s.providerCustomerId || null,
          s.providerSubscriptionId || null,
        ]
      ),
    recordBillingEvent: (workspaceId, providerEventId, eventType, payload) =>
      one(
        `INSERT INTO billing_events (workspace_id, provider_event_id, event_type, payload)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (provider_event_id) DO NOTHING
         RETURNING *`,
        [workspaceId || null, providerEventId, eventType, JSON.stringify(payload || {})]
      ),

    /* ---- integrations ---- */
    listIntegrations: (workspaceId) =>
      many("SELECT * FROM integrations WHERE workspace_id = $1 ORDER BY provider ASC", [
        assertScope(workspaceId),
      ]),
    getIntegration: (workspaceId, provider) =>
      one("SELECT * FROM integrations WHERE workspace_id = $1 AND provider = $2", [
        assertScope(workspaceId),
        provider,
      ]),
    saveIntegration: (workspaceId, provider, data) =>
      one(
        `INSERT INTO integrations (workspace_id, provider, state, credential_ref, config, last_check_at, error_count)
         VALUES ($1,$2,$3,$4,$5,now(),$6)
         ON CONFLICT (workspace_id, provider) DO UPDATE SET
           state = EXCLUDED.state, credential_ref = EXCLUDED.credential_ref,
           config = EXCLUDED.config, last_check_at = now(), error_count = EXCLUDED.error_count
         RETURNING *`,
        [
          assertScope(workspaceId),
          provider,
          data.state || "connected",
          data.credentialRef || null,
          data.config ? JSON.stringify(data.config) : "{}",
          data.errorCount || 0,
        ]
      ),
    deleteIntegration: (workspaceId, provider) =>
      one("DELETE FROM integrations WHERE workspace_id = $1 AND provider = $2 RETURNING provider", [
        assertScope(workspaceId),
        provider,
      ]),

    /* ---- usage metering ---- */
    recordUsage: (workspaceId, kind, quantity, meta = {}) =>
      one(
        `INSERT INTO usage_events (workspace_id, kind, quantity, agent_id, model, tokens, cost_micros, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          assertScope(workspaceId),
          kind,
          quantity,
          meta.agentId || null,
          meta.model || null,
          meta.tokens || null,
          meta.costMicros || null,
          meta.idempotencyKey || null,
        ]
      ),
    getUsage: async (workspaceId, kind) => {
      const row = await one(
        `SELECT coalesce(sum(quantity), 0)::numeric AS total
         FROM usage_events WHERE workspace_id = $1 AND kind = $2`,
        [assertScope(workspaceId), kind]
      );
      return row?.total ?? 0;
    },

    /* ---- background workers & dead letter ---- */
    recordJobFailure: (workspaceId, job) =>
      one(
        `INSERT INTO job_failures (workspace_id, job_id, job_type, attempts, last_error)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [
          assertScope(workspaceId),
          job.jobId,
          job.jobType,
          job.attempts || 1,
          job.lastError || "Unknown error",
        ]
      ),
    listJobFailures: (workspaceId, { limit = 50 } = {}) =>
      many(
        `SELECT * FROM job_failures WHERE workspace_id = $1 ORDER BY failed_at DESC LIMIT $2`,
        [assertScope(workspaceId), limit]
      ),

    /* ---- notification deliveries ---- */
    recordNotification: (workspaceId, notif) =>
      one(
        `INSERT INTO notification_deliveries (workspace_id, channel, recipient, subject, status, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          assertScope(workspaceId),
          notif.channel,
          notif.recipient,
          notif.subject || null,
          notif.status || "delivered",
          notif.idempotencyKey || null,
        ]
      ),

    systemHealth: async () => {
      const t0 = Date.now();
      await pool.query("SELECT 1");
      return { database: { ok: true, latencyMs: Date.now() - t0 }, api: { ok: true } };
    },
  };
}
