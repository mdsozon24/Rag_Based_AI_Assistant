-- 0009_campaigns: outbound calling campaigns, their contacts, the per-attempt ledger, and the
-- org-level do-not-call list.
--
-- Integrity lives in the database, not only in the dialer:
-- - the unique (contact_id, attempt_no) index on live campaign_attempt rows: a contact attempt can exist
--   only once, so a restart, a second node or a duplicated tick cannot create a second dial for it;
-- - composite foreign keys keep every reference inside one org;
-- - row-level security on every table, as in 0001.

CREATE TABLE campaign (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'paused', 'completed', 'cancelled')),
  -- Why the platform (not a person) paused or finished it, e.g. no-active-phone-number
  status_reason text CHECK (length(status_reason) <= 200),
  assistant_id uuid,
  squad_id uuid,
  -- Calling schedule, in each CONTACT's time zone (see services/campaigns/schedule.ts)
  start_date date NOT NULL,
  end_date date NOT NULL,
  allowed_days integer[] NOT NULL CHECK (cardinality(allowed_days) BETWEEN 1 AND 7 AND allowed_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]),
  window_start text NOT NULL CHECK (window_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  window_end text NOT NULL CHECK (window_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- Used for contacts whose zone is neither in the CSV nor implied by their country code
  default_time_zone text NOT NULL CHECK (length(default_time_zone) BETWEEN 1 AND 64),
  -- Lets CSVs hold national numbers (BD: 01712345678)
  default_country char(2),
  max_concurrent_calls integer NOT NULL CHECK (max_concurrent_calls BETWEEN 1 AND 100),
  calls_per_minute integer NOT NULL CHECK (calls_per_minute BETWEEN 1 AND 600),
  -- Retries after no-answer, busy, voicemail (total attempts = 1 + max_retries)
  max_retries integer NOT NULL DEFAULT 2 CHECK (max_retries BETWEEN 0 AND 10),
  retry_delay_minutes integer NOT NULL DEFAULT 60 CHECK (retry_delay_minutes BETWEEN 1 AND 10080),
  -- Spoken before the assistant's first message when set ("This is an AI assistant calling on behalf of ...")
  disclosure_text text CHECK (length(disclosure_text) <= 500),
  -- Extra phrases (on top of the built-in list) that count as "do not call me again"
  opt_out_phrases text[] NOT NULL DEFAULT '{}' CHECK (cardinality(opt_out_phrases) <= 50),
  opt_out_message text CHECK (length(opt_out_message) <= 300),
  -- Labels the assistant may report with its reportOutcome tool; success_labels count as a success
  outcome_labels text[] NOT NULL DEFAULT '{}' CHECK (cardinality(outcome_labels) <= 30),
  success_labels text[] NOT NULL DEFAULT '{}' CHECK (success_labels <@ outcome_labels),
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'api_key', 'system')),
  created_by_id uuid,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  CHECK (end_date >= start_date),
  CHECK ((assistant_id IS NULL) <> (squad_id IS NULL)),
  FOREIGN KEY (assistant_id, org_id) REFERENCES assistant (id, org_id),
  FOREIGN KEY (squad_id, org_id) REFERENCES squad (id, org_id)
);
CREATE INDEX campaign_org_idx ON campaign (org_id, created_at DESC, id DESC);
CREATE INDEX campaign_running_idx ON campaign (status) WHERE status = 'running';

-- Numbers a campaign dials from (rotated)
CREATE TABLE campaign_phone_number (
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  phone_number_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (campaign_id, phone_number_id),
  FOREIGN KEY (campaign_id, org_id) REFERENCES campaign (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (phone_number_id, org_id) REFERENCES phone_number (id, org_id) ON DELETE CASCADE
);

CREATE TABLE campaign_contact (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  e164 text NOT NULL CHECK (e164 ~ '^[+][1-9][0-9]{7,14}$'),
  name text CHECK (length(name) <= 200),
  time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
  -- {{variable}} values for the assistant
  variables jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(variables) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'calling', 'completed', 'failed', 'do_not_call', 'cancelled', 'expired')),
  -- Attempts that were dialed (a released claim does not count)
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Not before this instant; null: as soon as the schedule allows
  next_attempt_at timestamptz,
  last_outcome text,
  -- From the assistant's reportOutcome tool (one of the campaign's outcome_labels)
  outcome_label text,
  outcome_notes text CHECK (length(outcome_notes) <= 1000),
  last_call_id uuid,
  -- Line in the uploaded CSV (the header is line 1)
  source_row integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (campaign_id, e164),
  FOREIGN KEY (campaign_id, org_id) REFERENCES campaign (id, org_id) ON DELETE CASCADE
);
CREATE INDEX campaign_contact_due_idx ON campaign_contact (campaign_id, next_attempt_at NULLS FIRST, id) WHERE status = 'pending';
CREATE INDEX campaign_contact_list_idx ON campaign_contact (campaign_id, created_at, id);
CREATE INDEX campaign_contact_number_idx ON campaign_contact (org_id, e164);

-- One row per dial attempt. Created (status claimed) in the same transaction that marks the contact
-- as calling; the row is the idempotency record for that attempt.
CREATE TABLE campaign_attempt (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  -- claimed: reserved, nothing dialed yet (safe to release); dialing: the provider request is being
  -- or was made; ringing / in-progress: provider events; done: final outcome recorded; skipped: released
  -- before dialing (not an attempt)
  status text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'dialing', 'ringing', 'in-progress', 'done', 'skipped')),
  outcome text CHECK (outcome IN ('answered', 'voicemail', 'no-answer', 'busy', 'failed', 'canceled', 'dial-error', 'unconfirmed', 'lost')),
  -- Allocated at claim time; the call row is created just before dialing
  call_id uuid NOT NULL,
  phone_number_id uuid,
  provider_call_id text,
  answered_by text,
  end_reason text,
  error text CHECK (length(error) <= 500),
  duration_seconds integer CHECK (duration_seconds >= 0),
  claimed_at timestamptz NOT NULL,
  dialed_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id),
  FOREIGN KEY (campaign_id, org_id) REFERENCES campaign (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id, org_id) REFERENCES campaign_contact (id, org_id) ON DELETE CASCADE,
  CHECK ((status = 'done') = (outcome IS NOT NULL) OR status = 'skipped')
);
-- The idempotency guard: a live attempt exists once per contact and number. A claim that was released
-- before dialing ("skipped") frees its number for the next claim.
CREATE UNIQUE INDEX campaign_attempt_once_idx ON campaign_attempt (contact_id, attempt_no) WHERE status <> 'skipped';
CREATE INDEX campaign_attempt_campaign_idx ON campaign_attempt (campaign_id, claimed_at DESC);
CREATE INDEX campaign_attempt_active_idx ON campaign_attempt (org_id, status) WHERE status IN ('claimed', 'dialing', 'ringing', 'in-progress');
CREATE INDEX campaign_attempt_provider_idx ON campaign_attempt (provider_call_id) WHERE provider_call_id IS NOT NULL;

-- Org-wide do-not-call list, checked before every campaign dial
CREATE TABLE do_not_call (
  -- Only for cursor pagination; the number is the key
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  e164 text NOT NULL CHECK (e164 ~ '^[+][1-9][0-9]{7,14}$'),
  -- manual: added through the API; opt-out: the person asked during a call
  source text NOT NULL CHECK (source IN ('manual', 'opt-out')),
  reason text CHECK (length(reason) <= 500),
  campaign_id uuid REFERENCES campaign (id) ON DELETE SET NULL,
  call_id uuid,
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'api_key', 'system')),
  created_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, e164)
);
CREATE INDEX do_not_call_list_idx ON do_not_call (org_id, created_at DESC, id DESC);

-- Calls made by a campaign point back to it
ALTER TABLE call ADD COLUMN campaign_id uuid;
ALTER TABLE call ADD COLUMN campaign_contact_id uuid;
ALTER TABLE call ADD CONSTRAINT call_campaign_fk FOREIGN KEY (campaign_id, org_id) REFERENCES campaign (id, org_id) ON DELETE SET NULL (campaign_id);
ALTER TABLE call ADD CONSTRAINT call_campaign_contact_fk FOREIGN KEY (campaign_contact_id, org_id) REFERENCES campaign_contact (id, org_id) ON DELETE SET NULL (campaign_contact_id);
CREATE INDEX call_campaign_idx ON call (campaign_id) WHERE campaign_id IS NOT NULL;

-- ---------------------------------------------------------------- row-level security

ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE campaign_phone_number ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_phone_number USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE campaign_contact ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_contact USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE campaign_attempt ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_attempt USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE do_not_call ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON do_not_call USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

-- ---------------------------------------------------------------- grants for the tenant role

-- DELETE only where the API deletes: draft campaigns (their rows cascade), campaign numbers while editing,
-- and do-not-call removals (audited). Contacts and attempts are never deleted by the app.
GRANT SELECT, INSERT, UPDATE, DELETE ON campaign TO octo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_phone_number TO octo_app;
GRANT SELECT, INSERT, UPDATE ON campaign_contact TO octo_app;
GRANT SELECT, INSERT, UPDATE ON campaign_attempt TO octo_app;
GRANT SELECT, INSERT, DELETE ON do_not_call TO octo_app;
