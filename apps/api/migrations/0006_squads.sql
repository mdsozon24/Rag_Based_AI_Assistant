-- 0006_squads: ordered specialist assistants and per-call active-member history.

CREATE TABLE squad (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '',
  max_handoffs integer NOT NULL DEFAULT 4 CHECK (max_handoffs BETWEEN 1 AND 20),
  overrides jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(overrides) = 'object'),
  created_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name),
  UNIQUE (id, org_id)
);

CREATE TABLE squad_member (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  squad_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  assistant_id uuid,
  inline_config jsonb,
  member_overrides jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(member_overrides) = 'object'),
  context_mode text NOT NULL DEFAULT 'summary' CHECK (context_mode IN ('full', 'summary', 'variables')),
  context_schema jsonb CHECK (context_schema IS NULL OR jsonb_typeof(context_schema) = 'object'),
  handoff_targets jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(handoff_targets) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (squad_id, position),
  UNIQUE (id, org_id),
  CHECK ((assistant_id IS NULL) <> (inline_config IS NULL)),
  FOREIGN KEY (squad_id, org_id) REFERENCES squad (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (assistant_id, org_id) REFERENCES assistant (id, org_id) ON DELETE RESTRICT
);
CREATE INDEX squad_org_idx ON squad (org_id, created_at DESC, id DESC);
CREATE INDEX squad_member_list_idx ON squad_member (squad_id, position);

ALTER TABLE phone_number ADD CONSTRAINT phone_number_squad_fk FOREIGN KEY (squad_id, org_id) REFERENCES squad (id, org_id) ON DELETE SET NULL;
ALTER TABLE call ADD COLUMN squad_id uuid;
ALTER TABLE call ADD CONSTRAINT call_squad_fk FOREIGN KEY (squad_id, org_id) REFERENCES squad (id, org_id) ON DELETE SET NULL;

CREATE TABLE call_member_turn (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES call (id) ON DELETE CASCADE,
  squad_id uuid NOT NULL REFERENCES squad (id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES squad_member (id) ON DELETE RESTRICT,
  turn_number integer NOT NULL CHECK (turn_number >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  UNIQUE (call_id, turn_number)
);
CREATE INDEX call_member_turn_list_idx ON call_member_turn (org_id, call_id, turn_number);

ALTER TABLE squad ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON squad USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE squad_member ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON squad_member USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE call_member_turn ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON call_member_turn USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON squad TO octo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON squad_member TO octo_app;
GRANT SELECT, INSERT, UPDATE ON call_member_turn TO octo_app;