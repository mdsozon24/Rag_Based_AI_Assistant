/**
 * What a campaign achieved: per-contact status and outcome, dashboard statistics, and the CSV export.
 *
 * Definitions (also in API.md):
 * - dialled: contacts with at least one provider dial; attempts: dials made (a retry is another attempt);
 * - answered / voicemail: contacts that, at least once, were answered by a person / by a machine;
 * - completed: contacts whose conversation finished (never retried);
 * - successRate: contacts reported with one of the campaign's success labels, over contacts answered
 *   (null without success labels or answers);
 * - usage: call time and provider units (no money: price tables arrive with billing).
 */
import type { Queryable } from '../../db/database.ts';
import { iso } from '../../http/validation.ts';
import { csvCell } from './contacts.ts';

export interface ContactRowFull {
  id: string;
  cursor_ts: string;
  e164: string;
  name: string | null;
  time_zone: string;
  variables: Record<string, string>;
  status: string;
  attempts: number;
  next_attempt_at: Date | null;
  last_outcome: string | null;
  outcome_label: string | null;
  outcome_notes: string | null;
  last_call_id: string | null;
  created_at: Date;
}

export const CONTACT_COLUMNS = `id, created_at::text AS cursor_ts, e164, name, time_zone, variables, status, attempts, next_attempt_at, last_outcome, outcome_label,
  outcome_notes, last_call_id, created_at`;

export const contactView = (row: ContactRowFull) => ({
  id: row.id,
  number: row.e164,
  name: row.name,
  timeZone: row.time_zone,
  variables: row.variables,
  status: row.status,
  outcome: row.last_outcome,
  outcomeLabel: row.outcome_label,
  outcomeNotes: row.outcome_notes,
  attempts: row.attempts,
  nextAttemptAt: iso(row.next_attempt_at),
  lastCallId: row.last_call_id,
  createdAt: iso(row.created_at),
});

const CONTACT_STATUSES = ['pending', 'calling', 'completed', 'failed', 'do_not_call', 'cancelled', 'expired'] as const;

const ratio = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null);

export async function campaignStats(tx: Queryable, orgId: string, campaignId: string, successLabels: string[], status: string) {
  const byStatus = (await tx.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM campaign_contact WHERE org_id = $1 AND campaign_id = $2 GROUP BY status', [orgId, campaignId])).rows;
  const contacts: Record<string, number> = Object.fromEntries(CONTACT_STATUSES.map((s) => [s, 0]));
  for (const row of byStatus) contacts[row.status] = row.n;
  const total = byStatus.reduce((sum, row) => sum + row.n, 0);

  const a = (
    await tx.query<{ attempts: number; dialled: number; answered: number; voicemail: number; call_seconds: number }>(
      `SELECT count(*) FILTER (WHERE dialed_at IS NOT NULL)::int AS attempts,
              count(DISTINCT contact_id) FILTER (WHERE dialed_at IS NOT NULL)::int AS dialled,
              count(DISTINCT contact_id) FILTER (WHERE outcome = 'answered')::int AS answered,
              count(DISTINCT contact_id) FILTER (WHERE outcome = 'voicemail')::int AS voicemail,
              coalesce(sum(duration_seconds), 0)::int AS call_seconds
       FROM campaign_attempt WHERE org_id = $1 AND campaign_id = $2`,
      [orgId, campaignId]
    )
  ).rows[0];

  const labels = (
    await tx.query<{ outcome_label: string; n: number }>('SELECT outcome_label, count(*)::int AS n FROM campaign_contact WHERE org_id = $1 AND campaign_id = $2 AND outcome_label IS NOT NULL GROUP BY outcome_label ORDER BY outcome_label', [orgId, campaignId])
  ).rows;
  const succeeded = labels.filter((l) => successLabels.includes(l.outcome_label)).reduce((sum, l) => sum + l.n, 0);

  const usage = (
    await tx.query<{ stt: string; input: string; output: string; chars: string }>(
      `SELECT coalesce(sum((u -> 'units' ->> 'audioSeconds')::numeric), 0)::text AS stt,
              coalesce(sum((u -> 'units' ->> 'inputTokens')::numeric), 0)::text AS input,
              coalesce(sum((u -> 'units' ->> 'outputTokens')::numeric), 0)::text AS output,
              coalesce(sum((u -> 'units' ->> 'characters')::numeric), 0)::text AS chars
       FROM call c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.usage) = 'array' THEN c.usage ELSE '[]'::jsonb END) u
       WHERE c.org_id = $1 AND c.campaign_id = $2`,
      [orgId, campaignId]
    )
  ).rows[0];

  return {
    campaignId,
    status,
    contacts: { total, pending: contacts.pending, calling: contacts.calling, completed: contacts.completed, failed: contacts.failed, doNotCall: contacts.do_not_call, cancelled: contacts.cancelled, expired: contacts.expired },
    dialled: a.dialled,
    attempts: a.attempts,
    answered: a.answered,
    voicemail: a.voicemail,
    completed: contacts.completed,
    answerRate: ratio(a.answered, a.dialled),
    completionRate: ratio(contacts.completed, a.dialled),
    successRate: successLabels.length ? ratio(succeeded, a.answered) : null,
    outcomes: Object.fromEntries(labels.map((l) => [l.outcome_label, l.n])),
    usage: {
      callSeconds: a.call_seconds,
      callMinutes: Math.round((a.call_seconds / 60) * 100) / 100,
      sttAudioSeconds: Number(usage.stt),
      llmInputTokens: Number(usage.input),
      llmOutputTokens: Number(usage.output),
      ttsCharacters: Number(usage.chars),
    },
  };
}

interface ExportRow {
  e164: string;
  name: string | null;
  time_zone: string;
  status: string;
  last_outcome: string | null;
  outcome_label: string | null;
  outcome_notes: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  variables: Record<string, string>;
  call_id: string | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  answered_by: string | null;
  end_reason: string | null;
}

const MAX_VARIABLE_COLUMNS = 50;

/** One line per contact with its latest attempt and its {{variables}}. Cells that could run as spreadsheet formulas are neutralised. */
export async function exportCsv(tx: Queryable, orgId: string, campaignId: string, limit: number): Promise<string> {
  const rows = (
    await tx.query<ExportRow>(
      `SELECT c.e164, c.name, c.time_zone, c.status, c.last_outcome, c.outcome_label, c.outcome_notes, c.attempts, c.next_attempt_at, c.variables,
              a.call_id, a.ended_at, a.duration_seconds, a.answered_by, a.end_reason
       FROM campaign_contact c
       LEFT JOIN LATERAL (
         SELECT call_id, ended_at, duration_seconds, answered_by, end_reason FROM campaign_attempt x
         WHERE x.contact_id = c.id AND x.org_id = c.org_id AND x.dialed_at IS NOT NULL ORDER BY x.attempt_no DESC LIMIT 1
       ) a ON true
       WHERE c.org_id = $1 AND c.campaign_id = $2 ORDER BY c.source_row NULLS LAST, c.id LIMIT $3`,
      [orgId, campaignId, limit]
    )
  ).rows;
  const names = [...new Set(rows.flatMap((r) => Object.keys(r.variables)))].sort().slice(0, MAX_VARIABLE_COLUMNS);
  const header = ['phone', 'name', 'time_zone', 'status', 'outcome', 'outcome_label', 'outcome_notes', 'attempts', 'last_attempt_ended_at', 'next_attempt_at', 'call_id', 'duration_seconds', 'answered_by', 'end_reason', ...names.map((n) => `var.${n}`)];
  const lines = [header.map((h) => csvCell(h, { raw: true })).join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.e164, { raw: true }),
        csvCell(r.name),
        csvCell(r.time_zone),
        csvCell(r.status),
        csvCell(r.last_outcome),
        csvCell(r.outcome_label),
        csvCell(r.outcome_notes),
        csvCell(r.attempts),
        csvCell(iso(r.ended_at), { raw: true }),
        csvCell(iso(r.next_attempt_at), { raw: true }),
        csvCell(r.call_id, { raw: true }),
        csvCell(r.duration_seconds),
        csvCell(r.answered_by),
        csvCell(r.end_reason),
        ...names.map((n) => csvCell(r.variables[n])),
      ].join(',')
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
