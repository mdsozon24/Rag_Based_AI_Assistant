/**
 * Org boards (call volume, duration, usage, success, end reasons, latency trend, filtered by
 * assistant, date range and phone number) and scorecards (org-defined metrics tracked over time).
 * Data endpoints only: the dashboard UI (Phase 9) draws them. Reference: docs/API.md ("Boards and scorecards").
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp } from '../auth/authenticate.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';
import { cursorClause, idParam, pageRequest, parse, toPage } from '../http/validation.ts';
import { bucketKeys, MAX_BUCKETS, overview, scorecardSeries, scorecardValue, series, type BoardFilter, type Interval } from '../observability/stats.ts';
import { audit } from '../services/audit.ts';
import { createScorecard, deleteScorecard, getScorecard, scorecardPatchSchema, scorecardSchema, SCORECARD_COLUMNS, scorecardView, updateScorecard, type ScorecardRow } from '../services/scorecards.ts';
import { scope } from './org.ts';

const DAY = 86_400_000;
const uuid = z.string().uuid();

const rangeQuery = z
  .object({
    /** ISO date or date-time; default 7 days before `to`. */
    from: z.string().max(40).optional(),
    /** Exclusive end; default now. */
    to: z.string().max(40).optional(),
    assistantId: uuid.optional(),
    phoneNumberId: uuid.optional(),
    interval: z.enum(['hour', 'day']).optional(),
  })
  .strict();

function date(path: string, value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ApiError('validation_error', 'The request is invalid', { issues: [{ path, message: 'Must be a date or date-time like 2026-10-05 or 2026-10-05T00:00:00Z' }] });
  return parsed;
}

/** The query as a filter: range (default the last 7 days), at most BOARD_MAX_RANGE_DAYS, plus assistant and number. */
function filterOf(orgId: string, query: unknown, now: Date, maxDays: number): { filter: BoardFilter; interval: Interval } {
  const q = parse(rangeQuery, query);
  const to = q.to ? date('to', q.to) : new Date(now.getTime() + 1000);
  const from = q.from ? date('from', q.from) : new Date(to.getTime() - 7 * DAY);
  if (from >= to) throw new ApiError('validation_error', 'The request is invalid', { issues: [{ path: 'from', message: 'Must be before to' }] });
  if (to.getTime() - from.getTime() > maxDays * DAY) throw new ApiError('validation_error', 'The request is invalid', { issues: [{ path: 'from', message: `The range can be at most ${maxDays} days` }] });
  // Hourly buckets for a short range, daily otherwise, unless asked
  const interval: Interval = q.interval ?? (to.getTime() - from.getTime() <= 3 * DAY ? 'hour' : 'day');
  if (bucketKeys(from, to, interval).length > MAX_BUCKETS) throw new ApiError('validation_error', 'The request is invalid', { issues: [{ path: 'interval', message: `That range has more than ${MAX_BUCKETS} ${interval} buckets; use a shorter range or interval=day` }] });
  return { filter: { orgId, from, to, ...(q.assistantId ? { assistantId: q.assistantId } : {}), ...(q.phoneNumberId ? { phoneNumberId: q.phoneNumberId } : {}) }, interval };
}

export function registerBoardRoutes(app: FastifyInstance, ctx: AppContext): void {
  const maxDays = ctx.config.monitoring.boardMaxRangeDays;
  const clock = () => ctx.monitoring.now();

  app.get('/v1/boards/overview', { config: { permission: 'calls:read' } }, async (request) => {
    const org = scope(request);
    const { filter } = filterOf(org.id, request.query, clock(), maxDays);
    return org.run((tx) => overview(tx, filter));
  });

  app.get('/v1/boards/series', { config: { permission: 'calls:read' } }, async (request) => {
    const org = scope(request);
    const { filter, interval } = filterOf(org.id, request.query, clock(), maxDays);
    const buckets = await org.run((tx) => series(tx, filter, interval));
    return { range: { from: filter.from.toISOString(), to: filter.to.toISOString() }, interval, filters: { assistantId: filter.assistantId ?? null, phoneNumberId: filter.phoneNumberId ?? null }, buckets };
  });

  // ---------------------------------------------------------------- scorecards

  app.post('/v1/scorecards', { config: { permission: 'monitoring:manage' } }, async (request, reply) => {
    const org = scope(request);
    const input = parse(scorecardSchema, request.body);
    const row = await org.run(async (tx) => {
      const created = await createScorecard(tx, org.id, org.actor, input);
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'scorecard.created', targetType: 'scorecard', targetId: created.id, metadata: { name: created.name }, ip: clientIp(request) });
      return created;
    });
    return reply.code(201).send(scorecardView(row));
  });

  app.get('/v1/scorecards', { config: { permission: 'monitoring:read' } }, async (request) => {
    const org = scope(request);
    const page = pageRequest(request.query);
    const cursor = cursorClause(page, 3);
    const rows = await org.run(async (tx) => (await tx.query<ScorecardRow>(`SELECT ${SCORECARD_COLUMNS} FROM scorecard WHERE org_id = $1 AND deleted_at IS NULL${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT $2`, [org.id, page.limit + 1, ...cursor.params])).rows);
    return toPage(rows, page.limit, scorecardView);
  });

  app.get('/v1/scorecards/:id', { config: { permission: 'monitoring:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Scorecard');
    return scorecardView(await org.run((tx) => getScorecard(tx, org.id, id)));
  });

  app.patch('/v1/scorecards/:id', { config: { permission: 'monitoring:manage' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Scorecard');
    const patch = parse(scorecardPatchSchema, request.body);
    return org.run(async (tx) => {
      const row = await updateScorecard(tx, org.id, id, patch);
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'scorecard.updated', targetType: 'scorecard', targetId: id, metadata: { fields: Object.keys(patch) }, ip: clientIp(request) });
      return scorecardView(row);
    });
  });

  app.delete('/v1/scorecards/:id', { config: { permission: 'monitoring:manage' } }, async (request, reply) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Scorecard');
    await org.run(async (tx) => {
      await deleteScorecard(tx, org.id, id);
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'scorecard.deleted', targetType: 'scorecard', targetId: id, ip: clientIp(request) });
    });
    return reply.code(204).send();
  });

  /** The scorecard's value over the range (default: last 7 days). */
  app.get('/v1/scorecards/:id/value', { config: { permission: 'monitoring:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Scorecard');
    const { filter } = filterOf(org.id, request.query, clock(), maxDays);
    return org.run(async (tx) => {
      const card = await getScorecard(tx, org.id, id);
      const result = await scorecardValue(tx, filter, card.spec);
      return { scorecardId: id, name: card.name, range: { from: filter.from.toISOString(), to: filter.to.toISOString() }, ...result };
    });
  });

  /** The scorecard over time, one point per hour or day. */
  app.get('/v1/scorecards/:id/series', { config: { permission: 'monitoring:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Scorecard');
    const { filter, interval } = filterOf(org.id, request.query, clock(), maxDays);
    return org.run(async (tx) => {
      const card = await getScorecard(tx, org.id, id);
      return { scorecardId: id, name: card.name, range: { from: filter.from.toISOString(), to: filter.to.toISOString() }, interval, points: await scorecardSeries(tx, filter, card.spec, interval) };
    });
  });
}
