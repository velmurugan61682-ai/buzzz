-- 0005: authentication, sessions and the staff/customer boundary.
-- Passwords are stored only as scrypt hashes; tokens only as sha256 hashes.

BEGIN;

ALTER TABLE users
  ADD COLUMN password_hash   text,
  ADD COLUMN email_verified  boolean NOT NULL DEFAULT false,
  ADD COLUMN status          text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','deleted')),
  ADD COLUMN last_login_at   timestamptz;

CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email));

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,          -- sha256 of the token, never the token
  ip          inet,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE INDEX ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON sessions (expires_at);

CREATE TABLE email_verifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);

-- brute force protection, cleaned by a scheduled job
CREATE TABLE login_attempts (
  id      bigserial PRIMARY KEY,
  email   text NOT NULL,
  ip      inet,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON login_attempts (email, at DESC);

-- who belongs to which workspace, and how far through onboarding they are
CREATE TABLE workspace_members (
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                text NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner','admin','member','viewer')),
  onboarding_complete boolean NOT NULL DEFAULT false,
  onboarding_step     text,
  last_active_at      timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX ON workspace_members (user_id);

-- BUZZZ employees are a separate population from customers, with their own
-- credentials. A workspace role can never grant staff access.
CREATE TABLE staff_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('support','ops','superadmin')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX ON staff_sessions (staff_user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON staff_sessions (expires_at);

-- support access is explicit, time boxed, read only by default, and logged
CREATE TABLE support_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reason        text NOT NULL,
  read_only     boolean NOT NULL DEFAULT true,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ended_at      timestamptz
);
CREATE INDEX ON support_grants (workspace_id, expires_at);

-- audit events are append only: no UPDATE or DELETE is granted to the app role
CREATE TABLE audit_events (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  actor_type    text NOT NULL CHECK (actor_type IN ('user','agent','system','staff')),
  actor_id      text,
  action        text NOT NULL,
  target_type   text,
  target_id     text,
  outcome       text NOT NULL DEFAULT 'ok',
  severity      text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','error','critical')),
  requested_level integer,
  effective_level integer,
  ip            inet,
  detail        jsonb
);
CREATE INDEX ON audit_events (workspace_id, at DESC);
CREATE INDEX ON audit_events (action, at DESC);

CREATE RULE audit_events_no_update AS ON UPDATE TO audit_events DO INSTEAD NOTHING;
CREATE RULE audit_events_no_delete AS ON DELETE TO audit_events DO INSTEAD NOTHING;

COMMIT;
