/**
 * Call transcripts: one ordered list per call. Speech lines say who spoke and when (start and end);
 * tool calls sit between the lines they happened between. Rows are written in order by the call's
 * single write queue, and `seq` is the order. Search is per org (full text, 'simple' configuration:
 * no stemming, so it behaves the same for Bangla and English).
 */
import { newId } from '../../auth/crypto.ts';
import type { Queryable } from '../../db/database.ts';
import { iso } from '../../http/validation.ts';

export type SpeechRole = 'user' | 'assistant';

export type TranscriptInput =
  | { kind: 'speech'; role: SpeechRole; text: string; startedAt: Date; endedAt: Date; interrupted?: boolean }
  | { kind: 'tool-call'; name: string; args: Record<string, unknown>; at: Date; result?: unknown; status?: string };

/** Append one entry at the end of the call's transcript. */
export async function appendTranscript(tx: Queryable, orgId: string, callId: string, entry: TranscriptInput): Promise<void> {
  const next = '(SELECT coalesce(max(seq), 0) + 1 FROM call_transcript WHERE org_id = $2 AND call_id = $3)';
  if (entry.kind === 'speech') {
    await tx.query(
      `INSERT INTO call_transcript (id, org_id, call_id, seq, role, text, final, kind, started_at, ended_at, interrupted)
       VALUES ($1, $2, $3, ${next}, $4, $5, true, 'speech', $6::timestamptz, $7::timestamptz, $8)`,
      [newId(), orgId, callId, entry.role, entry.text, entry.startedAt.toISOString(), entry.endedAt.toISOString(), entry.interrupted ?? false]
    );
    return;
  }
  await tx.query(
    `INSERT INTO call_transcript (id, org_id, call_id, seq, role, text, final, kind, started_at, ended_at, tool_name, tool_args, tool_result, tool_status)
     VALUES ($1, $2, $3, ${next}, 'tool', $4, true, 'tool-call', $5::timestamptz, $5::timestamptz, $4, $6::jsonb, $7::jsonb, $8)`,
    [newId(), orgId, callId, entry.name, entry.at.toISOString(), JSON.stringify(entry.args), entry.result === undefined ? null : JSON.stringify(entry.result), entry.status ?? null]
  );
}

export interface TranscriptRow {
  id: string;
  seq: number;
  kind: 'speech' | 'tool-call';
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  final: boolean;
  interrupted: boolean;
  started_at: Date;
  ended_at: Date;
  tool_name: string | null;
  tool_args: Record<string, unknown> | null;
  tool_result: unknown;
  tool_status: string | null;
  created_at: Date;
}

export async function loadTranscript(tx: Queryable, orgId: string, callId: string): Promise<TranscriptRow[]> {
  return (
    await tx.query<TranscriptRow>(
      `SELECT id, seq, kind, role, text, final, interrupted, started_at, ended_at, tool_name, tool_args, tool_result, tool_status, created_at
       FROM call_transcript WHERE org_id = $1 AND call_id = $2 ORDER BY seq`,
      [orgId, callId]
    )
  ).rows;
}

/** The API's view of an entry. Offsets are milliseconds since the call began (the first entry when the call has no start time). */
export function transcriptView(row: TranscriptRow, callStartedAt: Date | null, firstEntryAt: Date) {
  const origin = (callStartedAt ?? firstEntryAt).getTime();
  const base = {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    role: row.role,
    text: row.text,
    final: row.final,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    startOffsetMs: Math.max(0, row.started_at.getTime() - origin),
    endOffsetMs: Math.max(0, row.ended_at.getTime() - origin),
    // Kept for older clients: when the row was written
    createdAt: iso(row.created_at),
  };
  if (row.kind === 'tool-call') return { ...base, toolCall: { name: row.tool_name, arguments: row.tool_args ?? {}, result: row.tool_result ?? null, status: row.tool_status ?? 'requested' } };
  return { ...base, interrupted: row.interrupted };
}

export function transcriptViews(rows: TranscriptRow[], callStartedAt: Date | null) {
  if (!rows.length) return [];
  const first = rows.reduce((min, r) => (r.started_at < min ? r.started_at : min), rows[0].started_at);
  return rows.map((row) => transcriptView(row, callStartedAt, first));
}

const mmss = (ms: number) => `${String(Math.floor(ms / 60_000)).padStart(2, '0')}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

/**
 * The transcript as the analysis model reads it. Long calls keep their start and end (the middle is
 * cut with a note) so one huge call cannot exceed the model's context.
 */
export function transcriptForModel(rows: TranscriptRow[], callStartedAt: Date | null, maxChars: number): string {
  if (!rows.length) return '';
  const first = rows.reduce((min, r) => (r.started_at < min ? r.started_at : min), rows[0].started_at);
  const origin = (callStartedAt ?? first).getTime();
  const lines = rows.map((r) => {
    const stamp = `[${mmss(Math.max(0, r.started_at.getTime() - origin))}]`;
    if (r.kind === 'tool-call') return `${stamp} (tool call) ${r.tool_name}(${JSON.stringify(r.tool_args ?? {})})${r.tool_status ? ` -> ${r.tool_status}` : ''}`;
    return `${stamp} ${r.role === 'user' ? 'Caller' : 'Assistant'}${r.interrupted ? ' (interrupted)' : ''}: ${r.text}`;
  });
  const whole = lines.join('\n');
  if (whole.length <= maxChars) return whole;
  const half = Math.floor(maxChars / 2);
  return `${whole.slice(0, half)}\n[... the middle of a long call was left out ...]\n${whole.slice(-half)}`;
}

// ---------------------------------------------------------------- search

export interface SearchHit {
  id: string;
  cursor_ts: string;
  call_id: string;
  seq: number;
  kind: string;
  role: string;
  text: string;
  snippet: string;
  started_at: Date;
  assistant_id: string | null;
  call_created_at: Date;
}
