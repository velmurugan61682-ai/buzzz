-- 0006: second factors, passkeys and linked social accounts.

BEGIN;

ALTER TABLE users
  ADD COLUMN totp_secret        text,          -- base32, only set once enrolled
  ADD COLUMN totp_enabled       boolean NOT NULL DEFAULT false,
  ADD COLUMN totp_last_counter  bigint,        -- stops a code being replayed
  ADD COLUMN mfa_enrolled_at    timestamptz;

-- recovery codes are stored hashed and deleted as they are used
CREATE TABLE mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);
CREATE INDEX ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;

-- one row per registered device
CREATE TABLE passkeys (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  text NOT NULL UNIQUE,
  public_key     bytea NOT NULL,
  -- a counter that fails to increase means the credential may be cloned
  sign_count     bigint NOT NULL DEFAULT 0,
  transports     text[],
  device_label   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);
CREATE INDEX ON passkeys (user_id);

-- short lived, single use, and tied to the ceremony that issued them
CREATE TABLE webauthn_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  challenge   text NOT NULL UNIQUE,
  kind        text NOT NULL CHECK (kind IN ('register','authenticate')),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX ON webauthn_challenges (expires_at);

-- a social account linked to a BUZZZ user. The unique constraint is what stops
-- two people claiming the same Google account.
CREATE TABLE oauth_identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('google','apple')),
  provider_uid  text NOT NULL,
  email         text,
  -- whether the provider says the address is verified; an unverified address
  -- must never be trusted to match an existing account
  email_verified boolean NOT NULL DEFAULT false,
  linked_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_uid)
);
CREATE INDEX ON oauth_identities (user_id);

-- single use state for the OAuth round trip, which is what stops CSRF on login
CREATE TABLE oauth_states (
  state       text PRIMARY KEY,
  provider    text NOT NULL,
  redirect_to text,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);

-- staff are held to a higher bar than customers
ALTER TABLE staff_users
  ADD COLUMN totp_secret     text,
  ADD COLUMN totp_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN mfa_required    boolean NOT NULL DEFAULT true;

ALTER TABLE staff_sessions
  ADD COLUMN mfa_verified_at timestamptz;

COMMIT;
