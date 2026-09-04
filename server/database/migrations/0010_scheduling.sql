-- 0010: Industry-Agnostic Scheduling Engine (Locations, Services, Staff Schedules, Resources)

create table if not exists locations (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  name            text not null,
  timezone        text not null default 'UTC',
  address         text,
  phone           text,
  operating_hours jsonb default '{"mon":[{"start":"09:00","end":"17:00"}],"tue":[{"start":"09:00","end":"17:00"}],"wed":[{"start":"09:00","end":"17:00"}],"thu":[{"start":"09:00","end":"17:00"}],"fri":[{"start":"09:00","end":"17:00"}]}'::jsonb,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);
create index if not exists locations_workspace_idx on locations (workspace_id);

create table if not exists services (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references workspaces(id) on delete cascade,
  name                  text not null,
  category              text not null default 'General',
  description           text,
  duration_minutes      int not null default 30,
  buffer_before_minutes int not null default 0,
  buffer_after_minutes  int not null default 0,
  price_minor           bigint not null default 0,
  currency              text not null default 'USD',
  capacity              int not null default 1,
  is_virtual            boolean not null default false,
  is_active             boolean not null default true,
  created_at            timestamptz not null default now()
);
create index if not exists services_workspace_idx on services (workspace_id);

create table if not exists staff_schedules (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  staff_id        text not null,
  day_of_week     int not null, -- 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  start_time      text not null, -- "09:00"
  end_time        text not null, -- "17:00"
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);
create index if not exists staff_schedules_workspace_staff_idx on staff_schedules (workspace_id, staff_id);

-- Link appointments to locations and services
alter table appointments add column if not exists location_id uuid references locations(id) on delete set null;
alter table appointments add column if not exists service_id uuid references services(id) on delete set null;
alter table appointments add column if not exists capacity int default 1;
alter table appointments add column if not exists booked_count int default 1;
alter table appointments add column if not exists check_in_at timestamptz;
