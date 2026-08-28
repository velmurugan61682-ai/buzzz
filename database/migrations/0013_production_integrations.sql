-- 0013: Production Integrations, Billing, Notifications, Dead-Letter Job Failures

create table if not exists job_failures (
  id bigserial primary key,
  workspace_id uuid references workspaces(id) on delete cascade,
  job_id text not null,
  job_type text not null,
  attempts int not null,
  last_error text,
  created_at timestamptz not null default now(),
  failed_at timestamptz not null default now()
);
create index if not exists idx_job_failures_workspace on job_failures (workspace_id, created_at desc);

create table if not exists notification_deliveries (
  id bigserial primary key,
  workspace_id uuid references workspaces(id) on delete cascade,
  channel text not null,
  recipient text not null,
  subject text,
  status text not null default 'delivered',
  idempotency_key text unique,
  created_at timestamptz not null default now()
);
create index if not exists idx_notification_deliveries_ws on notification_deliveries (workspace_id, created_at desc);

create table if not exists billing_events (
  id bigserial primary key,
  workspace_id uuid references workspaces(id) on delete cascade,
  provider_event_id text unique,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);
