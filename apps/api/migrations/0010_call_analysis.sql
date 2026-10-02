-- 0010_call_analysis: turn-by-turn transcripts with timing, tool calls and full-text search;
-- reusable structured-output definitions; and the post-call analysis job with its results.

-- ---------------------------------------------------------------- transcript

-- One ordered list per call: what was said (speech) with when, and the tool calls between the lines.
ALTER TABLE call_transcript ADD COLUMN seq integer;
ALTER TABLE call_transcript ADD COLUMN kind text NOT NULL DEFAULT 'speech' CHECK (kind IN ('speech', 'tool-call'));
ALTER TABLE call_transcript ADD COLUMN started_at timestamptz;
ALTER TABLE call_transcript ADD COLUMN ended_at timestamptz;
-- The agent line was cut short by the caller; text is what the caller heard
ALTER TABLE call_transcript ADD COLUMN interrupted boolean NOT NULL DEFAULT false;
ALTER TABLE call_transcript ADD COLUMN tool_name text;
ALTER TABLE call_transcript ADD COLUMN tool_args jsonb CHECK (tool_args IS NULL OR jsonb_typeof(tool_args) = 'object');
-- Filled when the tool ran through the tool executor; null for requests that never produced a result row
ALTER TABLE call_transcript ADD COLUMN tool_result jsonb;
ALTER TABLE call_transcript ADD COLUMN tool_status text;

-- Rows written before this migration keep their order and use their write time as both times
UPDATE call_transcript t SET seq = n.rn, started_at = t.created_at, ended_at = t.created_at
FROM (SELECT id, row_number() OVER (PARTITION BY call_id ORDER BY created_at, id) AS rn FROM call_transcript) n
WHERE t.id = n.id;

ALTER TABLE call_transcript ALTER COLUMN seq SET NOT NULL;
ALTER TABLE call_transcript ALTER COLUMN started_at SET NOT NULL;
ALTER TABLE call_transcript ALTER COLUMN ended_at SET NOT NULL;
ALTER TABLE call_transcript ADD CONSTRAINT call_transcript_seq_key UNIQUE (call_id, seq);
ALTER TABLE call_transcript ADD CONSTRAINT call_transcript_time_check CHECK (ended_at >= started_at);
ALTER TABLE call_transcript ADD CONSTRAINT call_transcript_tool_check CHECK ((kind = 'tool-call') = (tool_name IS NOT NULL));

-- Search is per org: every query filters org_id, and the index narrows by words ('simple': no stemming, works for Bangla)
ALTER TABLE call_transcript ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, text || ' ' || coalesce(tool_name, ''))) STORED;
CREATE INDEX call_transcript_search_idx ON call_transcript USING gin (search);

-- ---------------------------------------------------------------- structured outputs

CREATE TABLE structured_output (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  -- A JSON Schema object the extracted values must satisfy (validated when saved and after every extraction)
  schema jsonb NOT NULL CHECK (jsonb_typeof(schema) = 'object' AND schema ->> 'type' = 'object'),
  -- Extra instructions to the model for this output (optional)
  prompt text CHECK (length(prompt) <= 5000),
  created_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Soft delete: finished calls keep a snapshot of the schema they were analysed with
  deleted_at timestamptz,
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX structured_output_name_idx ON structured_output (org_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX structured_output_org_idx ON structured_output (org_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- analysis job and results

-- One row per call. It is the job (status, attempts, next_attempt_at, lease) and the result.
CREATE TABLE call_analysis (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org (id) ON DELETE CASCADE,
  call_id uuid NOT NULL UNIQUE REFERENCES call (id) ON DELETE CASCADE,
  -- pending: waiting (or waiting to retry); running: leased by a worker; succeeded: every enabled step ended
  -- (an output whose values never validated is recorded as failed inside `outputs`); failed: retries ran out;
  -- skipped: nothing to analyse (see skip_reason)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  skip_reason text CHECK (skip_reason IN ('analysis-disabled', 'no-transcript')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text CHECK (length(last_error) <= 1000),
  summary text,
  success_rubric text CHECK (success_rubric IN ('pass-fail', 'numeric-scale', 'descriptive', 'categories')),
  success_passed boolean,
  success_score integer CHECK (success_score BETWEEN 1 AND 10),
  success_category text,
  success_reason text,
  -- {summary: {status, error?}, success: {status, error?}}; status: succeeded | failed
  steps jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(steps) = 'object'),
  -- By structured output id ("inline" for the assistant's own schema):
  -- {name, status: succeeded | failed | skipped, values?, error?, schema (snapshot)}
  outputs jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(outputs) = 'object'),
  -- Analysis LLM usage over every attempt: {inputTokens, outputTokens, requests}
  usage jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(usage) = 'object'),
  analysed_at timestamptz,
  -- The end-of-call-report webhook is queued once, when the job reaches a final state
  report_enqueued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_analysis_queue_idx ON call_analysis (status, next_attempt_at) WHERE status IN ('pending', 'running');
CREATE INDEX call_analysis_org_idx ON call_analysis (org_id, created_at DESC);

-- ---------------------------------------------------------------- row-level security and grants

ALTER TABLE structured_output ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON structured_output USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE call_analysis ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON call_analysis USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

GRANT SELECT, INSERT, UPDATE ON structured_output TO octo_app;
GRANT SELECT, INSERT, UPDATE ON call_analysis TO octo_app;
