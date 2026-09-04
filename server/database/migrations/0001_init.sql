-- BUZZZ initial schema.
-- Every tenant-owned table carries workspace_id and is indexed on it first,
-- because tenant isolation that depends on a handler remembering is not isolation.

create extension if not exists "pgcrypto";
create extension if not exists "vector";

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country char(2) not null default 'SG',
  currency char(3) not null default 'SGD',
  timezone text not null default 'Asia/Singapore',
  autonomy_ceiling int not null default 2 check (autonomy_ceiling between 0 and 4),
  business_hours jsonb not null default '{"start":"09:00","end":"18:00","days":["Mon","Tue","Wed","Thu","Fri"]}',
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  password_hash text not null,
  name text,
  mfa_secret text,
  created_at timestamptz not null default now()
);

create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('Owner','Admin','Manager','Finance Manager','Marketing Manager','Sales Manager','Support Lead','Agent')),
  primary key (workspace_id, user_id)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  refresh_token_hash text not null,
  family_id uuid not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index on sessions (user_id) where revoked_at is null;

create table contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  company text, title text, email citext, phone text, phone_norm text,
  status text not null default 'New',
  source text, owner_id uuid references users(id),
  tags text[] not null default '{}',
  custom_fields jsonb not null default '{}',
  archived boolean not null default false,
  last_contact_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on contacts (workspace_id, archived, created_at desc);
create index on contacts (workspace_id, phone_norm);
create index on contacts (workspace_id, email);

create table identities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  kind text not null check (kind in ('phone','email','whatsapp','instagram','telegram','external')),
  value text not null, value_norm text not null,
  confidence real, verified_at timestamptz, source text,
  unique (workspace_id, kind, value_norm)
);
create index on identities (workspace_id, value_norm);

create table customer_memory (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  kind text not null, body text not null,
  source text not null, created_by text not null,
  confidence real not null check (confidence between 0 and 1),
  superseded_by uuid, deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index on customer_memory (workspace_id, contact_id) where deleted_at is null;

create table agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null, title text, type text not null,
  status text not null default 'draft' check (status in ('draft','active','paused','archived')),
  autonomy int not null default 1 check (autonomy between 0 and 4),
  allow_destructive boolean not null default false,
  role text, purpose text, instructions jsonb, tone text, tones text[], languages text[],
  channels text[] not null default '{}', tools text[] not null default '{}',
  guardrails text[] not null default '{}', escalation jsonb,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (workspace_id, lower(name))
);

create table agent_permissions (
  agent_id uuid not null references agents(id) on delete cascade,
  action text not null, granted boolean not null default false,
  primary key (agent_id, action)
);

create table agent_versions (
  id bigserial primary key,
  agent_id uuid not null references agents(id) on delete cascade,
  snapshot jsonb not null, created_by uuid, created_at timestamptz not null default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  channel text not null,
  state text not null default 'open' check (state in ('open','waiting','escalated','resolved')),
  assignee_id uuid references users(id), agent_id uuid references agents(id),
  ai_enabled boolean not null default true,
  last_message_at timestamptz,
  created_at timestamptz not null default now()
);
create index on conversations (workspace_id, state, last_message_at desc);

create table messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound')),
  author text not null, body text, media jsonb,
  provider_message_id text, delivery_status text,
  created_at timestamptz not null default now(),
  unique (workspace_id, provider_message_id)
);
create index on messages (conversation_id, created_at);

create table deals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  name text not null, value_minor bigint not null default 0, currency char(3),
  stage text not null, probability int, owner_id uuid references users(id),
  campaign_id uuid, closed_at timestamptz,
  created_at timestamptz not null default now()
);
create index on deals (workspace_id, stage);

create table appointments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  staff_id uuid, service_id uuid, location_id uuid, room text,
  starts_at timestamptz not null, duration_minutes int not null,
  status text not null default 'pending',
  source text, created_at timestamptz not null default now(),
  -- a staff member cannot hold two overlapping appointments
  exclude using gist (
    staff_id with =,
    tstzrange(starts_at, starts_at + (duration_minutes || ' minutes')::interval) with &&
  ) where (status not in ('cancelled','no_show'))
);
create index on appointments (workspace_id, starts_at);

create table calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider text not null default 'mrassistant',
  provider_call_id text not null, provider_session_id text,
  contact_id uuid references contacts(id) on delete set null,
  agent_id uuid references agents(id),
  direction text not null, from_number text, to_number text,
  status text not null, started_at timestamptz, ended_at timestamptz,
  duration_seconds int, outcome text, summary text,
  recording_ref text, transcript tsvector,
  unique (workspace_id, provider, provider_call_id)
);
create index on calls using gin (transcript);

create table workflows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  status text not null default 'draft' check (status in ('draft','published','paused','archived')),
  current_version int not null default 1,
  created_by uuid references users(id), updated_at timestamptz not null default now()
);
create table workflow_versions (
  id bigserial primary key,
  workflow_id uuid not null references workflows(id) on delete cascade,
  version int not null, graph jsonb not null,
  published_at timestamptz, published_by uuid,
  unique (workflow_id, version)
);
create table workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  workflow_id uuid not null references workflows(id),
  version int not null, event_id text, idempotency_key text,
  status text not null, end_state text, current_node text,
  context jsonb not null default '{}',
  started_at timestamptz not null default now(), finished_at timestamptz,
  error text, is_test boolean not null default false,
  unique (workspace_id, workflow_id, idempotency_key)
);
create table node_executions (
  id bigserial primary key,
  run_id uuid not null references workflow_runs(id) on delete cascade,
  node_id text not null, node_type text not null, status text not null,
  branch text, note text, attempt int not null default 1,
  started_at timestamptz, finished_at timestamptz
);
create index on node_executions (run_id);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null, channel text not null, status text not null default 'draft',
  audience jsonb, body text, variant_body text, schedule jsonb,
  created_at timestamptz not null default now()
);
create table campaign_recipients (
  id bigserial primary key,
  workspace_id uuid not null,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  status text not null default 'queued', variant text, attempts int not null default 0,
  fail_reason text, sent_at timestamptz, replied_at timestamptz, converted_at timestamptz,
  idempotency_key text, unique (campaign_id, contact_id)
);
create index on campaign_recipients (campaign_id, status);

create table kb_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null, type text not null, collection text,
  priority int not null default 3, status text not null, error text,
  url text, refresh_cadence text, content_hash text,
  version int not null default 1, archived boolean not null default false,
  indexed_at timestamptz, created_at timestamptz not null default now(),
  unique (workspace_id, lower(name))
);
create table kb_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  source_id uuid not null references kb_sources(id) on delete cascade,
  version int not null, heading text, page int, ord int, body text not null,
  embedding vector(1536),
  tsv tsvector generated always as (to_tsvector('english', body)) stored
);
create index on kb_chunks using ivfflat (embedding vector_cosine_ops);
create index on kb_chunks using gin (tsv);
create table agent_knowledge (
  agent_id uuid not null references agents(id) on delete cascade,
  source_id uuid not null references kb_sources(id) on delete cascade,
  primary key (agent_id, source_id)
);

create table approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agent_id uuid references agents(id), requested_by text,
  action_key text not null, category text not null,
  contact_id uuid, conversation_id uuid, workflow_run_id uuid, node_id text,
  title text, body text, edited_body text, meta jsonb not null default '{}',
  risk text not null, required_role text not null,
  sla_minutes int, expiry_minutes int,
  status text not null default 'pending',
  decided_by uuid, decided_at timestamptz, reject_reason text,
  exec_result text, executed_at timestamptz,
  idempotency_key text unique,
  created_at timestamptz not null default now()
);
create index on approvals (workspace_id, status, created_at desc);
create table approval_events (
  id bigserial primary key,
  approval_id uuid not null references approvals(id) on delete cascade,
  at timestamptz not null default now(), actor text, what text not null
);

create table activity_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  actor_type text not null, actor_id uuid, actor_name text not null,
  mode text not null check (mode in ('autonomous','approved','human','system')),
  category text not null, action text not null, detail text,
  outcome text not null, severity text not null default 'info',
  entity_type text, entity_id uuid, entity_name text,
  conversation_id uuid, deal_id uuid, appointment_id uuid, run_id uuid, approval_id uuid,
  before_value text, after_value text, reason text,
  cost_micros bigint, duration_ms int
);
create index on activity_events (workspace_id, occurred_at desc);
create index on activity_events (workspace_id, entity_id, occurred_at desc);
create index on activity_events (workspace_id, outcome) where outcome <> 'success';

create table integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider text not null, state text not null default 'not_connected',
  credential_ref text, config jsonb not null default '{}',
  last_check_at timestamptz, last_event_at timestamptz, error_count int not null default 0,
  unique (workspace_id, provider)
);

create table subscriptions (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  plan text not null, cycle text not null, status text not null,
  region text not null, currency char(3) not null,
  current_period_end timestamptz, trial_ends_at timestamptz,
  provider_customer_id text, provider_subscription_id text
);
create table usage_events (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  kind text not null, quantity numeric not null,
  agent_id uuid, model text, tokens int, cost_micros bigint,
  idempotency_key text unique
);
create index on usage_events (workspace_id, kind, occurred_at desc);

create table webhook_deliveries (
  id bigserial primary key,
  workspace_id uuid, provider text not null, event_id text not null,
  received_at timestamptz not null default now(), status text not null,
  attempts int not null default 1, error text,
  unique (provider, event_id)
);
