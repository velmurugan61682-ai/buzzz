-- Revenue objects: products, quotes with line items, sequences, forms, quotas.
-- Money is stored in minor units as bigint. Never a float near currency.

create table products (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  sku text not null, name text not null, description text,
  kind text not null check (kind in ('Subscription','One off','Service','Usage')),
  billing_period text not null default 'once' check (billing_period in ('once','monthly','quarterly','annual')),
  price_minor bigint not null, cost_minor bigint not null default 0,
  currency char(3) not null, tax_rate numeric(5,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workspace_id, sku)
);

create table quotes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  number text not null,
  contact_id uuid references contacts(id) on delete set null,
  deal_id uuid references deals(id) on delete set null,
  status text not null default 'draft'
    check (status in ('draft','sent','viewed','accepted','declined','expired')),
  currency char(3) not null,
  -- totals are denormalised for listing and reporting, recomputed on every write
  net_minor bigint not null default 0, tax_minor bigint not null default 0,
  total_minor bigint not null default 0, mrr_minor bigint not null default 0,
  terms text, notes text, owner_id uuid references users(id),
  expires_at timestamptz, sent_at timestamptz, viewed_at timestamptz, accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, number)
);
create index on quotes (workspace_id, status, created_at desc);

create table quote_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  product_id uuid references products(id) on delete restrict,
  position int not null default 0,
  description text,
  qty numeric(12,2) not null check (qty > 0),
  unit_price_minor bigint not null,
  discount_pct numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  tax_rate numeric(5,2) not null default 0,
  billing_period text not null default 'once'
);
create index on quote_items (quote_id, position);

-- an accepted quote is an immutable commercial record
create table quote_versions (
  id bigserial primary key,
  quote_id uuid not null references quotes(id) on delete cascade,
  snapshot jsonb not null, created_at timestamptz not null default now()
);

create table sequences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null, active boolean not null default true,
  stop_on_reply boolean not null default true,
  stop_on_booking boolean not null default true,
  created_at timestamptz not null default now()
);
create table sequence_steps (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references sequences(id) on delete cascade,
  position int not null, day_offset int not null check (day_offset >= 0),
  kind text not null check (kind in ('message','call task','manual task')),
  channel text, body text not null
);
create table sequence_enrollments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  sequence_id uuid not null references sequences(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  status text not null default 'active' check (status in ('active','stopped','completed')),
  started_at timestamptz not null default now(),
  stopped_at timestamptz, stopped_reason text,
  -- one live enrolment per contact per sequence; prevents double sending
  unique (sequence_id, contact_id) where (status = 'active')
);
create table sequence_step_runs (
  id bigserial primary key,
  enrollment_id uuid not null references sequence_enrollments(id) on delete cascade,
  step_id uuid not null references sequence_steps(id),
  ran_at timestamptz not null default now(), outcome text,
  idempotency_key text unique
);

create table forms (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null, active boolean not null default true,
  fields jsonb not null default '[]', on_submit jsonb not null default '{}',
  submission_count int not null default 0,
  created_at timestamptz not null default now()
);
create table form_submissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  form_id uuid not null references forms(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  values jsonb not null, matched_existing boolean not null default false,
  ip inet, user_agent text,
  created_at timestamptz not null default now()
);
create index on form_submissions (workspace_id, form_id, created_at desc);

create table sales_quotas (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  period date not null,
  quota_minor bigint not null,
  primary key (workspace_id, user_id, period)
);

create table assignment_rules (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  mode text not null default 'round_robin' check (mode in ('round_robin','load','territory','fixed')),
  config jsonb not null default '{}'
);
