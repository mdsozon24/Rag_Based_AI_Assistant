-- 0002_assistants_calls: assistants with a mutable draft and immutable published versions, and
-- minimal web calls (single-use connect token, pinned config, end reason).
--
-- Integrity is enforced by the database, not only by the API:
-- - composite foreign keys keep every reference inside one org and one assistant (a version can
--   only be published on its own assistant; a call can only pin a version of its own assistant);
-- - octo_app may only SELECT and INSERT assistant_version rows, so versions are immutable;
-- - row-level security on every table, as in 0001.

CREATE TABLE assistant (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  -- Mutable working copy (the assistant spec as written); publishing snapshots it into a version
  draft jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(draft) = 'object'),
  draft_schema integer NOT NULL,
  -- What new calls run; null until the first publish. published_at: when it last changed
  published_version_id uuid,
  published_at timestamptz,
  template_id text,
  created_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Soft delete: calls and versions keep their references
  deleted_at timestamptz,
  UNIQUE (id, org_id)
);
CREATE INDEX assistant_org_idx ON assistant (org_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE assistant_version (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  assistant_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  config_schema integer NOT NULL,
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  note text CHECK (length(note) <= 500),
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'api_key', 'system')),
  created_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assistant_id, version),
  UNIQUE (assistant_id, id),
  FOREIGN KEY (assistant_id, org_id) REFERENCES assistant (id, org_id) ON DELETE CASCADE
);
CREATE INDEX assistant_version_list_idx ON assistant_version (assistant_id, created_at DESC, id DESC);

ALTER TABLE assistant
  ADD CONSTRAINT assistant_published_version_fk
  FOREIGN KEY (id, published_version_id) REFERENCES assistant_version (assistant_id, id);

CREATE TABLE call (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('web')),
  -- Dashboard "talk to assistant" calls
  test boolean NOT NULL DEFAULT false,
  -- Null for transient (inline) assistants
  assistant_id uuid,
  -- The pinned published version; null for drafts and transient assistants
  assistant_version_id uuid,
  config_source text NOT NULL CHECK (config_source IN ('published', 'version', 'draft', 'transient')),
  assistant_name text NOT NULL,
  -- The exact spec this call runs (overrides applied, variables not yet filled)
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  config_schema integer NOT NULL,
  -- Top-level fields the call overrode, for display and audit
  overridden_fields text[] NOT NULL DEFAULT '{}',
  variable_values jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(variable_values) = 'object'),
  status text NOT NULL CHECK (status IN ('queued', 'in-progress', 'ended')),
  end_reason text,
  -- Single-use connect token (SHA-256), and the browser origin it was issued to
  token_hash text UNIQUE,
  token_expires_at timestamptz,
  origin text,
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'api_key')),
  created_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  duration_ms integer,
  -- Provider usage per component (billing input, Phase 13)
  usage jsonb,
  CHECK ((config_source = 'transient') = (assistant_id IS NULL)),
  CHECK ((config_source IN ('published', 'version')) = (assistant_version_id IS NOT NULL)),
  FOREIGN KEY (assistant_id, org_id) REFERENCES assistant (id, org_id),
  FOREIGN KEY (assistant_id, assistant_version_id) REFERENCES assistant_version (assistant_id, id)
);
CREATE INDEX call_org_idx ON call (org_id, created_at DESC, id DESC);
CREATE INDEX call_assistant_idx ON call (assistant_id, created_at DESC);

-- ---------------------------------------------------------------- row-level security

ALTER TABLE assistant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assistant USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE assistant_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assistant_version USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE call ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON call USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

-- ---------------------------------------------------------------- grants for the tenant role

-- No DELETE on assistants: deletion is a soft delete (deleted_at)
GRANT SELECT, INSERT, UPDATE ON assistant TO octo_app;
-- Versions are immutable
GRANT SELECT, INSERT ON assistant_version TO octo_app;
GRANT SELECT, INSERT, UPDATE ON call TO octo_app;
