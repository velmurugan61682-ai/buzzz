-- Enterprise layer: multi-currency, company hierarchy, field permissions,
-- localisation, routing queues with shifts, recurring appointments.

-- ---- multi-currency ----
-- Every monetary record carries its own currency AND the rate used at the time,
-- so a closed deal never changes value because the market moved.
alter table deals  add column currency char(3);
alter table deals  add column fx_rate numeric(18,8);
alter table deals  add column fx_captured_at timestamptz;
alter table quotes add column fx_rate numeric(18,8);

create table fx_rates (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  base char(3) not null, quote_currency char(3) not null,
  rate numeric(18,8) not null check (rate > 0),
  as_of date not null, source text,
  unique (workspace_id, base, quote_currency, as_of)
);
create index on fx_rates (workspace_id, quote_currency, as_of desc);

-- ---- company hierarchy ----
create extension if not exists "ltree";

create table companies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  parent_id uuid references companies(id) on delete set null,
  country char(2), domain text, industry text,
  -- materialised path makes "everything under this account" a single index scan
  path ltree,
  created_at timestamptz not null default now(),
  check (parent_id is null or parent_id <> id)
);
create index on companies (workspace_id, parent_id);
create index on companies using gist (path);

-- a company cannot become its own ancestor
create or replace function companies_no_cycle() returns trigger as $$
begin
  if new.parent_id is not null then
    if exists (
      with recursive up as (
        select id, parent_id from companies where id = new.parent_id
        union all
        select c.id, c.parent_id from companies c join up on c.id = up.parent_id
      ) select 1 from up where id = new.id
    ) then
      raise exception 'Cycle detected: a company cannot sit underneath itself';
    end if;
  end if;
  return new;
end $$ language plpgsql;
create trigger companies_no_cycle_trg before insert or update of parent_id
  on companies for each row execute function companies_no_cycle();

alter table contacts add column company_id uuid references companies(id) on delete set null;
alter table deals    add column company_id uuid references companies(id) on delete set null;

-- ---- field level permissions ----
create table field_policies (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  entity text not null,                 -- contacts | deals | quotes ...
  field text not null,
  sensitivity text not null check (sensitivity in ('public','contact','internal','financial')),
  primary key (workspace_id, entity, field)
);
create table role_field_access (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  role text not null,
  sensitivity text not null,
  can_view boolean not null default false,
  can_edit boolean not null default false,
  primary key (workspace_id, role, sensitivity)
);

-- ---- localisation ----
alter table workspaces add column locale text not null default 'en';
alter table workspaces add column reporting_currency char(3);
alter table users      add column locale text;

-- ---- routing queues and shifts ----
create table queues (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  channels text[] not null default '{}', intents text[] not null default '{}',
  strategy text not null default 'round_robin' check (strategy in ('round_robin','load','skills')),
  sla_minutes int not null default 30, fallback_role text,
  created_at timestamptz not null default now()
);
create table queue_members (
  queue_id uuid not null references queues(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  skills text[] not null default '{}',
  primary key (queue_id, user_id)
);
create table shifts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  days text[] not null, starts_at time not null, ends_at time not null,
  timezone text not null default 'Asia/Singapore',
  effective_from date, effective_until date
);
create index on shifts (workspace_id, user_id);

alter table conversations add column queue_id uuid references queues(id) on delete set null;
alter table conversations add column sla_due_at timestamptz;
create index on conversations (workspace_id, sla_due_at) where sla_due_at is not null;

-- who is looking at what, so two agents do not reply at once
create table conversation_viewers (
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

-- ---- recurring appointments ----
create table recurrence_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  freq text not null check (freq in ('daily','weekly','monthly')),
  interval_n int not null default 1 check (interval_n > 0),
  by_day text[], starts_at timestamptz not null,
  until_at timestamptz, occurrence_count int,
  skip_dates date[] not null default '{}'
);
alter table appointments add column recurrence_id uuid references recurrence_rules(id) on delete set null;
alter table appointments add column recurrence_index int;
-- an edited single occurrence detaches from the series rather than mutating it
alter table appointments add column detached_from uuid references appointments(id) on delete set null;
create index on appointments (recurrence_id, recurrence_index);
