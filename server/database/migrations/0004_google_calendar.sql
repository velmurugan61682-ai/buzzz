-- 0004: Google Calendar and Meet support for virtual appointments.
-- Tokens are stored sealed; the encryption key lives in the API service only.

BEGIN;

CREATE TABLE google_connections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id               uuid REFERENCES users(id) ON DELETE SET NULL,
  email                 text,
  refresh_token_sealed  text NOT NULL,          -- aes-256-gcm, never plain text
  access_token          text,
  expires_at            timestamptz,
  scope                 text NOT NULL,
  needs_reconnect       boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id)
);

-- single use OAuth state, which is what prevents attaching a stranger's
-- Google account to someone else's workspace
CREATE TABLE google_oauth_states (
  state         text PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz
);
CREATE INDEX ON google_oauth_states (expires_at);

-- push notification channels, so edits made inside Google Calendar reach BUZZZ
CREATE TABLE google_watch_channels (
  channel_id    text PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_id   text NOT NULL,
  token         text NOT NULL,
  calendar_id   text NOT NULL DEFAULT 'primary',
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE appointments
  ADD COLUMN appointment_type text NOT NULL DEFAULT 'in_person'
    CHECK (appointment_type IN ('in_person','virtual','phone','other')),
  ADD COLUMN google_event_id  text,
  ADD COLUMN google_html_link text,
  ADD COLUMN meet_url         text,
  ADD COLUMN meet_id          text,
  ADD COLUMN time_zone        text NOT NULL DEFAULT 'UTC',
  ADD COLUMN meeting_state    text NOT NULL DEFAULT 'none'
    CHECK (meeting_state IN ('none','pending','ready','failed','cancelled')),
  ADD COLUMN meeting_error    text,
  ADD COLUMN synced_at        timestamptz;

-- one Google event per appointment: the database refuses duplicates even if a
-- retry slips past the application level idempotency check
CREATE UNIQUE INDEX appointments_google_event_uniq
  ON appointments (workspace_id, google_event_id)
  WHERE google_event_id IS NOT NULL;

-- a virtual appointment may not claim to be confirmed without a real Meet link
ALTER TABLE appointments ADD CONSTRAINT appointments_virtual_needs_meet
  CHECK (appointment_type <> 'virtual' OR status <> 'confirmed' OR meet_url IS NOT NULL);

CREATE TABLE appointment_reminders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  appointment_id  uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  offset_minutes  integer NOT NULL,
  channel         text NOT NULL,
  send_at         timestamptz NOT NULL,
  sent_at         timestamptz,
  status          text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','sent','failed','cancelled')),
  error           text
);
-- the same reminder can never be scheduled twice for one appointment
CREATE UNIQUE INDEX appointment_reminders_uniq
  ON appointment_reminders (appointment_id, offset_minutes, channel);
CREATE INDEX ON appointment_reminders (send_at) WHERE status = 'scheduled';

COMMIT;
