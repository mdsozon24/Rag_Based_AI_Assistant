-- 0011_observability: per-call debug data, scorecards, and monitoring policies with their alerts.

-- ---------------------------------------------------------------- per-call debug data

-- Boards read turn latency from the timeline by org and time
CREATE INDEX call_event_type_idx ON call_event (org_id, type, created_at);

-- Full LLM prompts and replies, stored only for assistants with debug.captureLlm on, and deleted after
-- DEBUG_RETENTION_DAYS by the monitoring worker. The timeline event (call_event) always carries the
-- metadata (sizes, tokens, timings); this table holds the text.
CREATE TABLE call_debug_body (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES call (id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES call_event (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('llm-request', 'llm-response')),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_debug_body_call_idx ON call_debug_body (org_id, call_id, created_at);
CREATE INDEX call_debug_body_age_idx ON call_debug_body (created_at);

-- ---------------------------------------------------------------- scorecards

-- An org-defined metric computed from structured outputs and analysis results (spec is validated by the API)
CREATE TABLE scorecard (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  spec jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
  created_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX scorecard_name_idx ON scorecard (org_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX scorecard_org_idx ON scorecard (org_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- monitoring policies

CREATE TABLE alert_policy (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  enabled boolean NOT NULL DEFAULT true,
  metric text NOT NULL CHECK (metric IN ('success_rate', 'error_rate', 'latency_p50_ms', 'latency_p95_ms', 'latency_p99_ms', 'call_count', 'avg_duration_ms', 'scorecard')),
  scorecard_id uuid,
  comparison text NOT NULL CHECK (comparison IN ('lt', 'gt')),
  threshold numeric NOT NULL,
  -- The rule looks at calls created in the last window_minutes
  window_minutes integer NOT NULL CHECK (window_minutes BETWEEN 5 AND 10080),
  -- Fewer than this many data points (calls, or turns for latency) and the rule says nothing either way
  min_samples integer NOT NULL DEFAULT 5 CHECK (min_samples BETWEEN 0 AND 100000),
  assistant_id uuid,
  phone_number_id uuid,
  -- Email goes to these members; none listed means every owner and admin of the org
  notify_email boolean NOT NULL DEFAULT true,
  notify_user_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(notify_user_ids) <= 50),
  notify_webhook_endpoint_id uuid REFERENCES webhook_endpoint (id) ON DELETE SET NULL,
  -- While still breaching, remind this often (0: never remind)
  renotify_minutes integer NOT NULL DEFAULT 360 CHECK (renotify_minutes BETWEEN 0 AND 10080),
  -- State of the last conclusive evaluation: unknown (never had enough data), ok, or firing
  state text NOT NULL DEFAULT 'unknown' CHECK (state IN ('unknown', 'ok', 'firing')),
  state_since timestamptz,
  last_value numeric,
  last_sample integer,
  last_evaluated_at timestamptz,
  last_notified_at timestamptz,
  created_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  CHECK ((metric = 'scorecard') = (scorecard_id IS NOT NULL)),
  FOREIGN KEY (scorecard_id, org_id) REFERENCES scorecard (id, org_id),
  FOREIGN KEY (assistant_id, org_id) REFERENCES assistant (id, org_id),
  FOREIGN KEY (phone_number_id, org_id) REFERENCES phone_number (id, org_id)
);
CREATE INDEX alert_policy_org_idx ON alert_policy (org_id, created_at DESC, id DESC);
CREATE INDEX alert_policy_due_idx ON alert_policy (last_evaluated_at NULLS FIRST) WHERE enabled;

-- Every change of state worth telling someone about (the history, and the idempotency key for notifications)
CREATE TABLE alert_event (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  policy_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('fired', 'reminder', 'resolved')),
  value numeric NOT NULL,
  sample integer NOT NULL,
  -- The rule as it was when this happened (the policy may be edited later)
  metric text NOT NULL,
  comparison text NOT NULL,
  threshold numeric NOT NULL,
  window_minutes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  FOREIGN KEY (policy_id, org_id) REFERENCES alert_policy (id, org_id) ON DELETE CASCADE
);
CREATE INDEX alert_event_policy_idx ON alert_event (org_id, policy_id, created_at DESC);
CREATE INDEX alert_event_org_idx ON alert_event (org_id, created_at DESC, id DESC);

-- Outbox: one row per recipient and channel, sent by the monitoring worker with retries
CREATE TABLE alert_notification (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'webhook')),
  -- An email address (a member of the org) or a webhook endpoint id
  target text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK (length(last_error) <= 500),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, channel, target),
  FOREIGN KEY (event_id, org_id) REFERENCES alert_event (id, org_id) ON DELETE CASCADE
);
CREATE INDEX alert_notification_queue_idx ON alert_notification (status, next_attempt_at) WHERE status IN ('pending', 'sending', 'failed');
CREATE INDEX alert_notification_org_idx ON alert_notification (org_id, created_at DESC);

-- ---------------------------------------------------------------- row-level security and grants

ALTER TABLE call_debug_body ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON call_debug_body USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE scorecard ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scorecard USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE alert_policy ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON alert_policy USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE alert_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON alert_event USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE alert_notification ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON alert_notification USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

-- Debug bodies are append-only for the app; the owner connection prunes them by age
GRANT SELECT, INSERT ON call_debug_body TO octo_app;
GRANT SELECT, INSERT, UPDATE ON scorecard TO octo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON alert_policy TO octo_app;
GRANT SELECT, INSERT ON alert_event TO octo_app;
GRANT SELECT, INSERT, UPDATE ON alert_notification TO octo_app;
