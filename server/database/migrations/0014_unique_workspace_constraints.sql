-- Migration 0014: Workspace-Scoped Unique Constraints for Edit Validation
-- Ensures email, phone_norm, workflow name, and campaign name are unique per workspace.

CREATE UNIQUE INDEX IF NOT EXISTS unique_contacts_workspace_email 
  ON contacts (workspace_id, lower(email)) 
  WHERE email IS NOT NULL AND archived = false;

CREATE UNIQUE INDEX IF NOT EXISTS unique_contacts_workspace_phone_norm 
  ON contacts (workspace_id, phone_norm) 
  WHERE phone_norm IS NOT NULL AND archived = false;

CREATE UNIQUE INDEX IF NOT EXISTS unique_workflows_workspace_name 
  ON workflows (workspace_id, lower(name)) 
  WHERE status != 'archived';

CREATE UNIQUE INDEX IF NOT EXISTS unique_campaigns_workspace_name 
  ON campaigns (workspace_id, lower(name));
