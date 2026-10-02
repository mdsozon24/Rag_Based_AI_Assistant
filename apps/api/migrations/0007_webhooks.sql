-- 0007_webhooks: scoped customer event endpoints and durable delivery attempts.

CREATE TABLE webhook_endpoint (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('org', 'phone', 'assistant', 'call')),
  scope_id uuid,
  url text NOT NULL CHECK (url ~ '^https://'),
  headers jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(headers) = 'object'),
  secret_encrypted jsonb NOT NULL CHECK (jsonb_typeof(secret_encrypted) = 'object'),
  events text[] NOT NULL DEFAULT '{}',
  transcript_opt_in boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, scope_type, scope_id)
);
CREATE INDEX webhook_endpoint_scope_idx ON webhook_endpoint (org_id, scope_type, scope_id);

CREATE TABLE webhook_delivery (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoint (id) ON DELETE CASCADE,
  call_id uuid REFERENCES call (id) ON DELETE CASCADE,
  sequence integer NOT NULL DEFAULT 0,
  event_type text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'succeeded', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_status integer,
  response_body text,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, call_id, sequence, event_type)
);
CREATE INDEX webhook_delivery_list_idx ON webhook_delivery (org_id, created_at DESC, id DESC);
CREATE INDEX webhook_delivery_queue_idx ON webhook_delivery (status, next_attempt_at);

ALTER TABLE webhook_endpoint ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_endpoint USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE webhook_delivery ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_delivery USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_endpoint TO octo_app;
GRANT SELECT, INSERT, UPDATE ON webhook_delivery TO octo_app;