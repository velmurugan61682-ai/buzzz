# Buzzz — Backend Architecture, Database Schema and Webhook Contracts

Production design for the Buzzz agentic CRM and omnichannel platform. It assumes three first party products in the ecosystem: **GoWhats** (gowhats.in) as the WhatsApp layer, **InstaxBot** (instaxbot.com) as the Instagram layer, and **MrAssistant.ai** as the voice layer. Buzzz is the brain and the system of record; the three products act as channel providers connected through one normalized contract.

---

## 1. System overview

```
                                    CUSTOMERS
        WhatsApp   Instagram   FB   Email  SMS  Telegram  Voice (PSTN/SIP)
            |          |        |     |     |      |          |
        +---v----+ +---v-----+ +v-----v-----v------v+   +-----v--------+
        | GoWhats| |InstaxBot| |  Native adapters   |   | MrAssistant  |
        | (yours)| | (yours) | | (Meta, SMTP, etc.) |   |   .ai (yours)|
        +---+----+ +---+-----+ +---------+----------+   +-----+--------+
            |          |                 |                    |
            |   webhooks (signed, normalized envelope)        |
            +----------+--------+--------+--------------------+
                                |
                    +-----------v------------+
                    |   CHANNEL GATEWAY      |  verify signature, dedupe,
                    |   (ingest service)     |  normalize to Message envelope
                    +-----------+------------+
                                |  publish
                    +-----------v------------+
                    |   EVENT BUS            |  Redis Streams now,
                    |   (message.received…)  |  Kafka when volume demands
                    +--+------+------+-------+
                       |      |      |
        +--------------v+  +--v---------------+  +-v----------------+
        | ORCHESTRATOR  |  | CRM SERVICE      |  | ANALYTICS        |
        | route, intent |  | contacts, deals, |  | (consumer, rolls |
        | pick agent,   |  | identity merge,  |  | up counters and  |
        | check autonomy|  | appointments,    |  | insight jobs)    |
        +------+--------+  | tickets, tasks   |  +------------------+
               |           +------------------+
        +------v--------+
        | AGENT RUNTIME |  LLM calls, RAG over knowledge base,
        | (workers)     |  tool execution, guardrails, memory
        +------+--------+
               |
      +--------+---------+----------------------+
      | allowed by       | needs human           |
      | autonomy level   | (approval object)     |
+-----v------+     +-----v--------+       +------v-------+
| ACTION     |     | APPROVAL     |       | REALTIME     |
| EXECUTOR   |     | CENTER       |       | GATEWAY (WS) |
| send msg,  |     | (holds, then |       | pushes inbox |
| book, CRM  |     | executes)    |       | updates to UI|
+------------+     +--------------+       +--------------+
```

**Core rule of the design:** channels are adapters into one normalized message envelope, and every AI action flows through one autonomy check. Adding a channel never touches the orchestrator, and raising or lowering AI freedom never touches the channels.

### Services

| Service | Responsibility | Scale unit |
|---|---|---|
| API Gateway | REST + auth, rate limits, workspace resolution | stateless, horizontal |
| Channel Gateway | receives webhooks from GoWhats, InstaxBot, MrAssistant.ai, Meta, email; verifies, dedupes, normalizes | stateless, horizontal |
| Orchestrator | routes each inbound event: intent, sentiment, priority, agent selection, escalation rules | worker pool |
| Agent Runtime | runs the selected AI agent: prompt assembly, RAG retrieval, tool calls, drafts actions | worker pool, queue backed |
| Action Executor | the only component that touches the outside world on behalf of AI: send message, place call, book slot, update deal | worker pool, idempotent |
| CRM Service | contacts, identities, companies, deals, pipelines, appointments, tickets, tasks | stateless |
| Approval Service | pending AI actions, approve or edit or reject, then hands to Action Executor | stateless |
| Workflow Engine | trigger evaluation, step execution, waits and branches (durable timers) | worker pool |
| Campaign Service | audience resolution, throttled sends, per recipient personalization jobs | worker pool |
| Knowledge Service | ingestion, chunking, embedding, retrieval API for agents | worker pool + pgvector |
| Realtime Gateway | WebSocket fan out of inbox, approval and activity events to the UI | sticky, horizontal |
| Analytics | consumers that maintain counters, plus scheduled Buzzz Intelligence jobs | workers + cron |

### Recommended stack

Node.js (NestJS or Fastify) or Python (FastAPI) services, **PostgreSQL 16 + pgvector** as the single source of truth, **Redis** for queues, cache, rate limits and WebSocket pub/sub, **S3 compatible storage** for media, recordings and knowledge files. One Postgres cluster with row level security carries you comfortably to thousands of workspaces before you need anything exotic.

### Multi tenancy

Every table carries `workspace_id`. Enforce isolation twice: application scoping plus Postgres **row level security** with `app.workspace_id` set per connection. Brands live inside a workspace so one company can run Acme Retail and Acme Pro with separate channels, agents and knowledge, sharing billing and users.

### The message lifecycle (happy path)

1. GoWhats receives a WhatsApp message and POSTs the signed webhook to the Channel Gateway.
2. Gateway verifies the signature, checks `provider_message_id` for duplicates, resolves the channel account to a workspace, upserts the contact identity, writes the `messages` row, and publishes `message.received`.
3. Orchestrator classifies intent, sentiment and priority, updates the conversation, evaluates escalation rules and workflow triggers, and either assigns a human or dispatches an agent job.
4. Agent Runtime builds the prompt (conversation history, customer 360, AI memory, retrieved knowledge), produces a reply plus proposed tool calls.
5. Each proposed action passes the autonomy check: `min(workspace_autonomy, agent_autonomy)` against the action's risk class. Allowed actions go to the Action Executor; the rest become `approvals` rows and notify humans.
6. Action Executor sends the reply through the GoWhats send API, records delivery status from the status webhook, writes the activity log, and the Realtime Gateway pushes the update to every open inbox.

Appointments follow the same spine: agent proposes a slot, executor books it (calendar integration or internal slots), a **confirmation message** is dispatched on the contact's preferred channel, and reminder timers are scheduled in the workflow engine (24h and 2h before, then a no show recovery message).

---

## 2. Database schema (PostgreSQL)

Conventions: UUID primary keys, `timestamptz` everywhere, soft deletes via `deleted_at` where users can delete, `workspace_id` on every tenant table with RLS. JSONB is used for provider payloads and flexible config, never for data you filter on daily.

```sql
create extension if not exists "uuid-ossp";
create extension if not exists vector;

-- ============ TENANCY, IDENTITY, ACCESS ============

create table workspaces (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null,
  slug          text not null unique,            -- acme.buzzzbuzzz.com
  plan          text not null default 'starter', -- starter|growth|enterprise
  ai_autonomy   int  not null default 2 check (ai_autonomy between 0 and 4),
  timezone      text not null default 'Asia/Singapore',
  currency      text not null default 'USD',
  settings      jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

create table brands (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  is_default    boolean not null default false,
  created_at    timestamptz not null default now()
);

create table users (
  id            uuid primary key default uuid_generate_v4(),
  email         citext not null unique,
  name          text not null,
  password_hash text,                    -- null when SSO only
  mfa_enabled   boolean not null default false,
  created_at    timestamptz not null default now()
);

create table memberships (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  role          text not null check (role in
                ('owner','admin','manager','sales','support','marketing','agent','viewer')),
  team          text,                                   -- Sales, Support, ...
  unique (workspace_id, user_id)
);

create table api_keys (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  key_hash      text not null,           -- store hash only, show key once
  scopes        text[] not null default '{}',
  last_used_at  timestamptz,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);

-- ============ CHANNELS ============

create table channel_accounts (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  brand_id      uuid references brands(id),
  channel       text not null check (channel in
                ('whatsapp','instagram','facebook','email','sms','telegram',
                 'linkedin','x','youtube','google_business','voice','webchat')),
  provider      text not null,           -- 'gowhats','instaxbot','mrassistant','meta','smtp','twilio'
  display_name  text not null,           -- '+91 98… Main line', '@lumenbeauty'
  external_id   text not null,           -- provider side account id / phone number id
  credentials   jsonb not null default '{}',  -- encrypted at rest (pgcrypto or KMS envelope)
  status        text not null default 'active',
  created_at    timestamptz not null default now(),
  unique (provider, external_id)
);

-- ============ CRM CORE ============

create table companies (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  domain        text,
  industry      text,
  size          text,
  custom        jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table contacts (
  id             uuid primary key default uuid_generate_v4(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  company_id     uuid references companies(id),
  full_name      text,
  title          text,
  location       text,
  lifecycle      text not null default 'new_lead',   -- new_lead|qualified|opportunity|customer|nurture|churned
  lead_score     int  not null default 0,
  score_reasons  jsonb not null default '[]',
  sentiment      text,                                -- latest rollup
  churn_risk     text,                                -- low|medium|high
  ltv_cents      bigint not null default 0,
  owner_user_id  uuid references users(id),
  custom         jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create index on contacts (workspace_id, lifecycle);
create index on contacts (workspace_id, lead_score desc);

-- identity resolution: one contact, many handles across channels
create table contact_identities (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  contact_id    uuid not null references contacts(id) on delete cascade,
  channel       text not null,
  identifier    text not null,            -- phone E.164, IG user id, email...
  verified      boolean not null default false,
  unique (workspace_id, channel, identifier)
);

create table tags (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  color         text,
  unique (workspace_id, name)
);
create table contact_tags (
  contact_id uuid references contacts(id) on delete cascade,
  tag_id     uuid references tags(id) on delete cascade,
  primary key (contact_id, tag_id)
);

-- long term AI memory, editable by humans
create table ai_memories (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  contact_id    uuid not null references contacts(id) on delete cascade,
  content       text not null,
  source        text not null default 'ai',   -- ai|human
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- ============ PIPELINES AND DEALS ============

create table pipelines (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null default 'Default Sales',
  is_default    boolean not null default false
);

create table pipeline_stages (
  id            uuid primary key default uuid_generate_v4(),
  pipeline_id   uuid not null references pipelines(id) on delete cascade,
  name          text not null,              -- New Lead … Won
  position      int  not null,
  win_prob      int  not null default 0,
  unique (pipeline_id, position)
);

create table deals (
  id             uuid primary key default uuid_generate_v4(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  pipeline_id    uuid not null references pipelines(id),
  stage_id       uuid not null references pipeline_stages(id),
  contact_id     uuid references contacts(id),
  company_id     uuid references companies(id),
  name           text not null,
  value_cents    bigint not null default 0,
  currency       text not null default 'USD',
  probability    int,
  expected_close date,
  owner_user_id  uuid references users(id),
  owner_agent_id uuid,                       -- fk added after agents
  next_action    text,                       -- AI next best action text
  status         text not null default 'open',  -- open|won|lost
  lost_reason    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on deals (workspace_id, pipeline_id, stage_id);

-- ============ CONVERSATIONS AND MESSAGES ============

create table conversations (
  id              uuid primary key default uuid_generate_v4(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  brand_id        uuid references brands(id),
  contact_id      uuid not null references contacts(id),
  channel_account_id uuid not null references channel_accounts(id),
  channel         text not null,
  subject         text,
  state           text not null default 'open',
                  -- open|ai_handling|human_handling|waiting_customer|waiting_team|escalated|resolved|closed
  priority        text not null default 'medium',  -- low|medium|high|critical
  intent          text,
  sentiment       text,
  assigned_user_id  uuid references users(id),
  assigned_agent_id uuid,
  team            text,
  unread_count    int not null default 0,
  last_message_at timestamptz,
  sla_due_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index on conversations (workspace_id, state, last_message_at desc);
create index on conversations (workspace_id, assigned_user_id, state);

create table messages (
  id              uuid primary key default uuid_generate_v4(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction       text not null check (direction in ('inbound','outbound','internal','system')),
  author_type     text not null check (author_type in ('customer','agent_ai','user','system')),
  author_user_id  uuid references users(id),
  author_agent_id uuid,
  channel         text not null,
  body            text,
  content_type    text not null default 'text',   -- text|image|audio|video|document|template|event
  is_internal_note boolean not null default false,
  provider          text,                          -- gowhats|instaxbot|mrassistant|...
  provider_message_id text,                        -- idempotency + status mapping
  delivery_status  text default 'pending',         -- pending|sent|delivered|read|failed
  ai_meta          jsonb,                          -- model, confidence, retrieved doc ids, tokens
  provider_payload jsonb,                          -- raw envelope for audit
  created_at       timestamptz not null default now(),
  unique (provider, provider_message_id)
);
create index on messages (conversation_id, created_at);

create table attachments (
  id           uuid primary key default uuid_generate_v4(),
  message_id   uuid not null references messages(id) on delete cascade,
  kind         text not null,             -- image|audio|video|document
  storage_key  text not null,             -- S3 key
  mime         text, size_bytes bigint, filename text
);

-- ============ AGENTS AND AUTONOMY ============

create table agents (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  brand_id      uuid references brands(id),
  name          text not null,             -- 'Sarah — Sales Agent'
  type          text not null,             -- sales|support|appointment|lead_qual|retention|voice|custom
  status        text not null default 'active',
  autonomy      int  not null default 1 check (autonomy between 0 and 4),
  persona       text,                      -- role and personality prompt
  tone          text,
  goals         jsonb not null default '[]',
  rules         jsonb not null default '[]',   -- guardrails, checked pre and post generation
  tools         jsonb not null default '[]',   -- allow list of tool names
  model_config  jsonb not null default '{}',   -- model, temperature, max_tokens
  created_at    timestamptz not null default now()
);
alter table deals add constraint deals_agent_fk
  foreign key (owner_agent_id) references agents(id);
alter table conversations add constraint conv_agent_fk
  foreign key (assigned_agent_id) references agents(id);
alter table messages add constraint msg_agent_fk
  foreign key (author_agent_id) references agents(id);

-- risk classes let autonomy levels map to concrete actions
create table action_policies (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  action        text not null,     -- message.send, deal.update, appointment.book,
                                   -- refund.issue, call.place, contact.merge ...
  min_autonomy  int  not null,     -- required level to auto execute
  requires_role text,              -- e.g. refunds above threshold need 'manager'
  threshold     jsonb,             -- {"amount_cents_gt": 20000}
  unique (workspace_id, action)
);

-- ============ APPROVALS AND AUDIT ============

create table approvals (
  id             uuid primary key default uuid_generate_v4(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  agent_id       uuid references agents(id),
  conversation_id uuid references conversations(id),
  contact_id     uuid references contacts(id),
  action         text not null,             -- matches action_policies.action
  title          text not null,
  payload        jsonb not null,            -- exactly what will execute
  requires_role  text not null default 'agent',
  status         text not null default 'pending',  -- pending|approved|edited|rejected|expired|executed|failed
  decided_by     uuid references users(id),
  decided_at     timestamptz,
  executed_at    timestamptz,
  expires_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index on approvals (workspace_id, status, created_at desc);

create table activity_log (
  id            bigserial primary key,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  actor_type    text not null,             -- agent_ai|user|system|orchestrator
  actor_id      uuid,
  action        text not null,             -- 'message.sent','deal.created','autonomy.changed'...
  target_type   text, target_id uuid,
  detail        jsonb not null default '{}',
  created_at    timestamptz not null default now()
);
create index on activity_log (workspace_id, created_at desc);

-- ============ APPOINTMENTS ============

create table appointment_types (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,             -- 'Scoping call', 'Demo'
  duration_min  int  not null default 30,
  location_kind text not null default 'video',   -- video|phone|in_person
  buffer_min    int  not null default 0,
  booking_slug  text unique                       -- public booking page
);

create table appointments (
  id             uuid primary key default uuid_generate_v4(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  type_id        uuid references appointment_types(id),
  contact_id     uuid not null references contacts(id),
  deal_id        uuid references deals(id),
  conversation_id uuid references conversations(id),
  call_id        uuid,                              -- fk added after calls
  booked_by      text not null default 'ai',        -- ai|user|customer
  agent_id       uuid references agents(id),
  host_user_id   uuid references users(id),
  title          text not null,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  timezone       text not null,
  location       text,                              -- meet link or address
  status         text not null default 'awaiting_confirmation',
                 -- awaiting_confirmation|confirmed|rescheduled|completed|no_show|cancelled
  confirm_channel text,                             -- whatsapp|instagram|sms|email|telegram
  confirmed_at   timestamptz,
  external_event_id text,                           -- Google or Microsoft calendar
  created_at     timestamptz not null default now()
);
create index on appointments (workspace_id, starts_at);

create table appointment_reminders (
  id             uuid primary key default uuid_generate_v4(),
  appointment_id uuid not null references appointments(id) on delete cascade,
  offset_min     int  not null,             -- 1440 = 24h before, 120 = 2h before
  channel        text not null,
  status         text not null default 'scheduled',  -- scheduled|sent|failed|skipped
  sent_at        timestamptz
);

-- ============ CALLS (MrAssistant.ai) ============

create table calls (
  id               uuid primary key default uuid_generate_v4(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  channel_account_id uuid references channel_accounts(id),
  contact_id       uuid references contacts(id),
  conversation_id  uuid references conversations(id),
  agent_id         uuid references agents(id),
  direction        text not null check (direction in ('inbound','outbound')),
  provider_call_id text not null,           -- MrAssistant.ai call id
  from_number      text, to_number text,
  status           text not null,           -- ringing|in_progress|completed|missed|failed|transferred
  started_at       timestamptz, ended_at timestamptz,
  duration_sec     int,
  recording_url    text,                    -- signed, short lived; original in S3
  summary          text,
  intent           text, sentiment text,
  outcome          text,                    -- opportunity_created|meeting_booked|escalated|...
  actions          jsonb not null default '[]',   -- CRM actions the call triggered
  cost_cents       int,
  unique (provider_call_id)
);
alter table appointments add constraint appt_call_fk
  foreign key (call_id) references calls(id);

create table call_transcript_segments (
  id        bigserial primary key,
  call_id   uuid not null references calls(id) on delete cascade,
  seq       int  not null,
  speaker   text not null,                  -- ai|customer|human
  started_ms int, ended_ms int,
  text      text not null,
  unique (call_id, seq)
);

-- ============ WORKFLOWS ============

create table workflows (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  active        boolean not null default false,
  trigger       jsonb not null,     -- {"event":"message.received","filters":{...}}
  graph         jsonb not null,     -- nodes and edges: ai|condition|action|wait|approval|webhook|loop
  created_by    text not null default 'user',   -- user|nl_builder|template
  version       int not null default 1,
  created_at    timestamptz not null default now()
);

create table workflow_runs (
  id           uuid primary key default uuid_generate_v4(),
  workflow_id  uuid not null references workflows(id) on delete cascade,
  workspace_id uuid not null,
  trigger_ref  jsonb,               -- ids of the triggering entities
  status       text not null default 'running',   -- running|waiting|succeeded|failed|cancelled
  current_node text,
  wake_at      timestamptz,         -- durable timers for wait nodes
  context      jsonb not null default '{}',
  started_at   timestamptz not null default now(),
  ended_at     timestamptz
);
create index on workflow_runs (status, wake_at);

-- ============ CAMPAIGNS ============

create table campaigns (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  channel       text not null,
  status        text not null default 'draft',   -- draft|scheduled|running|paused|done
  audience_query jsonb not null,                 -- saved segment definition
  template      jsonb not null,                  -- body + variables; WA template name for GoWhats
  ai_personalize boolean not null default true,
  send_at       timestamptz,
  throttle_per_min int not null default 60,
  created_at    timestamptz not null default now()
);

create table campaign_recipients (
  id            uuid primary key default uuid_generate_v4(),
  campaign_id   uuid not null references campaigns(id) on delete cascade,
  contact_id    uuid not null references contacts(id),
  status        text not null default 'queued',  -- queued|sent|delivered|opened|replied|converted|failed|opted_out
  message_id    uuid references messages(id),
  updated_at    timestamptz not null default now(),
  unique (campaign_id, contact_id)
);

-- ============ TICKETS, TASKS, NOTES ============

create table tickets (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  contact_id    uuid references contacts(id),
  conversation_id uuid references conversations(id),
  subject       text not null,
  priority      text not null default 'medium',   -- p3|p2|p1 mapped in UI
  status        text not null default 'open',     -- open|pending|resolved|closed
  sla_due_at    timestamptz,
  assigned_user_id uuid references users(id),
  created_by    text not null default 'ai',
  created_at    timestamptz not null default now()
);

create table tasks (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  title         text not null,
  contact_id    uuid references contacts(id),
  deal_id       uuid references deals(id),
  due_at        timestamptz,
  done          boolean not null default false,
  assigned_user_id uuid references users(id),
  created_by    text not null default 'ai',
  created_at    timestamptz not null default now()
);

create table notes (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  contact_id    uuid references contacts(id),
  deal_id       uuid references deals(id),
  author_user_id uuid references users(id),
  body          text not null,
  created_at    timestamptz not null default now()
);

-- ============ KNOWLEDGE BASE (RAG) ============

create table knowledge_sources (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  brand_id      uuid references brands(id),
  name          text not null,
  kind          text not null,       -- pdf|doc|faq|url_crawl|catalog
  status        text not null default 'pending',  -- pending|indexing|indexed|failed
  agent_access  jsonb not null default '["*"]',    -- agent ids or *
  refresh_cron  text,
  storage_key   text,
  created_at    timestamptz not null default now()
);

create table knowledge_chunks (
  id          bigserial primary key,
  source_id   uuid not null references knowledge_sources(id) on delete cascade,
  workspace_id uuid not null,
  seq         int not null,
  content     text not null,
  embedding   vector(1536) not null,
  meta        jsonb not null default '{}'
);
create index on knowledge_chunks using hnsw (embedding vector_cosine_ops);
create index on knowledge_chunks (workspace_id, source_id);

-- ============ WEBHOOKS OUT (developer platform) ============

create table webhook_endpoints (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  url           text not null,
  secret        text not null,        -- HMAC key, shown once
  events        text[] not null,      -- conversation.created, message.received, deal.updated, call.completed, appointment.confirmed, agent.escalated ...
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table webhook_deliveries (
  id            bigserial primary key,
  endpoint_id   uuid not null references webhook_endpoints(id) on delete cascade,
  event         text not null,
  payload       jsonb not null,
  status        text not null default 'pending',   -- pending|delivered|failed|dead
  attempts      int not null default 0,
  next_retry_at timestamptz,
  response_code int,
  created_at    timestamptz not null default now()
);
create index on webhook_deliveries (status, next_retry_at);

-- ============ ROW LEVEL SECURITY (pattern, apply per table) ============

alter table contacts enable row level security;
create policy tenant_isolation on contacts
  using (workspace_id = current_setting('app.workspace_id')::uuid);
-- repeat for every workspace scoped table
```

### Notes engineers will ask about

**Idempotency.** Every provider message and call carries a provider id with a unique constraint, so webhook retries can never duplicate rows. Outbound sends use an idempotency key = `approval_id` or `message.id` so a crashed executor never double sends.

**Autonomy resolution.** Effective level = `min(workspaces.ai_autonomy, agents.autonomy)`. An action executes automatically only when effective level ≥ `action_policies.min_autonomy` and any threshold passes; otherwise an `approvals` row is created. This single function is the safety heart of the platform; unit test it to death.

**Hot tables.** `messages` and `activity_log` grow fastest. Partition both by month on `created_at` from day one; it costs nothing now and saves a painful migration later.

---

## 3. MrAssistant.ai webhook contract (Voice ↔ Buzzz)

### 3.1 Security (applies to GoWhats and InstaxBot too)

All webhooks are signed. Headers:

```
X-Buzzz-Timestamp: 1755350400
X-Buzzz-Signature: v1=hex(hmac_sha256(secret, timestamp + "." + raw_body))
X-Buzzz-Event-Id: 018f3a2e-...        (idempotency key)
```

Receiver rules: reject if `|now − timestamp| > 300s` (replay protection), compare signatures with constant time equality, respond `2xx` within 5 seconds and do the real work async. Retries: exponential backoff at 1m, 5m, 30m, 2h, 12h, then mark dead and alert. Same envelope, same rules, in both directions.

### 3.2 Events MrAssistant.ai sends to Buzzz

`POST https://api.buzzzbuzzz.com/v1/hooks/mrassistant`

| Event | When |
|---|---|
| `call.started` | call connected, direction and numbers known |
| `call.completed` | call ended normally, duration and outcome known |
| `call.missed` | inbound not answered or outbound not picked up |
| `call.transferred` | AI transferred to a human number or queue |
| `call.transcript.ready` | full transcript segments available |
| `call.recording.ready` | recording uploaded, URL available |
| `call.analysis.ready` | summary, intent, sentiment, extracted entities, proposed CRM actions |

Envelope (`call.analysis.ready`, the richest one):

```json
{
  "event": "call.analysis.ready",
  "event_id": "evt_01J8ZK3W9M",
  "occurred_at": "2026-08-16T09:26:41Z",
  "workspace_ref": "ws_acme",
  "data": {
    "call_id": "mra_call_9f21c",
    "direction": "outbound",
    "from": "+6531290000",
    "to": "+919840722110",
    "agent_ref": "voz_voice_agent",
    "started_at": "2026-08-16T09:22:01Z",
    "duration_sec": 250,
    "summary": "Arun confirmed Thursday for the scoping call and asked for the security whitepaper.",
    "intent": "sales",
    "sentiment": "positive",
    "entities": {
      "meeting": { "day": "Thursday", "time": "11:00", "tz": "Asia/Kolkata" },
      "documents_requested": ["security_whitepaper"]
    },
    "proposed_actions": [
      { "action": "appointment.book",
        "payload": { "title": "Enterprise scoping call", "starts_at": "2026-08-21T05:30:00Z", "duration_min": 45, "confirm_channel": "whatsapp" } },
      { "action": "task.create",
        "payload": { "title": "Send security whitepaper to Arun" } }
    ],
    "recording": { "url": "https://cdn.mrassistant.ai/rec/9f21c.mp3", "expires_at": "2026-08-17T09:26:41Z" },
    "transcript_url": "https://api.mrassistant.ai/v1/calls/mra_call_9f21c/transcript"
  }
}
```

Buzzz handling: upsert `calls` by `provider_call_id`, resolve or create the contact by phone identity, attach to (or open) a conversation, store transcript segments, then feed `proposed_actions` through the **same autonomy check as chat**. That is how a call books an appointment and the customer gets a WhatsApp confirmation through GoWhats with zero human steps at Level 3+, or lands in Approvals below that.

### 3.3 Calls Buzzz makes to MrAssistant.ai

```
POST https://api.mrassistant.ai/v1/calls          # place outbound call
{
  "to": "+2348037712210",
  "from_account": "acct_buzzz_sg1",
  "agent": "voz_voice_agent",
  "goal": "Confirm technical deep dive slot this week",
  "script_hints": ["propose Wednesday 15:00", "fallback Thursday 10:00"],
  "context": {
    "contact_name": "Tom Okafor",
    "crm_summary": "Qualified lead, hard deadline 28 Aug",
    "callback_webhook": "https://api.buzzzbuzzz.com/v1/hooks/mrassistant"
  },
  "metadata": { "workspace_ref": "ws_acme", "approval_id": "apr_88d1" }
}
→ 201 { "call_id": "mra_call_ab77", "status": "queued" }

GET  https://api.mrassistant.ai/v1/calls/{id}                # status
GET  https://api.mrassistant.ai/v1/calls/{id}/transcript     # segments
POST https://api.mrassistant.ai/v1/calls/{id}/transfer       # hand to human
```

`metadata` is echoed back on every webhook so Buzzz can correlate without lookups.

---

## 4. GoWhats and InstaxBot adapter contracts

Both plug into the same normalized envelope, which is what makes "add a channel, change nothing else" real. Reuse the existing gowhats.in and instaxbot.com codebases as thin providers: keep their sending, template and session logic, and add (a) this webhook out to Buzzz and (b) this send API in.

### 4.1 Inbound: provider → Buzzz

`POST https://api.buzzzbuzzz.com/v1/hooks/gowhats` and `/v1/hooks/instaxbot`, signed as in 3.1.

```json
{
  "event": "message.received",
  "event_id": "evt_gw_7781",
  "occurred_at": "2026-08-16T10:31:02Z",
  "provider": "gowhats",
  "data": {
    "provider_message_id": "wamid.HBgL...",
    "channel": "whatsapp",
    "account_external_id": "phone_number_id_112233",
    "from": { "identifier": "+919840722110", "name": "Arun Kumar" },
    "content_type": "text",
    "body": "Yes, I would like to book the scoping call. Thursday works.",
    "attachments": [],
    "context": { "reply_to_provider_message_id": null },
    "raw": { }
  }
}
```

Status events use the same shape with `event = message.status` and `data.status` ∈ `sent|delivered|read|failed` plus `provider_message_id`. InstaxBot is identical with `channel: "instagram"`, `from.identifier` = IG scoped user id, and extra events `story.reply`, `comment.received` (Buzzz treats a comment as a conversation opener when the workflow says so).

### 4.2 Outbound: Buzzz → provider

```
POST https://api.gowhats.in/v1/messages
{
  "account_external_id": "phone_number_id_112233",
  "to": "+919840722110",
  "type": "text",                       // text|template|media|interactive
  "body": "Confirmed: Enterprise scoping call, Thu 21 Aug, 11:00 IST. Reply R to reschedule.",
  "template": null,                     // {"name":"appt_confirm_v2","lang":"en","variables":[...]} outside the 24h window
  "idempotency_key": "msg_0192fa"
}
→ 202 { "provider_message_id": "wamid.HBgL..." }
```

InstaxBot mirrors it at `POST https://api.instaxbot.com/v1/messages` with IG constraints (24h window, message tags). The Action Executor picks template vs free text automatically based on the session window GoWhats reports.

**Appointment confirmations** are just this send API driven by the appointments module: on booking → confirmation message; at T−24h and T−2h → reminders (workflow timers); on reply with a new time → the Appointment Agent rebooks and reconfirms; on no show → recovery message with fresh slots. All of it lands in `activity_log` and the conversation thread.

---

## 5. Build order

Phase 1 (weeks 1 to 4): tenancy + auth + RLS, channel gateway with GoWhats inbound and outbound, conversations, messages, contacts with identity resolution, realtime inbox. Phase 2 (weeks 5 to 8): agent runtime with one Sales agent, autonomy engine + approvals + activity log, knowledge base with pgvector, appointments with confirmations and reminders. Phase 3 (weeks 9 to 12): InstaxBot and email adapters, MrAssistant.ai webhooks both ways, pipelines and deals, workflow engine. Phase 4: campaigns, analytics rollups, natural language workflow builder, developer webhooks, remaining channels.

The prototype you already have doubles as the living spec for the frontend; every screen in it maps one to one onto the tables and events above.

---

## 6. MrAssistant.ai ↔ Buzzz — Provisioning and SSO contract

This section makes the "one platform, two front doors" model concrete. MrAssistant.ai talks to Buzzz only through this partner surface, which is a superset of the public API, so nothing here would break if a third party voice product implemented the same contract. Security follows section 3.1 exactly: signed requests, timestamp replay protection, idempotency keys, and the same retry ladder on webhooks.

### 6.1 Schema additions

```sql
-- who created and owns the commercial relationship for a workspace
alter table workspaces add column provisioned_by text not null default 'direct';
       -- 'direct' | 'mrassistant' | future partners
alter table workspaces add column partner_account_ref text;
       -- MrAssistant.ai account id, unique per partner
create unique index on workspaces (provisioned_by, partner_account_ref)
  where partner_account_ref is not null;

-- feature entitlements, settable only by the owning biller
create table entitlements (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  feature       text not null,   -- 'inbox','crm','agents','campaigns','voice','api'
  limit_value   bigint,          -- null = unlimited; seats, monthly AI actions, contacts...
  source        text not null default 'plan',   -- plan|partner|manual
  unique (workspace_id, feature)
);

-- cross product identity links
create table identity_links (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references users(id) on delete cascade,
  provider      text not null,          -- 'mrassistant'
  provider_user_id text not null,
  linked_at     timestamptz not null default now(),
  unique (provider, provider_user_id)
);

-- partner credentials (MrAssistant is a registered OAuth client and API partner)
create table partner_clients (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null,          -- 'mrassistant'
  client_id     text not null unique,
  client_secret_hash text not null,
  redirect_uris text[] not null,
  scopes        text[] not null,        -- 'provision','sso','usage:read'
  active        boolean not null default true
);
```

Billing rule encoded by `provisioned_by`: the owning product is the only one allowed to change `plan` and `entitlements` for that workspace. Buzzz never bills a MrAssistant provisioned workspace directly, and vice versa. Meters stay separate regardless: voice minutes are metered by MrAssistant, messages and AI actions by Buzzz, and each side can read the other's meters through the usage API below.

### 6.2 SSO: OIDC with MrAssistant.ai as the identity provider

For MrAssistant provisioned workspaces, mrassistant.ai is the OpenID Connect provider and Buzzz is the relying party. Standalone Buzzz customers keep email plus password or their own SAML/OIDC IdP; nothing in this section applies to them.

Flow (authorization code with PKCE):

```
1. User clicks "Open Communication Hub" inside mrassistant.ai
2. Browser →  https://app.buzzzbuzzz.com/sso/mrassistant/start?account=acct_881
3. Buzzz    →  302 to https://auth.mrassistant.ai/oauth/authorize
               ?client_id=buzzz&response_type=code&scope=openid profile email buzzz.sso
               &redirect_uri=https://app.buzzzbuzzz.com/sso/mrassistant/callback
               &state=<csrf>&code_challenge=<pkce>&login_hint=acct_881
4. MrAssistant authenticates (session already exists → instant) → 302 back with code
5. Buzzz    →  POST https://auth.mrassistant.ai/oauth/token   (code + verifier)
           ←  { access_token, id_token, refresh_token, expires_in }
6. Buzzz validates the id_token, upserts the user, follows identity_links,
   resolves the workspace by partner_account_ref, opens a Buzzz session
```

Required `id_token` claims:

```json
{
  "iss": "https://auth.mrassistant.ai",
  "aud": "buzzz",
  "sub": "mra_user_5521",
  "email": "jordan@acme.com",
  "email_verified": true,
  "name": "Jordan Lee",
  "mra_account_id": "acct_881",
  "mra_role": "owner",
  "iat": 1755350400, "exp": 1755354000, "nonce": "..."
}
```

Role mapping on every SSO login (MrAssistant is authoritative for its own workspaces): `owner→owner`, `admin→admin`, `member→agent`, `viewer→viewer`. A user demoted in MrAssistant is demoted in Buzzz at next login, and the `session.revoke` webhook below handles the immediate case. JIT provisioning: an unknown `sub` with a valid token creates the user, the identity link, and the membership in one transaction.

**Account linking for people who bought both separately.** From Buzzz settings, "Connect MrAssistant.ai" runs the same OIDC flow with scope `link` and writes only an `identity_links` row; workspace ownership and billing do not change. Linking requires a fresh MrAssistant authentication (max_age=300) and email match or explicit confirmation, which blocks account takeover through a stale session.

### 6.3 Provisioning API: MrAssistant.ai → Buzzz

Base: `https://partner.buzzzbuzzz.com/v1`, authenticated with the partner client credentials grant (`scope=provision`). All POSTs require `Idempotency-Key`.

Create (or ensure) a workspace when a MrAssistant customer enables the hub:

```
POST /v1/provision/workspaces
{
  "partner_account_ref": "acct_881",
  "name": "Acme Corporation",
  "admin": { "provider_user_id": "mra_user_5521",
             "email": "jordan@acme.com", "name": "Jordan Lee" },
  "plan": "growth",
  "entitlements": [
    { "feature": "inbox",  "limit_value": null },
    { "feature": "crm",    "limit_value": null },
    { "feature": "agents", "limit_value": 3 },
    { "feature": "voice",  "limit_value": null }
  ],
  "voice_account": {                         // optional, wires the channel now
    "provider": "mrassistant",
    "external_id": "acct_881_line_1",
    "display_name": "+65 3129 0000 Main line",
    "webhook_secret": "whsec_..."            // for section 3 events
  },
  "timezone": "Asia/Singapore"
}
→ 201
{
  "workspace_id": "ws_9a2f...",
  "workspace_url": "https://acme.buzzzbuzzz.com",
  "sso_entry_url": "https://app.buzzzbuzzz.com/sso/mrassistant/start?account=acct_881",
  "status": "active"
}
```

Repeating the call with the same `partner_account_ref` returns the existing workspace (200), which makes the endpoint safe to call from a retry loop. Then:

```
PATCH  /v1/provision/workspaces/{id}            # rename, plan, timezone
PUT    /v1/provision/workspaces/{id}/entitlements
POST   /v1/provision/workspaces/{id}/channel-accounts   # add voice lines later
DELETE /v1/provision/workspaces/{id}/channel-accounts/{caId}
POST   /v1/provision/workspaces/{id}/suspend    # nonpayment: read only mode
POST   /v1/provision/workspaces/{id}/resume
DELETE /v1/provision/workspaces/{id}            # schedules deletion, 30 day grace,
                                                # export bundle generated first
GET    /v1/provision/workspaces/{id}/usage?period=2026-08
→ { "messages_in": 4210, "messages_out": 3980, "ai_actions": 2610,
    "active_seats": 6, "contacts": 1840, "storage_mb": 912 }
```

Suspension semantics matter for support quality: a suspended workspace keeps receiving and storing inbound messages so no customer conversation is lost, but all outbound sending, agent execution and logins except the owner are blocked until resume.

### 6.4 Lifecycle webhooks: Buzzz → MrAssistant.ai

`POST https://api.mrassistant.ai/v1/hooks/buzzz`, signed per 3.1. MrAssistant uses these to drive its own billing page and admin UI without polling.

| Event | Payload core |
|---|---|
| `workspace.provisioned` | workspace_id, partner_account_ref, plan |
| `workspace.plan_limit_reached` | feature, limit_value, current |
| `workspace.usage.rollup` | monthly counters, sent on the 1st |
| `workspace.suspended` / `workspace.resumed` | actor, reason |
| `workspace.deletion_scheduled` | purge_at, export_url (signed, 7 days) |
| `member.role_changed` | user email, old, new (when changed inside Buzzz) |

And one in the reverse direction that Buzzz must honor immediately, delivered to the section 3 endpoint: `session.revoke` with `{ "provider_user_id": "mra_user_5521" }` kills all active Buzzz sessions for that linked user within 60 seconds, covering offboarding done on the MrAssistant side.

### 6.5 The discipline clause

Everything above is expressible with the public API surface plus two partner scopes (`provision`, `sso`). Nothing in the Buzzz core may check `provisioned_by == 'mrassistant'` to unlock behavior; the flag exists only for billing ownership and attribution. That single rule is what keeps standalone Buzzz honest as a product, keeps a future GoWhats or InstaxBot bundle one config file away, and means you could onboard a reseller tomorrow by inserting one `partner_clients` row.

---

## 7. Scheduling engine and industry packs

Appointments graduate from "a meeting with a time" into a real scheduling platform: services, locations, staff and rooms, availability, and industry presets that configure a workspace in one click. This section extends section 2; nothing there changes.

### 7.1 Schema

```sql
-- physical places for in person visits (clinic branch, salon, store, campus)
create table locations (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  brand_id      uuid references brands(id),
  name          text not null,
  address       text,
  geo           point,
  timezone      text not null,
  status        text not null default 'active',
  created_at    timestamptz not null default now()
);

-- anything a booking occupies: a doctor, stylist, chair, room, table, vehicle
create table resources (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  location_id   uuid references locations(id),
  kind          text not null,          -- staff|room|chair|table|equipment
  name          text not null,          -- 'Dr. Priya', 'Chair 3', 'Room B'
  user_id       uuid references users(id),   -- when the resource is a person with a login
  capacity      int not null default 1,      -- tables and classes can seat many
  status        text not null default 'active'
);

-- what customers book
create table services (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,          -- 'Consultation', 'Color treatment'
  duration_min  int  not null,
  buffer_min    int  not null default 0,
  location_kind text not null default 'in_person',  -- in_person|video|phone
  price_cents   bigint,
  deposit_cents bigint,                 -- salons and clinics love deposits
  max_per_slot  int not null default 1, -- group classes
  booking_slug  text,                   -- public page per service
  active        boolean not null default true
);

-- which resources can deliver which services, at which locations
create table service_resources (
  service_id  uuid references services(id) on delete cascade,
  resource_id uuid references resources(id) on delete cascade,
  primary key (service_id, resource_id)
);

-- weekly availability plus exceptions (holidays, leave)
create table availability_rules (
  id           uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null,
  owner_type   text not null check (owner_type in ('location','resource')),
  owner_id     uuid not null,
  weekday      int  check (weekday between 0 and 6),   -- null for date exceptions
  date_on      date,                                    -- exception day
  opens        time, closes time,
  closed       boolean not null default false
);

-- appointments (section 2) gain the scheduling references
alter table appointments add column location_id uuid references locations(id);
alter table appointments add column service_id  uuid references services(id);
alter table appointments add column resource_id uuid references resources(id);
alter table appointments add column party_size  int not null default 1;
alter table appointments add column is_walk_in  boolean not null default false;
alter table appointments add column deposit_status text;   -- pending|paid|waived|refunded

-- prevent double booking of a resource at the database level
create extension if not exists btree_gist;
alter table appointments add column time_range tstzrange
  generated always as (tstzrange(starts_at, ends_at, '[)')) stored;
alter table appointments add constraint no_resource_overlap
  exclude using gist (resource_id with =, time_range with &&)
  where (resource_id is not null
         and status in ('awaiting_confirmation','confirmed','rescheduled'));
```

The exclusion constraint is the whole ballgame for reliability: even if two agents, a human and the public booking page race for the same chair at the same minute, Postgres rejects the second insert and the API returns fresh alternatives. No distributed locks, no apology emails.

### 7.2 Slot search API (used by agents, the UI and the public booking page)

```
GET /v1/scheduling/slots?service_id=...&location_id=...&resource_id=optional
    &from=2026-08-19&to=2026-08-22&tz=Asia/Kolkata
→ {
  "slots": [
    { "starts_at": "2026-08-19T04:00:00Z", "resource_id": "res_priya", "location_id": "loc_dt" },
    { "starts_at": "2026-08-19T04:30:00Z", "resource_id": "res_priya", "location_id": "loc_dt" }
  ],
  "next_available": "2026-08-19T04:00:00Z"
}

POST /v1/appointments
{ "service_id": "...", "location_id": "...", "resource_id": "auto",
  "contact_id": "...", "starts_at": "...", "party_size": 1,
  "confirm_channel": "whatsapp", "source": "agent|booking_page|walk_in|call" }
→ 201, and the confirmation plus reminder pipeline from section 4 fires
```

`resource_id: "auto"` lets the engine pick the least loaded qualified resource, which is what the Appointment Agent uses. Walk ins are the same POST with `is_walk_in: true` and `starts_at: now`, so the front desk queue and online bookings live in one table and one calendar.

### 7.3 Industry packs

A pack is data, not code: applying one inserts rows, sets labels, and activates agents. Switching industries later never migrates anything, it only adds.

```sql
create table industry_templates (
  id         text primary key,          -- 'healthcare','salon','retail',...
  name       text not null,
  config     jsonb not null             -- the whole pack, versioned
);

alter table workspaces add column industry text references industry_templates(id);
alter table workspaces add column labels jsonb not null default '{}';
       -- {"contact":"Patient","location":"Clinic","deal":"Treatment plan"}
```

Pack config shape (healthcare, abridged):

```json
{
  "labels": { "contact": "Patient", "location": "Clinic" },
  "services": [
    { "name": "Consultation", "duration_min": 20, "location_kind": "in_person" },
    { "name": "Follow up visit", "duration_min": 15, "location_kind": "in_person" },
    { "name": "Telehealth call", "duration_min": 15, "location_kind": "video" }
  ],
  "pipeline": { "name": "Patient journey",
    "stages": ["Inquiry","Booked","Visited","Treatment plan","Recurring","Inactive"] },
  "agents_enabled": ["appointment","support","retention","voice"],
  "workflows": ["no_show_recovery","reminder_24h_2h","post_visit_followup"],
  "knowledge_starters": ["services_and_prices","insurance_faq"],
  "compliance": { "notes_visibility": "restricted", "retention_days": 2555 }
}
```

Apply endpoint, callable from onboarding or settings, and by MrAssistant.ai during provisioning (section 6 gains an optional `"industry": "healthcare"` field on the provision call):

```
POST /v1/workspaces/{id}/apply-industry   { "industry": "salon" }
→ 200 { "created": { "services": 4, "workflows": 3, "stages": 6 }, "labels_updated": true }
```

Labels flow to the frontend through the existing workspace settings payload, so the UI says Patients, Guests or Clients everywhere without an if statement per industry. Vertical specific compliance (a clinic's stricter note visibility and retention) rides in the same config, enforced by the policies engine rather than by branching code, keeping the discipline clause from section 6.5 intact: one platform, any industry, configured by data.

---

## 8. Bring your own AI keys, and the social publishing engine

### 8.1 BYO provider keys

Each workspace supplies its own credentials: a GPT style API key for language, and a public plus secret key pair for image generation. Buzzz proxies every AI call through its own gateway so guardrails, autonomy checks, logging and rate limits still apply, but the upstream bill lands on the customer's provider account.

```sql
create table provider_keys (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  purpose       text not null check (purpose in ('llm','image')),
  provider      text not null,            -- 'openai','anthropic','stability','flux',...
  public_key    text,                     -- image providers with pk/sk pairs
  secret_enc    bytea not null,           -- envelope encrypted (KMS data key per row)
  key_hint      text not null,            -- 'sk-...9f2A' for the settings UI
  status        text not null default 'unverified',  -- unverified|active|invalid|revoked
  last_verified timestamptz,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  unique (workspace_id, purpose)
);
```

Rules the AI gateway enforces: secrets are envelope encrypted with a per row data key and decrypted only inside the gateway process, never returned by any API (`key_hint` is all the UI ever sees). On save, the gateway makes a one token verification call and flips `status`. Every agent call resolves keys in this order: workspace `provider_keys` → pooled platform key with plan limits → refuse with a clear "add your key" error. Failures degrade loudly: an invalid key pauses agents into Suggest only mode and notifies the owner rather than silently burning the pooled quota. Per call usage (tokens, images, cost estimate) is written to `activity_log.detail` so the workspace can reconcile against the provider invoice.

```
PUT  /v1/workspaces/{id}/provider-keys/llm     { "provider": "openai", "secret": "sk-..." }
PUT  /v1/workspaces/{id}/provider-keys/image   { "provider": "stability", "public_key": "pk-...", "secret": "sk-..." }
GET  /v1/workspaces/{id}/provider-keys         → hints and status only
DELETE /v1/workspaces/{id}/provider-keys/{purpose}
```

### 8.2 Social media management

Social reuses the muscle the platform already has: InstaxBot is the Instagram publisher, channel adapters cover Facebook, LinkedIn, X, YouTube and Google Business, comments and DMs flow into the unified inbox as conversations, and the Social Agent (Sky) obeys the same autonomy engine, so drafts below level 3 become approval objects exactly like a refund would.

```sql
create table social_accounts (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  brand_id      uuid references brands(id),
  channel       text not null,          -- instagram|facebook|linkedin|x|youtube|google_business
  provider      text not null,          -- 'instaxbot','meta','linkedin',...
  external_id   text not null,
  display_name  text not null,
  credentials   jsonb not null default '{}',
  status        text not null default 'active',
  unique (provider, external_id)
);

create table social_posts (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  brand_id      uuid references brands(id),
  author_type   text not null default 'user',      -- user|agent_ai
  author_agent_id uuid references agents(id),
  body          text not null,
  media         jsonb not null default '[]',       -- [{storage_key, kind, alt, gen_meta}]
  status        text not null default 'draft',
                -- draft|needs_approval|approved|scheduled|publishing|published|failed|deleted
  scheduled_at  timestamptz,
  approval_id   uuid references approvals(id),
  campaign_id   uuid references campaigns(id),
  created_at    timestamptz not null default now()
);

create table social_post_targets (
  id            uuid primary key default uuid_generate_v4(),
  post_id       uuid not null references social_posts(id) on delete cascade,
  account_id    uuid not null references social_accounts(id),
  provider_post_id text,
  status        text not null default 'pending',   -- pending|published|failed
  error         text,
  published_at  timestamptz,
  unique (post_id, account_id)
);

create table social_post_metrics (
  target_id     uuid primary key references social_post_targets(id) on delete cascade,
  reach bigint default 0, impressions bigint default 0,
  likes int default 0, comments int default 0, shares int default 0, clicks int default 0,
  synced_at     timestamptz
);
```

Publish flow: composer or agent creates `social_posts` with one target row per selected account; media generated through the image gateway lands in S3 with `gen_meta` recording prompt, provider and cost. At `scheduled_at` the publisher worker fans out per target (each target retries independently, so a LinkedIn outage never blocks the Instagram post), stores `provider_post_id`, and a metrics sync job polls engagement into `social_post_metrics` on a decaying schedule (15 min for the first day, hourly for a week, daily after). Inbound engagement webhooks (`comment.received`, `dm.received`) from InstaxBot and the other adapters open conversations tagged with the post, which is how a comment becomes a lead in the CRM without any new machinery.

Agent contract: "Plan my week" asks Sky for a content calendar; each generated post arrives as `needs_approval` with an `approvals` row (action `social.publish`, `min_autonomy` 3 by default), and approving moves it to scheduled. Replies to comments follow the conversation autonomy rules that already exist, with a hard rule that political and sensitive comments always escalate to a human.

API surface: `POST /v1/social/posts`, `POST /v1/social/posts/{id}/schedule`, `POST /v1/social/posts/{id}/publish-now`, `GET /v1/social/posts?status=...`, `GET /v1/social/accounts`, plus `social.post.published` and `social.post.failed` added to the developer webhook events in section 2.

---

## 9. Voice layer: MrAssistant.ai integration

### 9.1 Why an abstraction

Every call in Buzzz runs on MrAssistant.ai, but the product must never feel like a wrapper around someone else's dashboard, and we may add a second voice vendor later. So the platform talks to a `VoiceProvider` interface and `MrAssistantProvider` is the only implementation that knows the vendor exists. The frontend calls our own backend at `/api/voice/*`; our backend attaches the bearer token and forwards to `api.mrassistant.ai`. The browser never holds provider credentials, never sees a provider URL, and a vendor swap touches one file.

```
Browser  →  /api/voice/*  →  VoiceProvider  →  MrAssistantProvider  →  api.mrassistant.ai
                (ours, authenticated)              (token lives here)
```

### 9.2 Endpoints actually used

These are the real operations from the published API description, mapped one to one by the proxy. Nothing outside this list is invented.

| Purpose | Method | Path |
|---|---|---|
| Place an outbound call | POST | `/calls/outbound` |
| Call status | GET | `/calls/{call_id}/status` |
| End a call | POST | `/calls/{call_id}/end` |
| Transfer a call | POST | `/calls/{call_id}/transfer` |
| Realtime control (LiveKit room/participant) | POST | `/calls/{call_id}/control` |
| Mute / unmute | POST | `/calls/{call_id}/mute` |
| Call history for an agent | GET | `/calls/agent/{agent_id}/calls?limit&offset&direction&status_filter&start_date&end_date` |
| Currently active calls | GET | `/calls/agent/{agent_id}/active` |
| Recording metadata and download URL | GET | `/calls/{call_id}/recording` |
| Egress artifacts | GET | `/calls/{call_id}/artifact` |
| Transcript list | GET | `/agents/{agent_id}/transcripts?limit&offset&channel&status` |
| Transcript detail | GET | `/agents/{agent_id}/transcripts/{session_id}` |
| Generate or regenerate summary | POST | `/agents/{agent_id}/transcripts/{session_id}/summarize` |
| Export transcript | GET | `/agents/{agent_id}/transcripts/{session_id}/export` |
| Recording list / fresh download URL | GET | `/agents/{agent_id}/recordings`, `/recordings/{id}/download-url` |
| Live session events | SSE | `/voice/sessions/{session_id}/events` |
| Pipeline diagnostics (ASR → LLM → TTS, latency, tools) | GET | `/voice/sessions/{session_id}/trace` |
| Call statistics / realtime metrics | GET | `/analytics/calls/statistics`, `/analytics/realtime` |
| Outbound calling campaigns | POST/GET | `/campaigns`, `/campaigns/{id}/status` |
| LiveKit webhook receiver (their side → ours) | POST | provider webhook |

Provider statuses are used verbatim: `initiated`, `ringing`, `answered`, `ended`, `failed`. We add `missed`, `busy`, `cancelled` and `transferred` only where our own records justify them, and we label rather than rename.

Capabilities the API does **not** offer, and which therefore have no control in the interface: call hold, supervisor whisper, and barge-in. This is enforced by a `VOICE_CAPS` map the UI reads, so an unsupported control cannot appear by accident.

### 9.3 Source of truth

MrAssistant owns voice execution, the agent runtime, phone connectivity, sessions, recordings and transcription. Buzzz owns the contact, lead, deal, appointment, campaign, workflow, permissions, timeline and business analytics. We do not copy audio; we store the `call_id`, `session_id`, recording pointer and a normalized summary, then fetch a fresh signed URL at play or download time.

### 9.4 Synchronization

Do not hit the provider on every page load. A `calls` table in our database is the read model:

```sql
create table calls (
  id uuid primary key,                     -- our id
  workspace_id uuid not null references workspaces(id),
  provider text not null default 'mrassistant',
  provider_call_id text not null,
  provider_session_id text,
  agent_id uuid,                           -- provider agent
  contact_id uuid references contacts(id), -- resolved by normalized phone
  direction text not null,                 -- inbound | outbound
  from_number text, to_number text,
  status text not null,                    -- provider vocabulary
  started_at timestamptz, ended_at timestamptz, duration_seconds int,
  outcome text,                            -- our business vocabulary
  reason text, intent text, sentiment text, next_action text,
  summary text, transcript_indexed tsvector,
  recording_ref text, assignee_id uuid, tags text[],
  unique (workspace_id, provider, provider_call_id)
);
create index on calls (workspace_id, started_at desc);
create index on calls using gin (transcript_indexed);
```

Population happens three ways: the LiveKit webhook for lifecycle events, the SSE session stream while a call is live, and a backfill job paging `/calls/agent/{id}/calls` with `limit`/`offset` for anything missed. The unique constraint on `provider_call_id` makes every path idempotent, so a webhook replay or a worker restart cannot duplicate a call. Transcript text is indexed into `tsvector` on arrival, which is what makes "find calls where someone said quotation" a fast database query instead of a provider round trip.

### 9.5 Contact resolution

Phone numbers are normalized to their last ten digits before matching, so `+91 98407 22110`, `9840722110` and `098407-22110` resolve to one contact. On no match we create a contact with source `Phone`, never a duplicate: the insert runs against the same normalized index used for lookup.

### 9.6 Outcome writeback

The call outcome is the bridge into the rest of the platform, and each value has a defined side effect: `Appointment Booked` creates an appointment, `Sale Completed` creates a won deal, `Lead Qualified` promotes the contact status, `Follow-up Required` and `Callback Requested` create tasks. Every one lands on the customer timeline and in the audit log with who, what, when and result.

### 9.7 Failure handling

The proxy translates provider failures into messages a business user can act on: 401 becomes a reconnect prompt, 422 becomes "check the number is in full international format", 5xx becomes "the voice provider is unavailable, nothing was charged and no call was placed". Raw status codes never reach the interface. Outbound requests carry an idempotency key so a retry after a timeout cannot dial the same person twice.

### 9.8 Tenancy

Every query is scoped by `workspace_id`, and the proxy refuses any `call_id` or `session_id` that does not belong to the caller's workspace before it forwards. Recording URLs are signed, short lived, and re-issued per request rather than stored.

---

## 10. Digital workforce: agent governance

### 10.1 The gate

An agent is not a prompt, it is a governed worker. Every action it attempts, whether it originates in the inbox, a workflow node, a campaign, a call or BUZZZ AI, passes through one function before anything happens:

```
request → agent status → permission grant → tool grant → autonomy vs action minimum
        → workspace ceiling → channel allowed → guardrail scan → approval → execute → log
```

The frontend calls the same pipeline for user feedback, but authorization is decided server side. A client that posts `CAN_CREATE_DEAL` for a Level 2 agent is rejected by the API regardless of what the UI showed.

```sql
create table agents (
  id uuid primary key, workspace_id uuid not null references workspaces(id),
  name text not null, title text, type text not null, status text not null default 'draft',
  autonomy int not null default 1 check (autonomy between 0 and 4),
  allow_destructive boolean not null default false,
  role text, purpose text, department text, instructions jsonb, tone text, tones text[], languages text[],
  channels text[], tools text[], knowledge_ids uuid[], memory_scope text[],
  escalation jsonb, guardrails text[], created_by uuid, created_at timestamptz default now(),
  unique (workspace_id, lower(name))
);
create table agent_permissions (
  agent_id uuid references agents(id) on delete cascade,
  action text not null, granted boolean not null default false,
  primary key (agent_id, action)
);
create table agent_versions (
  id bigserial primary key, agent_id uuid references agents(id) on delete cascade,
  snapshot jsonb not null, created_by uuid, created_at timestamptz default now()
);
create table agent_activity (
  id bigserial primary key, workspace_id uuid not null, agent_id uuid references agents(id),
  action text not null, contact_id uuid, conversation_id uuid, channel text,
  tool text, result text not null,               -- executed | queued | refused | blocked
  reason text, approval_id uuid, created_at timestamptz default now()
);
create index on agent_activity (workspace_id, agent_id, created_at desc);
```

### 10.2 Action registry

Permissions are data, not code branches, so a new capability is a row rather than a release. Each action declares the autonomy level it needs, the tool it depends on and a risk band:

| Action | Min level | Tool | Risk |
|---|---|---|---|
| `CAN_READ_CRM` | 0 | CRM | low |
| `CAN_UPDATE_CONTACT` | 2 | CRM | low |
| `CAN_SEND_WHATSAPP` | 2 | GoWhats | medium |
| `CAN_BOOK_APPOINTMENT` | 3 | Calendar | medium |
| `CAN_CREATE_DEAL` | 3 | CRM | medium |
| `CAN_PLACE_CALL` | 3 | MrAssistant.ai | high |
| `CAN_POST_SOCIAL` | 4 | Publisher | high |
| `CAN_START_CAMPAIGN` | 4 | Campaigns | high |
| `CAN_CREATE_PAYMENT_LINK` | 4 | Payments | high |
| `CAN_DELETE_CRM`, `CAN_CANCEL_APPOINTMENT`, `CAN_ISSUE_REFUND` | 4 | varies | destructive |

Destructive actions always require a human, even at Level 4, unless an admin explicitly sets `allow_destructive` on that agent. A permission without its tool is inert: granting "send WhatsApp" to an agent with no GoWhats tool fails the pipeline with a specific reason rather than silently doing nothing.

### 10.3 Ceiling

`workspaces.autonomy_ceiling` caps every agent. The effective level is `min(agent.autonomy, workspace.ceiling)`, computed at execution time rather than at save time, so lowering the ceiling instantly downgrades the whole workforce without touching agent records. Attempts to save above the ceiling are rejected with the ceiling stated.

### 10.4 Guardrails and escalation

Guardrails are evaluated against the candidate output before it is sent. A match blocks the send, records `result = 'blocked'` with the rule, and asks the model for a compliant rewrite. Priority is fixed and not user reorderable: system safety, then workspace policy, then agent guardrails, then user instructions, then the customer's request. A customer cannot talk an agent past a rule above them.

Escalation triggers are evaluated against the inbound message. On a hit the conversation flips to human handling, the configured owner is assigned, and the handoff payload (transcript, summary, CRM record, reason, prior actions) is attached so the customer never repeats themselves.

### 10.5 Routing

Inbound work is matched to an agent by channel first, then intent, then type, restricted to `status = 'active'` agents whose `channels` include that channel. Voice always routes to a voice agent, social comments to a social agent. Workflow nodes store `agent_id`, never a name, so renaming is safe and a paused or archived reference surfaces as a warning on the workflow rather than a silent stall.

### 10.6 Lifecycle

`draft → active → paused → archived`. Activation is blocked until identity, role, at least one tool, at least one channel, at least one permission and an autonomy within the ceiling are all present. Duplicates always start paused. Archiving never deletes: `agent_activity`, conversations, calls and campaign rows keep pointing at the archived agent, and `agent_versions` records which configuration handled a historical conversation, which is what makes rollback safe.

---

## 11. Automation engine

### 11.1 Events in, runs out

Automations is not a builder with a canvas attached; it is an event consumer. Every integration and every internal mutation publishes a normalized event onto one bus, and the trigger matcher decides which published workflows care.

```
WhatsApp · Instagram · Email · MrAssistant · Shopify · Stripe · Forms · CRM · Appointments
        → normalize → events (append only) → trigger matcher → workflow_runs (queued)
        → execution worker → node_executions → side effects → audit
```

```json
{ "id": "evt_01H...", "type": "appointment.no_show", "workspace_id": "...",
  "contact_id": "...", "appointment_id": "...", "occurred_at": "2026-08-17T09:12:00Z" }
```

One event shape means adding a source never means writing new execution logic.

### 11.2 Schema

```sql
create table workflows (
  id uuid primary key, workspace_id uuid not null, name text not null,
  status text not null default 'draft',        -- draft | published | paused | archived
  current_version int not null default 1, created_by uuid, updated_at timestamptz
);
create table workflow_versions (
  id bigserial primary key, workflow_id uuid references workflows(id) on delete cascade,
  version int not null, graph jsonb not null,   -- nodes + edges, snapshot
  published_at timestamptz, published_by uuid,
  unique (workflow_id, version)
);
create table workflow_runs (
  id uuid primary key, workspace_id uuid not null,
  workflow_id uuid references workflows(id), version int not null,
  event_id text, idempotency_key text,
  status text not null,                         -- queued|running|waiting|awaiting_approval|completed|failed|cancelled|timed_out
  end_state text, current_node text, context jsonb not null default '{}',
  started_at timestamptz default now(), finished_at timestamptz, error text, is_test boolean default false,
  unique (workspace_id, workflow_id, idempotency_key)
);
create table node_executions (
  id bigserial primary key, run_id uuid references workflow_runs(id) on delete cascade,
  node_id text not null, node_type text not null, status text not null,
  branch text, note text, attempt int default 1, started_at timestamptz, finished_at timestamptz
);
create index on workflow_runs (workspace_id, workflow_id, started_at desc);
create index on node_executions (run_id);
```

Graphs are stored as versioned snapshots so a run always executes the version it started on, while nodes and edges remain queryable inside `graph` for validation and analytics.

### 11.3 Version safe execution

`workflow_runs.version` is fixed when the run is created. Publishing increments `current_version` and writes a new `workflow_versions` row; in flight runs keep executing their original snapshot, and only new events pick up the new version. Editing a published workflow moves it back to draft until republished, which is why an approval inserted by BUZZZ AI drops the workflow to draft rather than silently changing live behaviour.

### 11.4 Idempotency

`unique (workspace_id, workflow_id, idempotency_key)` where the key is derived from the event id. A Stripe `payment_failed` webhook delivered three times creates one run; the second and third insert conflict and are recorded as duplicates. Action nodes that send or charge additionally carry a per node idempotency token so a worker restart mid run cannot resend.

### 11.5 The executor

The engine is a pure reducer over the graph: load node, evaluate, persist the node execution, choose the outgoing edge by handle (`out`, `true`, `false`, `err`), repeat. That purity is what makes it testable, and the engine ships with unit tests covering branch selection with reasoning, unresolved variables failing rather than sending blanks, API failure routing down the error port, the loop guard, approval pause and resume, and dependency validation.

Guarantees enforced by the loop: a node cap per run, a per node loop counter, a wall clock timeout, retries only for transient failures, and no retry at all for send, call, charge or campaign actions without an idempotency token.

### 11.6 Node semantics

Agent nodes store `agent_id`, never a name, and invoke the agent through the same `canAgentDo` pipeline as everything else, so a workflow can never grant an agent a capability it does not have. A paused agent surfaces as a validation warning and stalls the run rather than silently substituting another agent. Action nodes map to real platform capabilities and refuse when the underlying integration is disconnected. API nodes reference a server side credential id; secrets are never written into the graph, and outbound URLs are checked against an allowlist to prevent SSRF. Wait nodes either sleep on the scheduler or park the run until a reply event arrives. Approval nodes park the run and create an Approval Center row carrying the `run_id`; approving resumes execution from `current_node` with `approved` in the context.

### 11.7 Background execution

Nothing long running happens inside an HTTP request. The API enqueues; workers consume. Wait nodes become scheduled jobs rather than held threads, so a workflow can sleep three days without holding a connection, and a worker crash resumes from the last persisted `node_executions` row rather than restarting the run.

### 11.8 Observability and safety

Every run stores its full step timeline with the branch taken and the reason a condition evaluated as it did, which is what the run detail view renders. Analytics are computed from `node_executions`, so failure hot spots and branch ratios are real measurements. Publishing requires the publish permission and shows an impact preview naming the actions the workflow can take, the channels it can use and how many contacts it could reach. Rate limits and business hours are applied at the action layer, shared with the campaign engine rather than reimplemented.

---

## 12. Knowledge and retrieval (RAG)

### 12.1 Why it is a separate layer

The CRM holds what we know about a customer; the knowledge base holds what the business knows. Mixing them is how agents end up quoting one customer's terms to another. Retrieval always joins the two at answer time rather than storing them together: "our refund window is 14 days" comes from knowledge, "your refund is processing" comes from the CRM.

### 12.2 Pipeline

```
source → fetch/upload → validate → parse → clean → chunk → embed → index → retrievable
```

Every stage is a persisted status, not a spinner: `queued, fetching, parsing, chunking, embedding, indexing, indexed, failed, stale`. A failed fetch stores the HTTP reason and stays failed; it is never silently marked indexed.

```sql
create table kb_sources (
  id uuid primary key, workspace_id uuid not null, name text not null, type text not null,
  collection text, priority int not null default 3,        -- 1 = official policy, 4 = internal note
  status text not null, error text, url text, refresh_cadence text,
  owner_id uuid, version int not null default 1,
  created_at timestamptz default now(), indexed_at timestamptz, archived boolean default false,
  content_hash text,                                        -- change detection, skip re-embedding
  unique (workspace_id, lower(name))
);
create table kb_versions (
  id bigserial primary key, source_id uuid references kb_sources(id) on delete cascade,
  version int not null, body text not null, published_at timestamptz, published_by uuid
);
create table kb_chunks (
  id uuid primary key, workspace_id uuid not null, source_id uuid references kb_sources(id) on delete cascade,
  version int not null, heading text, page int, ord int, body text not null,
  embedding vector(1536), tsv tsvector generated always as (to_tsvector('english', body)) stored
);
create index on kb_chunks using ivfflat (embedding vector_cosine_ops);
create index on kb_chunks using gin (tsv);
create table agent_knowledge ( agent_id uuid, source_id uuid, primary key (agent_id, source_id) );
create table kb_queries (
  id bigserial primary key, workspace_id uuid, agent_id uuid, question text,
  top_score real, answered boolean, source_ids uuid[], channel text, created_at timestamptz default now()
);
```

### 12.3 Chunking

Splitting every N characters destroys the thing that makes a citation useful. Chunks break on headings and paragraph boundaries, carry `heading`, `page` and `ord`, and stay under a word ceiling. That is why a citation can say "Refund policy · Eligibility · page 3" instead of "document 4, offset 1180".

### 12.4 Retrieval and scoping

```sql
select c.*, s.name, s.priority
from kb_chunks c join kb_sources s on s.id = c.source_id
where c.workspace_id = $1
  and s.archived = false and s.status = 'indexed'
  and s.id = any($2)                       -- the agent's granted sources, applied in the query
order by c.embedding <=> $3
limit 8;
```

The agent's grant list is a predicate inside the query, not a filter applied afterwards, so an unauthorized chunk never reaches the ranker or the model. Hybrid retrieval combines the vector distance with the `tsv` match, then a small authority boost from `priority` and a penalty for stale sources. The final prompt receives only the chunks that survive the relevance threshold, each carrying its citation metadata.

The embedder is behind one interface. The build in this artifact computes TF-IDF vectors locally so retrieval, scoping, ranking and citation are genuinely working and unit tested; swapping `embed()` for a server side neural embedding call changes nothing else in the pipeline.

### 12.5 Confidence and the no-invention rule

If the top score falls below the threshold the agent does not answer. It returns the configured fallback (clarify, decline, escalate, create a task), and the question is written to `kb_queries` with `answered = false`, which is what feeds gap analysis. Business facts are on a hard list that always requires evidence: pricing, refunds, delivery times, guarantees, legal terms, specifications, hours and contract terms.

### 12.6 Conflicts, freshness and change detection

Conflict detection scans indexed chunks for the same subject with different values (a 14 day and a 30 day refund window) and surfaces both sources with their authority, rather than silently picking one. Freshness is derived from `indexed_at` against the source's cadence. Scheduled refreshes fetch, compare `content_hash`, and only re-chunk and re-embed when the content actually changed, which is the difference between a cheap nightly refresh and an expensive one.

### 12.7 Deletion safety and audit

Archive is the default; the archive flag removes the source from every retrieval query while keeping chunks for audit. Deleting shows exactly which agents lose the capability first. Every source creation, version publish, rollback, grant, revoke, re-index and archive is written to the audit trail with who and when, so an answer given six months ago can be traced to the version that produced it.

---

## 13. Approval Center: the governance control plane

### 13.1 The rule

No action that requires a human may execute before the decision. The proposal is stored, the side effect is not performed, and approval is what triggers execution. Every action endpoint enforces this server side, so calling `POST /deals` directly with an agent token still routes through the policy check.

```
proposed action → governance check → authorized? ─ yes → execute
                                                └─ no  → approval request (nothing ran)
                                                          → approve      → execute once
                                                          → edit+approve → execute edited payload
                                                          → reject       → never executes
                                                          → expire       → configured fallback
```

### 13.2 Policy engine

Policies are rows, evaluated in order, first match wins, so a new rule is configuration rather than a deploy.

| Rule | Condition | Signs it off | Risk | SLA | Expires |
|---|---|---|---|---|---|
| Refunds and credits | amount > 1,000 | Finance Manager | Critical | 60m | 4h |
| Refunds and credits | amount > 100 | Manager | High | 120m | 8h |
| Campaigns | recipients > 1,000 | Admin | Critical | 60m | 4h |
| Campaigns | recipients ≥ 100 | Marketing Manager | High | 240m | 24h |
| Social publish | always | Marketing Manager | Medium | 240m | 24h |
| Outbound calls | always | Sales Manager | Medium | 60m | 4h |
| Delete CRM record | always | Admin | Critical | 120m | 24h |
| Everything else | always | Manager | Low | 240m | 24h |

Risk is computed from action metadata rather than assigned by hand: financial value and recipient count escalate it independently of the category, which is why a $4,200 credit is Critical while a routine reply is Low. Bulk approval is only offered when the matched policy allows it *and* the computed risk is below High.

### 13.3 Roles and delegation

`canDecide(userRole, requiredRole, delegations)` is the single authorization check. Owner and Admin can sign anything; a Sales Manager cannot sign a Finance approval. Delegations carry a scope and an expiry and are logged; an expired delegation is refused. Both are unit tested along with the SLA and threshold logic.

```sql
create table approvals (
  id uuid primary key, workspace_id uuid not null,
  agent_id uuid, requested_by text, action_key text not null, category text not null,
  contact_id uuid, conversation_id uuid, workflow_run_id uuid, node_id text,
  title text, body text, edited_body text, meta jsonb not null default '{}',
  risk text not null, required_role text not null, sla_minutes int, expiry_minutes int,
  status text not null default 'pending',      -- pending|in_review|approved|rejected|expired|cancelled|executing|executed|failed
  decided_by uuid, decided_at timestamptz, reject_reason text,
  exec_result text, executed_at timestamptz, idempotency_key text unique,
  created_at timestamptz default now()
);
create table approval_events (
  id bigserial primary key, approval_id uuid references approvals(id) on delete cascade,
  at timestamptz default now(), actor text, what text not null   -- immutable, append only
);
create index on approvals (workspace_id, status, created_at desc);
```

### 13.4 Execution and idempotency

The approval carries the payload, so approving executes exactly what was reviewed. A unique `idempotency_key` plus an executed set means a double click, a network retry or a worker restart produces one send, one deal, one call. Execution has its own outcome: `executing → executed` or `failed` with the provider reason, so an approved item whose WhatsApp send timed out is never displayed as delivered. Failed items can be retried without a second approval while the payload is unchanged.

Editing does not overwrite: the original proposal, the edited version, the editor and the timestamp are all retained, and the edited body is what runs.

### 13.5 Workflow approvals

A workflow approval node stores `workflow_run_id` and `node_id` on the approval and leaves the run parked. Approving resumes from that exact node with the run context intact rather than restarting; rejecting follows the node's rejection edge; expiry applies the node's timeout behaviour. This resume path is covered by the workflow engine tests.

### 13.6 SLA, expiry and escalation

`sla_minutes` drives the due indicator and the default queue ordering (overdue first, then risk, then imminent). `expiry_minutes` is enforced by a ticker: an expired approval can no longer execute, and if it belongs to a workflow the run is released down its rejection path rather than hanging forever. Escalation reassigns to the next role in the chain when the SLA passes.

### 13.7 Feedback loop

Rejections capture a structured reason, and the analytics view aggregates approval rate per agent. When an agent's requests are approved unchanged at a high rate over a meaningful sample, the system *suggests* raising that agent's autonomy so routine work stops queueing. It never raises autonomy automatically; that stays a human decision, which is the entire point of this layer.

---

## 14. Analytics and attribution

### 14.1 Principle

Every figure is derived from records the platform already owns. There is no metrics table populated by hand and no seeded number anywhere in the layer. When there is no data the API returns null and the interface says "no data" rather than showing a zero that reads like a measurement.

### 14.2 Events, not counters

Incrementing counters cannot be recomputed, corrected or sliced a new way later. Analytics reads an append only event stream plus the operational tables:

```sql
create table analytics_events (
  id bigserial primary key, workspace_id uuid not null,
  type text not null,                    -- contact.created, message.sent, appointment.completed, deal.won, run.failed…
  contact_id uuid, deal_id uuid, agent_id uuid, conversation_id uuid, campaign_id uuid,
  channel text, source text, value_cents bigint, meta jsonb,
  occurred_at timestamptz not null default now()
);
create index on analytics_events (workspace_id, type, occurred_at desc);
create index on analytics_events (workspace_id, contact_id, occurred_at);
```

Every metric is a query over this plus the live tables, so a new question is a new query rather than a new pipeline. Period comparison is the same query with a shifted window, which is why every headline can show its own previous period.

### 14.3 Attribution

Attribution needs the touch history, not just the current source, so each contact keeps its ordered touches:

```sql
create table touches (
  id bigserial primary key, workspace_id uuid, contact_id uuid not null,
  source text not null, channel text, campaign_id uuid, occurred_at timestamptz not null
);
```

Three models are computed from the same rows: first touch credits the source that captured the contact, last touch credits the final interaction before the win, and linear splits the deal value evenly across distinct touches. Showing all three side by side is deliberate, because a single model always flatters one channel.

### 14.4 The funnel

Stages are computed, not stored: captured from contacts, engaged from conversations or recent contact, qualified from lead status, booked and attended from appointments, won from deals. Each stage carries its conversion from the previous one and the absolute drop, and the weakest step is identified automatically. That single number, "which step leaks most", is the one most businesses cannot answer, so it gets named explicitly with the likely cause.

### 14.5 Unit economics

Cost is modelled from measurable volume against configurable rates: AI conversations, voice minutes, campaign sends, and human handling time at an hourly rate. Return compares attributed revenue against that cost, and the saving is the counterfactual of handling the same volume entirely with people. The rates live in workspace settings so the figures are the customer's own, not our assumptions.

### 14.6 Insight generation

Insights compare the current window against the previous one, keep movers above a threshold, then name the cause by decomposing the change: a fall in new contacts is attributed to the source that moved most, a no show rate is tied to reminder coverage, a funnel leak names the step before it. Risks come from live operational state (overdue approvals, failed workflow runs, unanswered knowledge questions, quiet contacts) and every insight links to the screen where it can be acted on. Where the platform can suggest a change, such as raising an agent's autonomy after a sustained high approval rate, it suggests only; nothing is applied automatically.

### 14.7 Performance

Dashboards must not scan raw events on every load. Rollup tables per workspace per day per dimension are refreshed incrementally, dashboards read rollups, and drill-through reads the underlying records only for the rows the user actually opens. Exports are generated from the same queries as the charts, so a CSV can never disagree with the screen it came from.

---

## 15. Activity ledger

### 15.1 One record for everything

Trust in an autonomous system is not built by a feed of sentences; it is built by a queryable record. Every module writes the same structured event, so "what did the AI do to this customer" is a filter rather than a scroll.

```sql
create table activity_events (
  id uuid primary key, workspace_id uuid not null,
  occurred_at timestamptz not null default now(),
  actor_type text not null,               -- agent | human | workflow | system
  actor_id uuid, actor_name text not null,
  mode text not null,                     -- autonomous | approved | human | system
  category text not null,                 -- message | crm | appointment | call | workflow | campaign | knowledge | approval | agent | social | system
  action text not null, detail text,
  outcome text not null,                  -- success | failed | blocked | queued | rejected | expired
  severity text not null default 'info',  -- info | notable | warning | critical
  entity_type text, entity_id uuid, entity_name text,
  conversation_id uuid, deal_id uuid, appointment_id uuid, run_id uuid, approval_id uuid,
  before_value text, after_value text, reason text,
  cost_cents int, duration_ms int
) partition by range (occurred_at);
create index on activity_events (workspace_id, occurred_at desc);
create index on activity_events (workspace_id, entity_id, occurred_at desc);
create index on activity_events (workspace_id, actor_id, occurred_at desc);
create index on activity_events (workspace_id, outcome) where outcome <> 'success';
```

Partitioning by month keeps the hot window small while retaining history; the failure index is partial because failures are rare and queried constantly.

### 15.2 Append only

Rows are never updated or deleted by application code. A correction is a new event referencing the original. This is what makes the ledger admissible as an audit record: the sequence cannot be rewritten after the fact, only extended. Retention is enforced by dropping whole partitions on a schedule, and export runs before a drop.

### 15.3 Mode is the important column

`mode` separates what the AI decided on its own from what a human approved from what a human did. That single distinction is what most compliance and internal trust conversations turn on, and it cannot be reconstructed later from free text, which is why it is written at the point of action by the governance pipeline rather than inferred.

### 15.4 Causal chains

Events carry the ids of the objects they touched, so the chain that produced an outcome is a query rather than a guess:

```sql
select * from activity_events
where workspace_id = $1 and entity_id = $2 and occurred_at <= $3
order by occurred_at desc limit 10;
```

That is how the detail panel answers "what led to this": the same customer, immediately before, in order. For workflow driven events the `run_id` links to `node_executions`, so a message can be traced back through the exact node and branch that produced it.

### 15.5 Writers

`log()` and `trail()` are the only writers, and both construct the same structured record: `log` for narrative actions, `trail` for field level before and after changes. Because every module already calls them, the ledger fills automatically without touching call sites, and classification (category, outcome, mode, severity, linked customer) is derived at write time and unit tested.

### 15.6 Reading at scale

Timeline queries are keyset paginated on `(occurred_at, id)` rather than offset paginated, so page fifty costs the same as page one. Aggregates for the insight view come from the same rollup approach used by analytics rather than scanning raw rows. Live tailing is a subscription on the newest partition, and it can be paused so an operator reading an incident is not fighting a moving list.

---

## 16. Integration platform

### 16.1 Registry, not hardcoded connectors

Every provider is a metadata row, so adding one is data rather than code: `auth` (oauth | apikey | internal), `caps` (messaging, sync, webhooks, actions), `objects`, `events`, `scopes`, `limits`. Any surface that needs to know what a connector can do reads the registry, which is what makes a marketplace possible later without rewriting the section.

```sql
create table connections (
  workspace_id uuid, provider_id text, on_flag boolean not null default false,
  account_label text, credential_ref text,          -- pointer into the secret store, never the secret
  connected_at timestamptz, expires_at timestamptz, last_sync timestamptz,
  direction text default 'two_way', conflict_rule text default 'newest',
  mapping jsonb, paused boolean default false, error text,
  primary key (workspace_id, provider_id)
);
create table sync_runs (
  id uuid primary key, workspace_id uuid, provider_id text, started_at timestamptz,
  created int, updated int, skipped int, failed int, conflicts jsonb, duration_ms int
);
```

Credentials live in a secret store; `credential_ref` is the only thing in the database and nothing is ever returned to the browser. Keys are shown masked and a newly created API key is displayed exactly once.

### 16.2 Health is more than a boolean

`connHealth` derives state from the connection: not connected, connected, syncing, paused, token expired, or error, with the reason attached. A token whose `expires_at` has passed is reported as expired rather than connected, and a sync connector with no successful run in three days is an error even though the credential is technically valid. Unit tested across all six states.

### 16.3 One source of truth, enforced everywhere

`isConnected(providerId)` is the only check in the platform, and six surfaces consume it: campaign channel selection, workflow node validation, the workflow executor at run time, agent capability evaluation, the marketing composer, and BUZZZ AI. Agent permissions are never deleted when a provider disconnects; the capability simply reports unavailable with the reason and returns on reconnect.

### 16.4 Sync

Sync applies the connection's field mapping in both directions, so an unmapped or disabled field is never read or written whatever the other system exposes. Compound fields (`first + last`) are supported. Conflicts are detected per field rather than per record and resolved by the configured rule, with manual resolution surfaced in the run history rather than silently overwritten. Every run records created, updated, skipped, failed and conflicts with per-record reasons.

### 16.5 Disconnect safety

Disconnect names the dependencies first: which agents hold the tool, which workflows contain an action node requiring it, and which live campaigns run on its channel. Nothing is deleted; the affected features report a stated reason instead of failing silently.

### 16.6 Developer surface

Workspace API keys carry explicit scopes rather than blanket access, are shown once, and can be revoked. Outgoing webhooks subscribe to named platform events, are HMAC signed, and track delivery failures. Every connect, disconnect, sync, config change and key operation writes to the same activity ledger as the rest of the platform.

---

## 16. Commercial layer: pricing, entitlements, usage and billing

### 16.1 What cannot be done client side

Checkout, webhooks, secret keys and entitlement enforcement are server responsibilities. The frontend build contains the pricing table, the entitlement gate and real usage metering so behaviour can be verified, but every rule below must also be enforced by the API, because a browser can be modified.

### 16.2 Pricing is data, versioned

Prices are commercially set per region, never FX converted, and the annual figure is stored explicitly rather than derived in a component.

```sql
create table pricing_versions (
  id bigserial primary key, region text not null, currency text not null, plan text not null,
  monthly_minor bigint not null, annual_minor bigint not null,
  ai_allowance int not null, entitlements jsonb not null,
  provider_product_id text, provider_monthly_price_id text, provider_annual_price_id text,
  effective_from timestamptz not null, effective_until timestamptz,
  created_by uuid, reason text
);
create unique index on pricing_versions (region, plan, effective_from);
```

A price change writes a new row rather than updating one, so existing subscribers can be held on the version they signed up under while new customers get the current one, and every change records who made it and why.

`GET /pricing?country=XX` resolves the region server side. The client never sends a price, a currency or a provider price id; it sends a plan and a cycle, and the server resolves the rest from the authenticated workspace's billing country. That is what makes frontend price manipulation impossible rather than merely inconvenient.

### 16.3 Entitlements

```sql
create table subscriptions (
  workspace_id uuid primary key, plan text not null, cycle text not null,
  status text not null,               -- trialing|active|past_due|unpaid|paused|canceled
  region text not null, currency text not null, pricing_version_id bigint references pricing_versions(id),
  current_period_end timestamptz, trial_ends_at timestamptz,
  provider_customer_id text, provider_subscription_id text
);
```

`checkEntitlement(key, currentCount)` runs before every create path: agents, workflows, campaigns, contacts and knowledge sources all call it, and it is unit tested. Subscription status feeds the same gate, so an unpaid workspace can read everything but create nothing, while `past_due` keeps a grace period. Downgrading never deletes data; it blocks new creation until the workspace is back under the new limit.

### 16.4 Usage is metered, not counted

Usage is derived from records that already exist: AI actions from the activity ledger where the actor is an agent or a workflow, voice minutes from call durations, message volume from campaign recipients and conversation messages. Nothing increments a counter that could drift from reality, and a query can always be re-run to explain a number.

```sql
create table usage_events (
  id bigserial primary key, workspace_id uuid not null, occurred_at timestamptz default now(),
  kind text not null,                  -- ai_action | voice_minute | wa_send | email_send | sms_send | storage
  quantity numeric not null, agent_id uuid, model text, tokens int, cost_micros bigint,
  idempotency_key text unique
);
create index on usage_events (workspace_id, kind, occurred_at desc);
```

Month end projection extrapolates from elapsed days, which is what lets an alert fire at 75% before the bill arrives rather than after. Hard caps stop billable operations at the allowance; soft caps route them through the Approval Center instead, so runaway cost is a policy decision rather than an accident.

### 16.5 Provider webhooks

Subscription state is owned by the billing provider and mirrored here through verified, idempotent webhooks. Every handler is keyed on the provider event id so a replay cannot double-credit an allowance, create a second subscription or duplicate an invoice. Handled events: checkout completed, subscription created, updated and deleted, invoice finalized, paid and payment failed. Card data never touches our servers; payment collection is hosted by the provider.

### 16.6 AI provider abstraction

Models are configuration, not code. A registry holds providers and models with their context window, tool support, reasoning capability and cost, and a router picks per task: fast and cheap for customer replies, reasoning capable for workflow generation and analytics investigation, long context for document analysis, with a fallback when the first choice is unavailable. Switching vendors, or moving to a self hosted open weight model, is a configuration change. Keys are held in the secret store, used server side only, and never returned to the browser.

### 16.7 Settings propagate

A setting that does not change behaviour is decoration. Workspace timezone and business hours feed appointment availability, campaign quiet hours and workflow waits. Currency drives deal values and analytics. The autonomy ceiling caps every agent at execution time. Escalation rules are read by the agent runtime. Notification rules route approvals, failures and usage alerts. Every one of these writes an audit event with before and after values, because settings changes are exactly the changes people need to reconstruct later.

---

## 17. Assistant and notifications

### 17.1 One brain, no second implementation

The assistant is an interface onto the same services everything else uses. When it sends a message it calls the agent action pipeline; when that pipeline refuses, it creates an Approval Center record. It has no private path to the database, no elevated permissions and no separate CRM logic. An AI request is an authenticated user request with a model attached, which is why "the AI did it" never means "the rules did not apply".

```
assistant UI → conversation API → orchestrator → context → permission → autonomy
             → tool registry → platform services → audit + usage + notification
```

### 17.2 Command risk

Every request is classified before anything runs: read, low, medium, high or destructive. Reads execute immediately. Medium and above render a preview card describing what would happen, and nothing executes until the person confirms. The classifier is unit tested across eleven phrasings, including "delete all my leads" as destructive and "call all 500 customers" as high.

### 17.3 Context

The assistant knows which screen is open and which contact, conversation or agent is selected, so "this customer" resolves to a record rather than a guess. Context narrows the query; it never widens permission. A user who cannot see a record cannot reach it by having it selected.

### 17.4 Voice

Speech in and out run through the browser's own speech APIs, with capability detection so an unsupported browser says so instead of showing a dead button. Transcription lands in the composer before sending, so a misheard command can be corrected rather than executed. Voice commands run the identical path as typed ones, including the preview step for consequential work, because a spoken instruction is not a stronger authorization than a typed one. For production, the speech provider sits behind the same kind of interface as the model router so it can be swapped for a server side engine.

### 17.5 Notifications are derived, not stored

A notification queue that is written separately from the state it describes drifts, and then the badge lies. Instead, notifications are computed from live records: pending and overdue approvals, unconfirmed appointments, failed workflow runs, missed calls, unhealthy integrations, usage crossing a threshold, subscription problems, stale knowledge, misconfigured agents and uncontacted leads. Read state is the only thing persisted.

```sql
create table notification_reads (
  workspace_id uuid, user_id uuid, notification_key text, read_at timestamptz default now(),
  primary key (workspace_id, user_id, notification_key)
);
```

Each item carries a category, a priority and a destination, so the badge count, the ordering and the deep link all come from the same record. In production the derivation runs server side on the same event stream that feeds analytics, and delivery is pushed over a socket rather than polled.

---

## 18. Home: the briefing layer

### 18.1 What Home is for

Home is not a smaller version of Analytics. Analytics answers "how is the business performing"; Home answers "what should I do in the next ten minutes". That distinction decides everything on the screen: if an item cannot be acted on, it does not belong here.

### 18.2 Everything is derived

There is no dashboard table and no cached summary blob. Four pure functions read the same records the rest of the platform writes:

- `buildBriefing` writes the morning narrative from contact volume with its week over week change, agent actions in the last day, closed revenue, and the two things most worth doing first.
- `buildPriorities` collects what needs a human and ranks it by consequence: overdue approvals, unconfirmed appointments, conversations waiting on a person, uncontacted leads and broken integrations rank high; missed calls, failed runs and usage warnings rank medium; misconfigured agents and stale knowledge rank low.
- `workDone` groups agent and workflow actions from the activity ledger, excluding anything a human did, so "BUZZZ is working" counts only autonomous work.
- `findOpportunities` looks for growth openings with records behind them: qualified leads gone quiet, deals stuck in negotiation, customers lapsed past sixty days, qualified leads with no appointment, and the campaign converting best.

All four are unit tested, including the empty case, where the screen returns a welcome and an offer to run setup rather than a grid of zeros.

### 18.3 API shape

In production these become one endpoint rather than four round trips, because the screen should not wait on the slowest widget:

```
GET /dashboard/briefing?range=7
→ { narrative, stats[], priorities[], work{}, opportunities[], generatedAt }
```

Each block is computed from the rollups described in the analytics section, cached briefly per workspace, and invalidated by the same events that drive notifications. Expensive blocks stream in after the cheap ones so the narrative and priorities paint immediately.

### 18.4 Every number is a door

Each stat, priority and opportunity carries the destination it belongs to, so the screen is a navigation layer rather than a report. Every priority also carries a question, which is what the Ask BUZZZ button sends to the assistant with that context attached. The user can act directly, or hand the item to the AI, without retyping what they are looking at.

---

## 19. Customer intelligence layer

### 19.1 Identity resolution

A person arriving on WhatsApp, by phone and through a form is one customer, and treating them as three ruins every metric downstream. Matching is weighted by signal strength: a normalized phone match is worth 0.55, an email match 0.45, an exact name only 0.2. Two thresholds govern the outcome: at 0.85 and above the record is matched automatically, between 0.5 and 0.85 it is *suggested* to a human, and below that a new record is created.

That middle band matters. Two people called Arun Kumar at the same company score 0.75 on name and company alone, which is suggestive but not proof, so the system refuses to merge and asks. Silent merges are unrecoverable; a suggestion costs a click.

```sql
create table identities (
  id uuid primary key, workspace_id uuid not null, contact_id uuid references contacts(id),
  kind text not null,                     -- phone | email | whatsapp | instagram | telegram | external
  value text not null, value_norm text not null, confidence real,
  verified_at timestamptz, source text,
  unique (workspace_id, kind, value_norm)
);
create index on identities (workspace_id, value_norm);
```

The unique constraint on the normalized value is what makes inbound resolution a lookup rather than a scan, and prevents the same handle attaching to two customers.

### 19.2 Customer memory

Memory is distinct from the knowledge base and from conversation history. The knowledge base holds what the business knows; memory holds what we know about *one person*: their preferences, objections, commitments, dates and interests.

```sql
create table customer_memory (
  id uuid primary key, workspace_id uuid not null, contact_id uuid not null references contacts(id),
  kind text not null, body text not null,
  source text not null,                   -- conversation | person | import
  created_by text not null,               -- agent name or user
  confidence real not null, superseded_by uuid,
  created_at timestamptz default now(), deleted_at timestamptz
);
```

Extraction is deliberately conservative: only specific, durable statements become memory, matched against defined patterns and capped at one fact per kind per message so a chatty customer cannot flood their own record. Everything carries provenance and a confidence figure, and everything is deletable, because a wrong fact about a customer is worse than no fact. Model output never becomes permanent memory without either a pattern match or human confirmation.

### 19.3 Scoring and health are derived

Lead score and customer health are computed on read from real signals, never stored as a stale integer. Score weighs reply volume, recency, appointments booked and attended, open opportunity value, real phone conversations and stated interest, against penalties for no-shows and pricing objections. Health weighs recency, open escalations, sentiment, no-shows, prior purchases and calls that needed a human.

Both return their factors, not just a number, so the interface can show *why* someone is a 74 rather than asking the user to trust it.

### 19.4 Next best action

One function turns those signals into a single recommendation with an urgency and a channel: reply personally when a conversation is escalated, call to check in when a paying customer's health drops, offer a time when a hot lead has nothing booked, chase the quotation when a deal has been sitting, answer the objection when one was recorded. Every recommendation states its evidence.

### 19.5 Communication orchestrator

One gate runs before any outbound touch, from an agent, a campaign or the assistant: opt-out, channel preference, address presence, quiet hours, weekly frequency cap, an open escalated issue, and the agent's own governance. It returns a code and a human-readable reason, so a blocked send explains itself rather than failing silently. The open-issue check is the one businesses usually miss: marketing someone while their complaint is unresolved does more damage than not messaging at all.

### 19.6 Agent handoff packages

When one agent hands to another, the receiving agent gets a structured package: the customer, the objective, the last three messages, the open deal, the next appointment, known facts from memory, what has already been done, and the recommended next step. The customer never repeats themselves, and the handoff is recorded as an event with both agent names.
