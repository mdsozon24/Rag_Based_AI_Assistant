-- 0008_chat: text conversations (chat API, OpenAI-compatible API, SMS), their messages, usage
-- records for billing, SMS opt-outs, the org's chat billing unit, and webhook deliveries for chats.

CREATE TABLE chat_session (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('api', 'web', 'openai', 'sms')),
  -- What answers: a saved assistant (pinned version) or a squad, or a transient config (private keys)
  assistant_id uuid,
  assistant_version_id uuid,
  squad_id uuid,
  config_source text NOT NULL CHECK (config_source IN ('published', 'version', 'transient', 'squad')),
  assistant_name text NOT NULL,
  -- The spec this session runs (overrides applied, variables not yet filled)
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  variable_values jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(variable_values) = 'object'),
  -- Squad position ({currentMemberId, handoffs, path}) and handoff context kept for later turns
  squad_state jsonb CHECK (squad_state IS NULL OR jsonb_typeof(squad_state) = 'object'),
  instructions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(instructions) = 'array'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  end_reason text,
  -- Browser origin a public-key session is bound to
  origin text,
  -- SMS: our number and the customer's number
  phone_number_id uuid,
  customer_number text CHECK (customer_number IS NULL OR customer_number ~ '^[+][1-9][0-9]{7,14}$'),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  message_count integer NOT NULL DEFAULT 0,
  usage jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(usage) = 'object'),
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'api_key', 'system')),
  created_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  UNIQUE (id, org_id),
  CHECK ((assistant_id IS NULL) OR (squad_id IS NULL)),
  FOREIGN KEY (assistant_id, org_id) REFERENCES assistant (id, org_id),
  FOREIGN KEY (squad_id, org_id) REFERENCES squad (id, org_id) ON DELETE SET NULL,
  FOREIGN KEY (phone_number_id, org_id) REFERENCES phone_number (id, org_id) ON DELETE SET NULL
);
CREATE INDEX chat_session_org_idx ON chat_session (org_id, created_at DESC, id DESC);
-- The active SMS conversation between one of our numbers and a customer
CREATE INDEX chat_session_sms_idx ON chat_session (org_id, phone_number_id, customer_number, status) WHERE channel = 'sms';

CREATE TABLE chat_message (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content text NOT NULL,
  tool_calls jsonb CHECK (tool_calls IS NULL OR jsonb_typeof(tool_calls) = 'array'),
  tool_call_id text,
  tool_name text,
  member_id text,
  -- Provider id of an inbound SMS, so a webhook retry is answered once
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq),
  FOREIGN KEY (session_id, org_id) REFERENCES chat_session (id, org_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX chat_message_provider_idx ON chat_message (org_id, provider_message_id) WHERE provider_message_id IS NOT NULL;

-- Billing input: one row per metered unit of work (chat turns now; calls in the billing phase)
CREATE TABLE usage_record (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('chat_session', 'call')),
  subject_id uuid NOT NULL,
  channel text NOT NULL,
  -- The org's billing unit when the row was written, and the billable quantity in that unit
  billing_unit text NOT NULL CHECK (billing_unit IN ('message', 'token')),
  quantity integer NOT NULL CHECK (quantity >= 0),
  messages integer NOT NULL DEFAULT 0 CHECK (messages >= 0),
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  tokens_estimated boolean NOT NULL DEFAULT false,
  provider text,
  model text,
  -- platform: our provider key paid; customer: the org's own key
  billing text NOT NULL CHECK (billing IN ('platform', 'customer')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_record_org_idx ON usage_record (org_id, created_at DESC);
CREATE INDEX usage_record_subject_idx ON usage_record (org_id, subject_type, subject_id);

-- Customers who texted STOP (org-wide: no SMS from any of the org's numbers until START)
CREATE TABLE sms_opt_out (
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  customer_number text NOT NULL CHECK (customer_number ~ '^[+][1-9][0-9]{7,14}$'),
  keyword text NOT NULL,
  phone_number_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, customer_number)
);

ALTER TABLE org ADD COLUMN chat_billing_unit text NOT NULL DEFAULT 'message' CHECK (chat_billing_unit IN ('message', 'token'));

ALTER TABLE webhook_delivery ADD COLUMN chat_session_id uuid REFERENCES chat_session (id) ON DELETE CASCADE;
CREATE UNIQUE INDEX webhook_delivery_chat_idx ON webhook_delivery (endpoint_id, chat_session_id, sequence, event_type) WHERE chat_session_id IS NOT NULL;

ALTER TABLE chat_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_session USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE chat_message ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_message USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE usage_record ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_record USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE sms_opt_out ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sms_opt_out USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

GRANT SELECT, INSERT, UPDATE ON chat_session TO octo_app;
GRANT SELECT, INSERT ON chat_message TO octo_app;
-- Usage rows are append-only for the app
GRANT SELECT, INSERT ON usage_record TO octo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sms_opt_out TO octo_app;
