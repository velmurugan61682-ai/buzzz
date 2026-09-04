-- Migration 0015: WhatsApp Production Hardening & Unique Constraints
-- Adds 24-hour customer window tracking, account identity scoping, pre-index cleanup, and unique constraints.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_customer_message_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS account_external_id text;

-- 1. Pre-index cleanup: Deduplicate pre-existing open conversations per account identity, keeping most recently updated
DELETE FROM conversations c1
WHERE state != 'resolved'
  AND EXISTS (
    SELECT 1 FROM conversations c2
    WHERE c2.workspace_id = c1.workspace_id
      AND c2.contact_id = c1.contact_id
      AND c2.channel = c1.channel
      AND COALESCE(c2.account_external_id, '') = COALESCE(c1.account_external_id, '')
      AND c2.state != 'resolved'
      AND (c2.last_message_at > c1.last_message_at OR (c2.last_message_at = c1.last_message_at AND c2.id > c1.id))
  );

-- 2. Pre-index cleanup: Deduplicate pre-existing provider messages, keeping earliest created record
DELETE FROM messages m1
WHERE provider_message_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM messages m2
    WHERE m2.workspace_id = m1.workspace_id
      AND m2.provider_message_id = m1.provider_message_id
      AND (m2.created_at < m1.created_at OR (m2.created_at = m1.created_at AND m2.id < m1.id))
  );

-- 3. Unique Index: Prevent duplicate open conversation threads per tenant + contact + channel + account
CREATE UNIQUE INDEX IF NOT EXISTS unique_open_conversations_per_channel_account 
  ON conversations (workspace_id, contact_id, channel, COALESCE(account_external_id, '')) 
  WHERE contact_id IS NOT NULL AND state != 'resolved';

-- 4. Unique Index: Prevent duplicate messages per tenant + provider_message_id
CREATE UNIQUE INDEX IF NOT EXISTS unique_messages_workspace_provider_id 
  ON messages (workspace_id, provider_message_id) 
  WHERE provider_message_id IS NOT NULL;

-- 5. Unique Index: Webhook Deliveries Idempotency per provider + event_id
CREATE UNIQUE INDEX IF NOT EXISTS unique_webhook_deliveries_provider_event 
  ON webhook_deliveries (provider, event_id);
