-- 0012: Visual Workflow Engine Graph Schema Extensions

alter table workflows add column if not exists description text;
alter table workflows add column if not exists nodes jsonb not null default '[]'::jsonb;
alter table workflows add column if not exists edges jsonb not null default '[]'::jsonb;
alter table workflows add column if not exists variables jsonb not null default '[]'::jsonb;
alter table workflows add column if not exists settings jsonb not null default '{}'::jsonb;

alter table node_executions add column if not exists input jsonb;
alter table node_executions add column if not exists output jsonb;
