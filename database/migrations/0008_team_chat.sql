-- 0008: internal team communication through Slack and Discord.

BEGIN;

-- one row per connected chat workspace or guild
CREATE TABLE team_chat_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  platform        text NOT NULL CHECK (platform IN ('slack','discord')),
  -- the platform's own id for the Slack workspace or Discord guild
  external_id     text NOT NULL,
  team_name       text,
  -- bot token, sealed with the same scheme as every other provider credential
  bot_token_sealed text NOT NULL,
  -- Slack signs with this; Discord verifies against its application public key
  signing_secret_sealed text,
  public_key      text,
  installed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  installed_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  -- one workspace cannot be connected to the same Slack team twice, which is
  -- what stops duplicate notifications for every event
  UNIQUE (workspace_id, platform, external_id)
);
CREATE INDEX ON team_chat_links (platform, external_id) WHERE revoked_at IS NULL;

-- which events go to which channel. Without this every team gets everything
-- and turns the integration off within a week.
CREATE TABLE team_chat_routes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id       uuid NOT NULL REFERENCES team_chat_links(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event         text NOT NULL,
  channel_id    text NOT NULL,
  channel_name  text,
  min_urgency   text NOT NULL DEFAULT 'low' CHECK (min_urgency IN ('low','medium','high')),
  enabled       boolean NOT NULL DEFAULT true,
  UNIQUE (link_id, event, channel_id)
);

-- a chat identity mapped to a BUZZZ user. A button press is only ever
-- authorised through this: being in the channel is not membership.
CREATE TABLE team_chat_identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform      text NOT NULL CHECK (platform IN ('slack','discord')),
  external_uid  text NOT NULL,
  linked_at     timestamptz NOT NULL DEFAULT now(),
  -- one chat account maps to one BUZZZ user per platform, so an identity
  -- cannot be claimed by two people
  UNIQUE (platform, external_uid)
);
CREATE INDEX ON team_chat_identities (workspace_id, user_id);

-- every press, kept whether or not it was allowed. A refused attempt is the
-- more interesting record.
CREATE TABLE team_chat_actions (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  workspace_id   uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  platform       text NOT NULL,
  action         text NOT NULL,
  target_id      text,
  external_uid   text,
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  outcome        text NOT NULL,          -- allowed, refused, failed
  refusal_code   text,
  channel_id     text
);
CREATE INDEX ON team_chat_actions (workspace_id, at DESC);

-- an interaction id is single use: platforms retry, and a retry must not
-- approve the same refund twice
CREATE TABLE team_chat_seen (
  interaction_id text PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON team_chat_seen (at);

COMMIT;
