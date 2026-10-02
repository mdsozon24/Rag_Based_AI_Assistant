/**
 * Calls with their analysis: the call list with filters (including on structured output values),
 * one call's analysis, re-running it, and transcript search. Endpoint reference: docs/API.md
 * ("Call analysis").
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp } from '../auth/authenticate.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';
import { cursorClause, idParam, iso, pageRequest, parse, toPage } from '../http/validation.ts';
import { audit } from '../services/audit.ts';
import { ANALYSIS_COLUMNS, analysisView, type AnalysisFullRow } from '../services/analysis/view.ts';
import { rerunAnalysis } from '../services/analysis/worker.ts';
import { scope } from './org.ts';

const CALL_STATUS = z.enum(['queued', 'ringing', 'in-progress', 'ended', 'failed']);
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FIXED_FILTERS = new Set(['limit', 'cursor', 'assistantId', 'status', 'type', 'direction', 'campaignId', 'endReason', 'from', 'to', 'analysisStatus', 'success', 'successScore.gte', 'successScore.lte', 'successCategory', 'outputId', 'q']);
const OPERATORS = { gte: '>=', gt: '>', lte: '<=', lt: '<' } as const;
const NUMBER = /^-?\d+(\.\d+)?$/;
/** End reasons are kebab-case words: customer-ended-call, error-llm-failed, silence-timeout... */
const END_REASON = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_END_REASONS = 10;
const uuid = z.string().uuid();

interface CallListRow {
  id: string;
  cursor_ts: string;
  assistant_id: string | null;
  assistant_name: string;
  type: string;
  direction: string;
  status: string;
  end_reason: string | null;
  customer_number: string | null;
  campaign_id: string | null;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  duration_ms: number | null;
}

const bad = (path: string, message: string) => new ApiError('validation_error', 'The request is invalid', { issues: [{ path, message }] });

/** SQL for the call list: the fixed filters, then one EXISTS per `output.<field>` filter (AND). */
function callFilters(query: Record<string, unknown>, orgId: string) {
  const params: unknown[] = [orgId];
  const where: string[] = ['c.org_id = $1'];
  const bind = (value: unknown) => `$${params.push(value)}`;
  const str = (key: string): string | undefined => {
    const value = query[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value) throw bad(key, 'Give one value');
    return value;
  };
  for (const key of Object.keys(query)) {
    if (!FIXED_FILTERS.has(key) && !key.startsWith('output.')) throw bad(key, 'Unknown filter');
  }

  /** A filter whose value must pass `schema`; the message names the allowed values. */
  const checked = (key: string, schema: z.ZodTypeAny, message: string): string | undefined => {
    const value = str(key);
    if (value === undefined) return undefined;
    if (!schema.safeParse(value).success) throw bad(key, message);
    return value;
  };
  const eq = (column: string, value: string | undefined) => {
    if (value !== undefined) where.push(`${column} = ${bind(value)}`);
  };
  eq('c.assistant_id', checked('assistantId', uuid, 'Must be a UUID'));
  eq('c.campaign_id', checked('campaignId', uuid, 'Must be a UUID'));
  eq('c.status', checked('status', CALL_STATUS, `One of ${CALL_STATUS.options.join(', ')}`));
  eq('c.type', checked('type', z.enum(['web', 'inbound', 'outbound', 'sip']), 'One of web, inbound, outbound, sip'));
  eq('c.direction', checked('direction', z.enum(['inbound', 'outbound', 'web']), 'One of inbound, outbound, web'));
  // One end reason, or several separated by commas (any of them)
  const endReason = str('endReason');
  if (endReason) {
    const reasons = [...new Set(endReason.split(',').map((r) => r.trim()))];
    if (reasons.length > MAX_END_REASONS || reasons.some((r) => !END_REASON.test(r))) throw bad('endReason', `One end reason, or up to ${MAX_END_REASONS} separated by commas, like customer-ended-call`);
    where.push(`c.end_reason = ANY (${bind(reasons)}::text[])`);
  }
  for (const [key, op] of [['from', '>='], ['to', '<']] as const) {
    const value = str(key);
    if (!value) continue;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw bad(key, 'Must be a date or date-time like 2026-10-05T00:00:00Z');
    where.push(`c.created_at ${op} ${bind(date.toISOString())}::timestamptz`);
  }

  eq('a.status', checked('analysisStatus', z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped']), 'One of pending, running, succeeded, failed, skipped'));
  const success = str('success');
  if (success) {
    if (success !== 'true' && success !== 'false') throw bad('success', 'Must be true or false');
    where.push(`a.success_passed = ${bind(success === 'true')}`);
  }
  for (const [key, op] of [['successScore.gte', '>='], ['successScore.lte', '<=']] as const) {
    const value = str(key);
    if (!value) continue;
    if (!/^\d{1,2}$/.test(value)) throw bad(key, 'Must be a whole number from 1 to 10');
    where.push(`a.success_score ${op} ${bind(Number(value))}`);
  }
  const category = str('successCategory');
  if (category) where.push(`a.success_category = ${bind(category.slice(0, 100))}`);
  const text = str('q');
  if (text) where.push(`EXISTS (SELECT 1 FROM call_transcript t WHERE t.org_id = c.org_id AND t.call_id = c.id AND t.search @@ websearch_to_tsquery('simple', ${bind(text.slice(0, 200))}))`);

  // Structured output values: output.<field>=value, output.<field>.gte|gt|lte|lt=number (any output of the call, or outputId only)
  const outputId = str('outputId');
  if (outputId && outputId !== 'inline' && !uuid.safeParse(outputId).success) throw bad('outputId', 'Must be a structured output id, or "inline"');
  for (const [key, raw] of Object.entries(query)) {
    if (!key.startsWith('output.')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]{0,63})(?:\.(gte|gt|lte|lt))?$/.exec(key.slice('output.'.length));
    if (!match || !FIELD.test(match[1])) throw bad(key, 'Use output.<field>=value or output.<field>.gte|gt|lte|lt=number');
    if (typeof raw !== 'string' || !raw) throw bad(key, 'Give one value');
    const field = bind(match[1]);
    const restrict = outputId ? ` AND o.key = ${bind(outputId)}` : '';
    if (match[2]) {
      if (!NUMBER.test(raw)) throw bad(key, 'Must be a number');
      const op = OPERATORS[match[2] as keyof typeof OPERATORS];
      where.push(`EXISTS (SELECT 1 FROM jsonb_each(a.outputs) o(key, val) WHERE o.val ->> 'status' = 'succeeded'${restrict}
        AND CASE WHEN jsonb_typeof(o.val -> 'values' -> ${field}) = 'number' THEN (o.val -> 'values' ->> ${field})::numeric ${op} ${bind(raw)}::numeric ELSE false END)`);
    } else {
      // Compared as text: true/false, numbers as written by the model, and strings all work
      where.push(`EXISTS (SELECT 1 FROM jsonb_each(a.outputs) o(key, val) WHERE o.val ->> 'status' = 'succeeded'${restrict}
        AND jsonb_typeof(o.val -> 'values' -> ${field}) IN ('string', 'number', 'boolean') AND (o.val -> 'values' ->> ${field}) = ${bind(raw)})`);
    }
  }
  return { where, params, next: () => params.length + 1, bind };
}

export function registerCallAnalysisRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/calls', { config: { permission: 'calls:read' } }, async (request) => {
    const org = scope(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const page = pageRequest(query);
    const filters = callFilters(query, org.id);
    const limitParam = filters.bind(page.limit + 1);
    const cursor = cursorClause(page, filters.next(), 'c');
    filters.params.push(...cursor.params);
    return org.run(async (tx) => {
      const rows = (
        await tx.query<CallListRow>(
          `SELECT c.id, c.created_at::text AS cursor_ts, c.assistant_id, c.assistant_name, c.type, c.direction, c.status, c.end_reason, c.customer_number, c.campaign_id, c.created_at, c.started_at, c.ended_at, c.duration_ms
           FROM call c LEFT JOIN call_analysis a ON a.org_id = c.org_id AND a.call_id = c.id
           WHERE ${filters.where.join(' AND ')}${cursor.sql} ORDER BY c.created_at DESC, c.id DESC LIMIT ${limitParam}`,
          filters.params
        )
      ).rows;
      const shown = rows.slice(0, page.limit).map((r) => r.id);
      const analyses = shown.length ? (await tx.query<AnalysisFullRow>(`SELECT ${ANALYSIS_COLUMNS} FROM call_analysis WHERE org_id = $1 AND call_id = ANY ($2::uuid[])`, [org.id, shown])).rows : [];
      const byCall = new Map(analyses.map((a) => [a.call_id, a]));
      return toPage(rows, page.limit, (r) => ({
        id: r.id,
        assistantId: r.assistant_id,
        assistantName: r.assistant_name,
        type: r.type,
        direction: r.direction,
        status: r.status,
        endReason: r.end_reason,
        customerNumber: r.customer_number,
        campaignId: r.campaign_id,
        createdAt: iso(r.created_at),
        startedAt: iso(r.started_at),
        endedAt: iso(r.ended_at),
        durationMs: r.duration_ms,
        analysis: analysisView(byCall.get(r.id)),
      }));
    });
  });

  app.get('/v1/calls/:id/analysis', { config: { permission: 'calls:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Call');
    return org.run(async (tx) => {
      const row = (await tx.query<AnalysisFullRow>(`SELECT ${ANALYSIS_COLUMNS} FROM call_analysis WHERE org_id = $1 AND call_id = $2`, [org.id, id])).rows[0];
      if (!row) throw new ApiError('not_found', 'No analysis for this call (it may not have ended yet)');
      return analysisView(row);
    });
  });

  app.post('/v1/calls/:id/analysis', { config: { permission: 'calls:create' } }, async (request, reply) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Call');
    const view = await org.run(async (tx) => {
      await rerunAnalysis(tx, org.id, id, ctx.analysis.now());
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'call.analysis_rerun', targetType: 'call', targetId: id, ip: clientIp(request) });
      return analysisView((await tx.query<AnalysisFullRow>(`SELECT ${ANALYSIS_COLUMNS} FROM call_analysis WHERE org_id = $1 AND call_id = $2`, [org.id, id])).rows[0]);
    });
    return reply.code(202).send(view);
  });

  app.get('/v1/transcripts/search', { config: { permission: 'calls:read' } }, async (request) => {
    const org = scope(request);
    const query = parse(
      z.object({ q: z.string().trim().min(1).max(200), assistantId: uuid.optional(), callId: uuid.optional(), from: z.string().optional(), to: z.string().optional(), limit: z.unknown().optional(), cursor: z.unknown().optional() }).strict(),
      request.query
    );
    const page = pageRequest(request.query);
    const params: unknown[] = [org.id, page.limit + 1, query.q];
    const where = [`t.org_id = $1`, `t.search @@ websearch_to_tsquery('simple', $3)`];
    for (const [key, op] of [['from', '>='], ['to', '<']] as const) {
      const value = query[key];
      if (value === undefined) continue;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw bad(key, 'Must be a date or date-time like 2026-10-05T00:00:00Z');
      where.push(`c.created_at ${op} $${params.push(date.toISOString())}::timestamptz`);
    }
    if (query.assistantId) where.push(`c.assistant_id = $${params.push(query.assistantId)}`);
    if (query.callId) where.push(`t.call_id = $${params.push(query.callId)}`);
    const cursor = cursorClause(page, params.length + 1, 't');
    params.push(...cursor.params);
    return org.run(async (tx) => {
      const rows = (
        await tx.query<{ id: string; cursor_ts: string; call_id: string; seq: number; kind: string; role: string; text: string; snippet: string; started_at: Date; assistant_id: string | null; assistant_name: string; call_created_at: Date }>(
          `SELECT t.id, t.created_at::text AS cursor_ts, t.call_id, t.seq, t.kind, t.role, t.text, t.started_at, c.assistant_id, c.assistant_name, c.created_at AS call_created_at,
                  ts_headline('simple', t.text, websearch_to_tsquery('simple', $3), 'StartSel=«, StopSel=», MaxFragments=1, MaxWords=30, MinWords=8') AS snippet
           FROM call_transcript t JOIN call c ON c.id = t.call_id AND c.org_id = t.org_id
           WHERE ${where.join(' AND ')}${cursor.sql} ORDER BY t.created_at DESC, t.id DESC LIMIT $2`,
          params
        )
      ).rows;
      // The snippet marks each match with « » (plain text, safe to show as is: transcripts are caller-controlled)
      return toPage(rows, page.limit, (r) => ({
        callId: r.call_id,
        assistantId: r.assistant_id,
        assistantName: r.assistant_name,
        seq: r.seq,
        kind: r.kind,
        role: r.role,
        text: r.text,
        snippet: r.snippet,
        startedAt: iso(r.started_at),
        callCreatedAt: iso(r.call_created_at),
      }));
    });
  });
}
