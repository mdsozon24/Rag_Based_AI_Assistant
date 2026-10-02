-- 0001_identity: orgs, users, memberships, sessions, email tokens, invitations, API keys,
-- audit log, idempotency keys, provider credentials.
--
-- Tenant isolation (DECISIONS D6): every tenant table has org_id and row-level security.
-- The API runs every tenant transaction as the non-owner role octo_app with app.org_id set, so
-- the policies always apply. Only the table owner bypasses them; the API uses the owner connection
-- solely for identity lookups that happen before an org is known (DECISIONS D37).
-- Migrations never change after they are applied (checked by checksum); add a new file instead.

DO $$ BEGIN
  CREATE ROLE octo_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE FUNCTION current_org_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

-- ---------------------------------------------------------------- global (not tenant-scoped)

CREATE TABLE org (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  -- Per-org override of the API rate limit (requests per minute); null = platform default
  rate_limit_per_minute integer CHECK (rate_limit_per_minute > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND position('@' IN email) > 1),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  password_hash text,
  google_sub text UNIQUE,
  email_verified_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  active_org_id uuid REFERENCES org (id) ON DELETE SET NULL,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX session_user_idx ON session (user_id);

CREATE TABLE email_token (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_token_user_idx ON email_token (user_id, purpose);

-- ---------------------------------------------------------------- tenant-scoped

CREATE TABLE membership (
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  invited_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX membership_user_idx ON membership (user_id);

CREATE TABLE invitation (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email)),
  role text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  token_hash text NOT NULL UNIQUE,
  invited_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitation_org_idx ON invitation (org_id, created_at DESC, id DESC);

CREATE TABLE api_key (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  type text NOT NULL CHECK (type IN ('private', 'public')),
  -- Display prefix, e.g. "sk_4fKx"; the key itself is only stored as a SHA-256 hash
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  allowed_origins text[] NOT NULL DEFAULT '{}',
  allowed_assistant_ids text[] NOT NULL DEFAULT '{}',
  rate_limit_per_minute integer CHECK (rate_limit_per_minute > 0),
  created_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  CHECK (type = 'public' OR (allowed_origins = '{}' AND allowed_assistant_ids = '{}'))
);
CREATE INDEX api_key_org_idx ON api_key (org_id, created_at DESC, id DESC);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  -- Null for user-level events with no org (sign-up, login, password reset)
  org_id uuid REFERENCES org (id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_idx ON audit_log (org_id, created_at DESC, id DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, created_at DESC);

CREATE TABLE idempotency_key (
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, key)
);

CREATE TABLE provider_credential (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  provider text NOT NULL,
  label text NOT NULL,
  masked text NOT NULL,
  encrypted jsonb NOT NULL,
  created_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX provider_credential_org_idx ON provider_credential (org_id, provider, created_at DESC);

-- ---------------------------------------------------------------- row-level security

ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON membership USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE invitation ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invitation USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE api_key ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_key USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE idempotency_key ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_key USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE provider_credential ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON provider_credential USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

-- The org row itself: a tenant transaction sees only its own org
ALTER TABLE org ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org USING (id = current_org_id()) WITH CHECK (id = current_org_id());

-- ---------------------------------------------------------------- grants for the tenant role

GRANT EXECUTE ON FUNCTION current_org_id() TO octo_app;
GRANT SELECT, UPDATE ON org TO octo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON membership, invitation, api_key, idempotency_key, provider_credential TO octo_app;
-- Append-only from the application's point of view
GRANT SELECT, INSERT ON audit_log TO octo_app;
-- Member listings show name and email only
GRANT SELECT (id, email, name, email_verified_at) ON app_user TO octo_app;
