-- 0011: Tenant Isolation Indexes and Performance Views
BEGIN;

-- Ensure secondary indexes for multi-tenant query acceleration across high-volume tables
CREATE INDEX IF NOT EXISTS idx_messages_workspace_id ON messages (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workspace_status ON workflow_runs (workspace_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_workspace ON campaign_recipients (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_workspace ON kb_chunks (workspace_id);

COMMIT;
