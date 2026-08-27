-- 0007: model access, per workspace usage and the customer's own key.

BEGIN;

-- how a workspace reaches a model
CREATE TABLE llm_settings (
  workspace_id     uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  mode             text NOT NULL DEFAULT 'managed' CHECK (mode IN ('managed','byo','off')),
  provider         text CHECK (provider IN ('openrouter','openai','anthropic')),
  -- the customer's own key, sealed with the same scheme as Google refresh
  -- tokens: a database dump must not hand over anyone's provider account
  api_key_sealed   text,
  key_hint         text,                       -- "sk-proj…4f2a", safe to display
  preferred_model  text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (mode <> 'byo' OR api_key_sealed IS NOT NULL)
);

-- one row per call. This is what makes both the customer's quota and our
-- margin measurable, rather than estimated at the end of the month.
CREATE TABLE llm_usage (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  purpose        text NOT NULL,               -- assistant.understand, agent.reply, ...
  provider       text NOT NULL,
  model          text NOT NULL,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  total_tokens   integer NOT NULL DEFAULT 0,
  -- zero when the customer brought their own key: recording our price against
  -- their call would overstate cost and understate margin
  cost_usd       numeric(12,6) NOT NULL DEFAULT 0,
  billable       boolean NOT NULL DEFAULT true,
  outcome        text NOT NULL DEFAULT 'ok',
  agent_id       uuid,
  user_id        uuid
);
CREATE INDEX ON llm_usage (workspace_id, at DESC);
CREATE INDEX ON llm_usage (at DESC) WHERE billable;

-- the running total the entitlement check reads before every call. Kept as a
-- counter rather than summed from llm_usage on each request, because that sum
-- gets slower exactly as a workspace gets busier.
CREATE TABLE llm_period_usage (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_start  date NOT NULL,
  requests      integer NOT NULL DEFAULT 0,
  tokens        bigint NOT NULL DEFAULT 0,
  cost_usd      numeric(12,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, period_start)
);

ALTER TABLE workspaces
  ADD COLUMN plan text NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter','growth','scale'));

COMMIT;
