-- 0004_telephony: provider-neutral phone numbers and telephony call metadata.

CREATE TABLE phone_number (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('twilio', 'telnyx', 'vonage', 'sip')),
  provider_number_id text NOT NULL,
  e164 text NOT NULL CHECK (e164 ~ '^[+][1-9][0-9]{7,14}$'),
  country char(2) NOT NULL,
  capabilities text[] NOT NULL DEFAULT '{}',
  assistant_id uuid,
  squad_id uuid,
  fallback_destination text,
  credential_id uuid,
  routing_url text,
  routing_timeout_ms integer NOT NULL DEFAULT 1500 CHECK (routing_timeout_ms BETWEEN 100 AND 10000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, e164),
  UNIQUE (provider, provider_number_id),
  UNIQUE (id, org_id),
  CHECK ((assistant_id IS NULL) OR (squad_id IS NULL)),
  CHECK (fallback_destination IS NULL OR fallback_destination ~ '^[+][1-9][0-9]{7,14}$')
);
CREATE INDEX phone_number_org_idx ON phone_number (org_id, created_at DESC, id DESC);
CREATE INDEX phone_number_lookup_idx ON phone_number (e164, status);

ALTER TABLE phone_number ADD CONSTRAINT phone_number_assistant_fk FOREIGN KEY (assistant_id, org_id) REFERENCES assistant (id, org_id) ON DELETE SET NULL;

ALTER TABLE call DROP CONSTRAINT call_type_check;
ALTER TABLE call ADD CONSTRAINT call_type_check CHECK (type IN ('web', 'inbound', 'outbound', 'sip'));
ALTER TABLE call DROP CONSTRAINT call_status_check;
ALTER TABLE call ADD CONSTRAINT call_status_check CHECK (status IN ('queued', 'ringing', 'in-progress', 'ended', 'failed'));
ALTER TABLE call DROP CONSTRAINT call_created_by_type_check;
ALTER TABLE call ADD CONSTRAINT call_created_by_type_check CHECK (created_by_type IN ('user', 'api_key', 'system'));
ALTER TABLE call ADD COLUMN direction text NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound', 'web'));
ALTER TABLE call ADD COLUMN phone_number_id uuid;
ALTER TABLE call ADD COLUMN provider_call_id text;
ALTER TABLE call ADD COLUMN customer_number text CHECK (customer_number IS NULL OR customer_number ~ '^[+][1-9][0-9]{7,14}$');
ALTER TABLE call ADD COLUMN voicemail_detected boolean NOT NULL DEFAULT false;
ALTER TABLE call ADD CONSTRAINT call_phone_number_fk FOREIGN KEY (phone_number_id, org_id) REFERENCES phone_number (id, org_id) ON DELETE SET NULL;
CREATE INDEX call_provider_idx ON call (provider_call_id);
CREATE INDEX call_active_org_idx ON call (org_id, status) WHERE status IN ('queued', 'ringing', 'in-progress');

ALTER TABLE phone_number ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON phone_number USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON phone_number TO octo_app;