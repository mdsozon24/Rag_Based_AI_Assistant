-- 0003_tools: tenant-scoped actions and immutable per-call tool execution records.

CREATE TABLE tool (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 5000),
  type text NOT NULL CHECK (type IN ('function', 'endCall', 'transferCall', 'dtmf', 'query', 'handoff', 'mcp')),
  parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters) = 'object'),
  messages jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(messages) = 'object'),
  endpoint_url text,
  timeout_ms integer NOT NULL DEFAULT 20000 CHECK (timeout_ms BETWEEN 100 AND 120000),
  retries integer NOT NULL DEFAULT 0 CHECK (retries BETWEEN 0 AND 2),
  auth jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(auth) = 'object'),
  auth_encrypted jsonb CHECK (auth_encrypted IS NULL OR jsonb_typeof(auth_encrypted) = 'object'),
  static_parameters jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(static_parameters) = 'object'),
  variable_aliases jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(variable_aliases) = 'object'),
  sensitive_paths text[] NOT NULL DEFAULT '{}',
  rejection_rules jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(rejection_rules) = 'array'),
  created_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name),
  UNIQUE (id, org_id)
);
CREATE INDEX tool_org_idx ON tool (org_id, created_at DESC, id DESC);

CREATE TABLE call_tool_call (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES call (id) ON DELETE CASCADE,
  tool_id uuid REFERENCES tool (id) ON DELETE SET NULL,
  tool_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'failed', 'rejected', 'invalid-arguments', 'not-implemented')),
  args_encrypted jsonb,
  response_encrypted jsonb,
  error text,
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_tool_call_idx ON call_tool_call (org_id, call_id, created_at);

ALTER TABLE tool ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tool USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE call_tool_call ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON call_tool_call USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON tool TO octo_app;
GRANT SELECT, INSERT ON call_tool_call TO octo_app;