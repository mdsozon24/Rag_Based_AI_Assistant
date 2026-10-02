-- 0005_call_control: live call commands, timeline events and transcript rows.

CREATE TABLE call_event (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES call (id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_event_list_idx ON call_event (org_id, call_id, created_at, id);

CREATE TABLE call_transcript (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES call (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  text text NOT NULL,
  final boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_transcript_list_idx ON call_transcript (org_id, call_id, created_at, id);

ALTER TABLE call ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON call_event USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE call_transcript ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON call_transcript USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

GRANT SELECT, INSERT, UPDATE ON call TO octo_app;
GRANT SELECT, INSERT ON call_event TO octo_app;
GRANT SELECT, INSERT ON call_transcript TO octo_app;