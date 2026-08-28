-- 0009: CRM Tasks data model
BEGIN;

CREATE TABLE IF NOT EXISTS tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        text NOT NULL,
  description  text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  priority     text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  due_date     timestamptz,
  assignee_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  contact_id   uuid REFERENCES contacts(id) ON DELETE SET NULL,
  company_id   uuid REFERENCES companies(id) ON DELETE SET NULL,
  deal_id      uuid REFERENCES deals(id) ON DELETE SET NULL,
  completed_at timestamptz,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_workspace_status_idx ON tasks (workspace_id, status, due_date);
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (workspace_id, assignee_id);
CREATE INDEX IF NOT EXISTS tasks_contact_idx ON tasks (workspace_id, contact_id);
CREATE INDEX IF NOT EXISTS tasks_deal_idx ON tasks (workspace_id, deal_id);

COMMIT;
