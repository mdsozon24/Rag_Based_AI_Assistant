/**
 * The debug view of one call: every recorded event in the order it happened (state changes, partial
 * and final transcripts, LLM requests and responses, tool calls, provider errors and fallbacks, the
 * call's own log lines, turn latency), so "why did it say that, and why was it slow" can be answered
 * from one response. Endpoint reference: docs/API.md ("Per-call debug view").
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';
import { idParam, iso, parse } from '../http/validation.ts';
import { loadTranscript } from '../services/analysis/transcript.ts';
import { scope } from './org.ts';

/** Most events one response returns; a call that produced more says so (`truncated`). */
const MAX_EVENTS = 5000;

const querySchema = z
  .object({
    /** Comma-separated event types to keep (default: all). */
    types: z.string().max(300).optional(),
    /** Include the stored LLM prompt and reply text where the assistant captured it. */
    bodies: z.enum(['true', 'false']).default('false'),
  })
  .strict();

interface EventRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

export function registerDebugRoutes(app: FastifyInstance, _ctx: AppContext): void {
  app.get('/v1/calls/:id/debug', { config: { permission: 'calls:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Call');
    const query = parse(querySchema, request.query);
    const types = query.types ? new Set(query.types.split(',').map((t) => t.trim()).filter(Boolean)) : null;
    return org.run(async (tx) => {
      const call = (
        await tx.query<{ id: string; assistant_id: string | null; assistant_name: string; status: string; end_reason: string | null; started_at: Date | null; created_at: Date; ended_at: Date | null; duration_ms: number | null; config: { debug?: { captureLlm?: boolean } } }>(
          'SELECT id, assistant_id, assistant_name, status, end_reason, started_at, created_at, ended_at, duration_ms, config FROM call WHERE org_id = $1 AND id = $2',
          [org.id, id]
        )
      ).rows[0];
      if (!call) throw new ApiError('not_found', 'Call not found');
      const events = (await tx.query<EventRow>('SELECT id, type, payload, created_at FROM call_event WHERE org_id = $1 AND call_id = $2 ORDER BY created_at, id LIMIT $3', [org.id, id, MAX_EVENTS + 1])).rows;
      const truncated = events.length > MAX_EVENTS;
      if (truncated) events.length = MAX_EVENTS;
      const bodies = new Map<string, Record<string, unknown>>();
      if (query.bodies === 'true') {
        for (const row of (await tx.query<{ event_id: string; body: Record<string, unknown> }>('SELECT event_id, body FROM call_debug_body WHERE org_id = $1 AND call_id = $2', [org.id, id])).rows) bodies.set(row.event_id, row.body);
      }
      const origin = (call.started_at ?? call.created_at).getTime();
      const entries: { at: string; offsetMs: number; type: string; id: string; payload: Record<string, unknown>; body?: Record<string, unknown> }[] = [];
      const add = (at: Date, type: string, entryId: string, payload: Record<string, unknown>, body?: Record<string, unknown>) => {
        if (types && !types.has(type)) return;
        entries.push({ at: at.toISOString(), offsetMs: at.getTime() - origin, type, id: entryId, payload, ...(body ? { body } : {}) });
      };
      for (const event of events) {
        // Events that carry their own time (state changes, LLM calls, log lines) use it; the rest use when they were stored
        const stamp = typeof event.payload.at === 'string' && !Number.isNaN(Date.parse(event.payload.at)) ? new Date(event.payload.at) : event.created_at;
        const { at: _at, ...rest } = event.payload;
        add(stamp, event.type, event.id, rest, bodies.get(event.id));
      }
      // Final transcript lines, with their own start times (tool calls are already events)
      for (const line of await loadTranscript(tx, org.id, id)) {
        if (line.kind === 'speech') add(line.started_at, 'transcript', line.id, { seq: line.seq, role: line.role, text: line.text, endedAt: iso(line.ended_at), interrupted: line.interrupted });
      }
      // Stable order: time, then the order they were stored
      const order = new Map(entries.map((e, i) => [e.id, i]));
      entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

      const counts: Record<string, number> = {};
      for (const e of entries) counts[e.type] = (counts[e.type] ?? 0) + 1;
      const turns = events
        .filter((e) => e.type === 'turn')
        .map((e) => ({ index: e.payload.index, kind: e.payload.kind, interrupted: e.payload.interrupted, latency: e.payload.latency }));
      const ended = events.find((e) => e.type === 'ended');
      return {
        call: {
          id: call.id,
          assistantId: call.assistant_id,
          assistantName: call.assistant_name,
          status: call.status,
          endReason: call.end_reason,
          startedAt: iso(call.started_at),
          endedAt: iso(call.ended_at),
          durationMs: call.duration_ms,
          /** Whether the assistant stores full LLM prompts and replies (otherwise the timeline has metadata only). */
          captureLlm: call.config?.debug?.captureLlm === true,
        },
        summary: {
          events: entries.length,
          byType: counts,
          providerErrors: counts['provider-error'] ?? 0,
          providerFallbacks: counts['provider-fallback'] ?? 0,
          errors: (counts.error ?? 0) + (entries.filter((e) => e.type === 'log' && e.payload.level === 'error').length),
          llmRequests: counts['llm-request'] ?? 0,
          droppedLogLines: Number((ended?.payload.droppedLogLines as number | undefined) ?? 0),
          droppedPartials: Number((ended?.payload.droppedPartials as number | undefined) ?? 0),
        },
        turns,
        truncated,
        timeline: entries,
      };
    });
  });
}
