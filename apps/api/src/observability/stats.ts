/**
 * Call statistics for an org over a time range: the numbers behind the boards, scorecards and
 * monitoring policies. One definition of each metric, used by all three, so a board and the alert
 * that watches it can never disagree.
 *
 * Definitions (rates are percentages, 0-100):
 * - calls in range: calls created in [from, to), optionally for one assistant and one phone number;
 * - finished: calls whose status is ended or failed;
 * - error rate: finished calls that ended with an error-* reason (a provider or the engine failed) or
 *   worker-lost, over finished calls. Calls that ended because nobody answered or the line was busy
 *   are not errors;
 * - success rate: calls whose analysis has a pass-fail verdict that passed, over calls with a verdict;
 * - voice-to-voice latency: from the end of the caller's speech to the first agent audio, per spoken
 *   turn (typed replies excluded), p50/p95/p99 over every such turn of the calls in range;
 * - usage: call time and provider units (no money: price tables arrive with billing, D56).
 *
 * Every function takes the org transaction and filters by org_id explicitly; row-level security is the
 * second layer.
 */
import type { Queryable } from '../db/database.ts';

export type Interval = 'hour' | 'day';

export interface BoardFilter {
  orgId: string;
  from: Date;
  to: Date;
  assistantId?: string;
  phoneNumberId?: string;
}

class Sql {
  readonly params: unknown[] = [];
  bind(value: unknown): string {
    return `$${this.params.push(value)}`;
  }
}

/** Calls of the org in range, matching the filters. `c` is the call table alias. */
function callWhere(f: BoardFilter, sql: Sql): string {
  const parts = [`c.org_id = ${sql.bind(f.orgId)}`, `c.created_at >= ${sql.bind(f.from.toISOString())}::timestamptz`, `c.created_at < ${sql.bind(f.to.toISOString())}::timestamptz`];
  if (f.assistantId) parts.push(`c.assistant_id = ${sql.bind(f.assistantId)}`);
  if (f.phoneNumberId) parts.push(`c.phone_number_id = ${sql.bind(f.phoneNumberId)}`);
  return parts.join(' AND ');
}

const ERRORED = `(c.end_reason ~ '^error-' OR c.end_reason = 'worker-lost')`;
const FINISHED = `c.status IN ('ended', 'failed')`;

const percent = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 10_000) / 100 : null);
const round = (value: number | null, digits = 1): number | null => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);

// ---------------------------------------------------------------- building blocks

export async function callCounts(tx: Queryable, f: BoardFilter) {
  const sql = new Sql();
  const where = callWhere(f, sql);
  const row = (
    await tx.query<{ total: number; finished: number; errored: number; avg_ms: number | null; with_duration: number; call_ms: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE ${FINISHED})::int AS finished,
              count(*) FILTER (WHERE ${FINISHED} AND ${ERRORED})::int AS errored,
              avg(c.duration_ms) FILTER (WHERE c.status = 'ended' AND c.duration_ms IS NOT NULL)::float AS avg_ms,
              count(*) FILTER (WHERE c.status = 'ended' AND c.duration_ms IS NOT NULL)::int AS with_duration,
              coalesce(sum(c.duration_ms) FILTER (WHERE c.duration_ms IS NOT NULL), 0)::float AS call_ms
       FROM call c WHERE ${where}`,
      sql.params
    )
  ).rows[0];
  return { total: row.total, finished: row.finished, errored: row.errored, avgDurationMs: row.avg_ms, withDuration: row.with_duration, callSeconds: row.call_ms / 1000 };
}

export async function successCounts(tx: Queryable, f: BoardFilter) {
  const sql = new Sql();
  const where = callWhere(f, sql);
  const row = (
    await tx.query<{ evaluated: number; passed: number; scored: number; avg_score: number | null }>(
      `SELECT count(*) FILTER (WHERE a.success_passed IS NOT NULL)::int AS evaluated,
              count(*) FILTER (WHERE a.success_passed)::int AS passed,
              count(a.success_score)::int AS scored,
              avg(a.success_score)::float AS avg_score
       FROM call c JOIN call_analysis a ON a.call_id = c.id AND a.org_id = c.org_id WHERE ${where}`,
      sql.params
    )
  ).rows[0];
  return { evaluated: row.evaluated, passed: row.passed, scored: row.scored, avgScore: row.avg_score };
}

export interface Quantiles {
  samples: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** Voice-to-voice latency of spoken turns, in milliseconds. */
export async function latencyQuantiles(tx: Queryable, f: BoardFilter): Promise<Quantiles> {
  const sql = new Sql();
  const where = callWhere(f, sql);
  const row = (
    await tx.query<{ n: number; q: number[] | null }>(
      `SELECT count(*)::int AS n, percentile_cont(ARRAY[0.5, 0.95, 0.99]) WITHIN GROUP (ORDER BY t.v) AS q
       FROM (SELECT (e.payload -> 'latency' ->> 'voiceToVoiceMs')::float AS v
             FROM call_event e JOIN call c ON c.id = e.call_id AND c.org_id = e.org_id
             WHERE e.org_id = ${sql.bind(f.orgId)} AND e.type = 'turn' AND e.payload ->> 'kind' = 'reply' AND e.payload -> 'latency' ->> 'voiceToVoiceMs' IS NOT NULL AND ${where}) t`,
      sql.params
    )
  ).rows[0];
  return { samples: row.n, p50: round(row.q?.[0] ?? null), p95: round(row.q?.[1] ?? null), p99: round(row.q?.[2] ?? null) };
}

export async function usageUnits(tx: Queryable, f: BoardFilter) {
  const sql = new Sql();
  const where = callWhere(f, sql);
  const row = (
    await tx.query<{ stt: string; input: string; output: string; chars: string }>(
      `SELECT coalesce(sum((u -> 'units' ->> 'audioSeconds')::numeric), 0)::text AS stt,
              coalesce(sum((u -> 'units' ->> 'inputTokens')::numeric), 0)::text AS input,
              coalesce(sum((u -> 'units' ->> 'outputTokens')::numeric), 0)::text AS output,
              coalesce(sum((u -> 'units' ->> 'characters')::numeric), 0)::text AS chars
       FROM call c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.usage) = 'array' THEN c.usage ELSE '[]'::jsonb END) u WHERE ${where}`,
      sql.params
    )
  ).rows[0];
  return { sttAudioSeconds: Number(row.stt), llmInputTokens: Number(row.input), llmOutputTokens: Number(row.output), ttsCharacters: Number(row.chars) };
}

export async function endReasons(tx: Queryable, f: BoardFilter) {
  const sql = new Sql();
  const where = callWhere(f, sql);
  return (
    await tx.query<{ reason: string; count: number }>(
      `SELECT coalesce(c.end_reason, 'unknown') AS reason, count(*)::int AS count FROM call c WHERE ${where} AND ${FINISHED} GROUP BY 1 ORDER BY 2 DESC, 1`,
      sql.params
    )
  ).rows;
}

// ---------------------------------------------------------------- the board

export async function overview(tx: Queryable, f: BoardFilter) {
  const [counts, success, latency, usage, reasons] = await Promise.all([callCounts(tx, f), successCounts(tx, f), latencyQuantiles(tx, f), usageUnits(tx, f), endReasons(tx, f)]);
  return {
    range: { from: f.from.toISOString(), to: f.to.toISOString() },
    filters: { assistantId: f.assistantId ?? null, phoneNumberId: f.phoneNumberId ?? null },
    calls: { total: counts.total, finished: counts.finished, errored: counts.errored },
    errorRatePercent: percent(counts.errored, counts.finished),
    avgDurationSeconds: round(counts.avgDurationMs === null ? null : counts.avgDurationMs / 1000),
    success: { evaluated: success.evaluated, passed: success.passed, ratePercent: percent(success.passed, success.evaluated), scored: success.scored, avgScore: round(success.avgScore, 2) },
    endReasons: reasons,
    latency: { voiceToVoiceMs: latency },
    usage: { callSeconds: Math.round(counts.callSeconds), callMinutes: Math.round((counts.callSeconds / 60) * 100) / 100, ...usage },
  };
}

const BUCKET = `to_char(date_trunc(%INTERVAL%, c.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/** Start of the bucket holding `date`, in UTC. */
export function bucketStart(date: Date, interval: Interval): Date {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  if (interval === 'day') d.setUTCHours(0);
  return d;
}

export function bucketKeys(from: Date, to: Date, interval: Interval): string[] {
  const step = interval === 'hour' ? 3_600_000 : 86_400_000;
  const keys: string[] = [];
  for (let t = bucketStart(from, interval).getTime(); t < to.getTime(); t += step) keys.push(new Date(t).toISOString().replace('.000Z', 'Z'));
  return keys;
}

export const MAX_BUCKETS = 800;

export async function series(tx: Queryable, f: BoardFilter, interval: Interval) {
  const keys = bucketKeys(f.from, f.to, interval);
  const run = async <T>(select: string, from: string, extra = ''): Promise<(T & { bucket: string })[]> => {
    const sql = new Sql();
    const bucket = BUCKET.replace('%INTERVAL%', sql.bind(interval));
    const where = callWhere(f, sql);
    return (await tx.query<T & { bucket: string }>(`SELECT ${bucket} AS bucket, ${select} FROM ${from} WHERE ${where}${extra} GROUP BY 1`, sql.params)).rows;
  };
  const [calls, success, latency] = await Promise.all([
    run<{ total: number; finished: number; errored: number; avg_ms: number | null; call_ms: number }>(
      `count(*)::int AS total, count(*) FILTER (WHERE ${FINISHED})::int AS finished, count(*) FILTER (WHERE ${FINISHED} AND ${ERRORED})::int AS errored,
       avg(c.duration_ms) FILTER (WHERE c.status = 'ended' AND c.duration_ms IS NOT NULL)::float AS avg_ms, coalesce(sum(c.duration_ms) FILTER (WHERE c.duration_ms IS NOT NULL), 0)::float AS call_ms`,
      'call c'
    ),
    run<{ evaluated: number; passed: number; avg_score: number | null }>(
      `count(*) FILTER (WHERE a.success_passed IS NOT NULL)::int AS evaluated, count(*) FILTER (WHERE a.success_passed)::int AS passed, avg(a.success_score)::float AS avg_score`,
      'call c JOIN call_analysis a ON a.call_id = c.id AND a.org_id = c.org_id'
    ),
    (async () => {
      const sql = new Sql();
      const bucket = BUCKET.replace('%INTERVAL%', sql.bind(interval));
      const where = callWhere(f, sql);
      return (
        await tx.query<{ bucket: string; n: number; q: number[] }>(
          `SELECT ${bucket} AS bucket, count(*)::int AS n, percentile_cont(ARRAY[0.5, 0.95, 0.99]) WITHIN GROUP (ORDER BY (e.payload -> 'latency' ->> 'voiceToVoiceMs')::float) AS q
           FROM call_event e JOIN call c ON c.id = e.call_id AND c.org_id = e.org_id
           WHERE e.org_id = ${sql.bind(f.orgId)} AND e.type = 'turn' AND e.payload ->> 'kind' = 'reply' AND e.payload -> 'latency' ->> 'voiceToVoiceMs' IS NOT NULL AND ${where} GROUP BY 1`,
          sql.params
        )
      ).rows;
    })(),
  ]);
  const byBucket = <T extends { bucket: string }>(rows: T[]) => new Map(rows.map((r) => [r.bucket, r]));
  const callMap = byBucket(calls);
  const successMap = byBucket(success);
  const latencyMap = byBucket(latency);
  return keys.map((bucket) => {
    const c = callMap.get(bucket);
    const s = successMap.get(bucket);
    const l = latencyMap.get(bucket);
    return {
      bucket,
      calls: c?.total ?? 0,
      finished: c?.finished ?? 0,
      errored: c?.errored ?? 0,
      errorRatePercent: percent(c?.errored ?? 0, c?.finished ?? 0),
      avgDurationSeconds: round(c?.avg_ms == null ? null : c.avg_ms / 1000),
      callSeconds: Math.round((c?.call_ms ?? 0) / 1000),
      success: { evaluated: s?.evaluated ?? 0, passed: s?.passed ?? 0, ratePercent: percent(s?.passed ?? 0, s?.evaluated ?? 0), avgScore: round(s?.avg_score ?? null, 2) },
      latencyMs: { samples: l?.n ?? 0, p50: round(l?.q?.[0] ?? null), p95: round(l?.q?.[1] ?? null), p99: round(l?.q?.[2] ?? null) },
    };
  });
}

// ---------------------------------------------------------------- scorecards

export type ScorecardSource = { type: 'output'; field: string; outputId?: string } | { type: 'success'; property: 'passed' | 'score' | 'category' };
export type ScorecardAggregate = 'rate' | 'avg' | 'min' | 'max' | 'sum' | 'count';

export interface ScorecardSpec {
  source: ScorecardSource;
  aggregate: ScorecardAggregate;
  /** For `rate`: the value that counts as a hit (true, "positive", 5...). Passed defaults to true. */
  equals?: string | number | boolean;
  filters?: { assistantId?: string; phoneNumberId?: string };
}

export interface MetricResult {
  value: number | null;
  /** Data points the value is based on (calls with a value; turns for latency). */
  sample: number;
  unit: 'percent' | 'ms' | 'count' | 'score' | 'value';
}

/** Per-call value of a scorecard source as `x.v` (jsonb), only for calls that have one. */
function scorecardFrom(spec: ScorecardSpec, sql: Sql): string {
  const base = 'call c JOIN call_analysis a ON a.call_id = c.id AND a.org_id = c.org_id';
  const source = spec.source;
  if (source.type === 'success') {
    const column = source.property === 'passed' ? 'a.success_passed' : source.property === 'score' ? 'a.success_score' : 'a.success_category';
    return `${base} CROSS JOIN LATERAL (SELECT to_jsonb(${column}) AS v WHERE ${column} IS NOT NULL) x`;
  }
  const field = sql.bind(source.field);
  const restrict = source.outputId ? ` AND o.key = ${sql.bind(source.outputId)}` : '';
  return `${base} CROSS JOIN LATERAL (
    SELECT o.val -> 'values' -> ${field} AS v FROM jsonb_each(a.outputs) o(key, val)
    WHERE o.val ->> 'status' = 'succeeded'${restrict} AND jsonb_typeof(o.val -> 'values' -> ${field}) IN ('string', 'number', 'boolean') ORDER BY o.key LIMIT 1) x`;
}

const equalsText = (spec: ScorecardSpec): string => String(spec.equals ?? (spec.source.type === 'success' && spec.source.property === 'passed' ? true : ''));

function aggregateSelect(spec: ScorecardSpec, sql: Sql): string {
  const numeric = `CASE WHEN jsonb_typeof(x.v) = 'number' THEN (x.v #>> '{}')::float END`;
  switch (spec.aggregate) {
    case 'count':
      return `count(*)::int AS sample, NULL::float AS agg`;
    case 'rate':
      return `count(*)::int AS sample, (count(*) FILTER (WHERE x.v #>> '{}' = ${sql.bind(equalsText(spec))}))::float AS agg`;
    default:
      return `count(*) FILTER (WHERE jsonb_typeof(x.v) = 'number')::int AS sample, ${spec.aggregate}(${numeric})::float AS agg`;
  }
}

function scorecardResult(spec: ScorecardSpec, row: { sample: number; agg: number | null } | undefined): MetricResult {
  const sample = row?.sample ?? 0;
  if (spec.aggregate === 'count') return { value: sample, sample, unit: 'count' };
  if (spec.aggregate === 'rate') return { value: percent(row?.agg ?? 0, sample), sample, unit: 'percent' };
  return { value: sample === 0 ? null : round(row?.agg ?? null, 4), sample, unit: spec.source.type === 'success' && spec.source.property === 'score' ? 'score' : 'value' };
}

export async function scorecardValue(tx: Queryable, f: BoardFilter, spec: ScorecardSpec): Promise<MetricResult> {
  const sql = new Sql();
  const from = scorecardFrom(spec, sql);
  const select = aggregateSelect(spec, sql);
  const where = callWhere({ ...f, ...(spec.filters ?? {}) }, sql);
  const row = (await tx.query<{ sample: number; agg: number | null }>(`SELECT ${select} FROM ${from} WHERE ${where}`, sql.params)).rows[0];
  return scorecardResult(spec, row);
}

export async function scorecardSeries(tx: Queryable, f: BoardFilter, spec: ScorecardSpec, interval: Interval) {
  const sql = new Sql();
  const bucket = BUCKET.replace('%INTERVAL%', sql.bind(interval));
  const from = scorecardFrom(spec, sql);
  const select = aggregateSelect(spec, sql);
  const where = callWhere({ ...f, ...(spec.filters ?? {}) }, sql);
  const rows = (await tx.query<{ bucket: string; sample: number; agg: number | null }>(`SELECT ${bucket} AS bucket, ${select} FROM ${from} WHERE ${where} GROUP BY 1`, sql.params)).rows;
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  return bucketKeys(f.from, f.to, interval).map((key) => ({ bucket: key, ...scorecardResult(spec, byBucket.get(key)) }));
}

// ---------------------------------------------------------------- one number for a policy

export const POLICY_METRICS = ['success_rate', 'error_rate', 'latency_p50_ms', 'latency_p95_ms', 'latency_p99_ms', 'call_count', 'avg_duration_ms', 'scorecard'] as const;
export type PolicyMetric = (typeof POLICY_METRICS)[number];

export const METRIC_UNITS: Record<Exclude<PolicyMetric, 'scorecard'>, MetricResult['unit']> = {
  success_rate: 'percent',
  error_rate: 'percent',
  latency_p50_ms: 'ms',
  latency_p95_ms: 'ms',
  latency_p99_ms: 'ms',
  call_count: 'count',
  avg_duration_ms: 'ms',
};

/** The current value of a monitoring metric over the filter's range, and how many data points back it. */
export async function metricValue(tx: Queryable, f: BoardFilter, metric: PolicyMetric, scorecard?: ScorecardSpec): Promise<MetricResult> {
  switch (metric) {
    case 'success_rate': {
      const s = await successCounts(tx, f);
      return { value: percent(s.passed, s.evaluated), sample: s.evaluated, unit: 'percent' };
    }
    case 'error_rate': {
      const c = await callCounts(tx, f);
      return { value: percent(c.errored, c.finished), sample: c.finished, unit: 'percent' };
    }
    case 'call_count': {
      const c = await callCounts(tx, f);
      return { value: c.total, sample: c.total, unit: 'count' };
    }
    case 'avg_duration_ms': {
      const c = await callCounts(tx, f);
      return { value: round(c.avgDurationMs), sample: c.withDuration, unit: 'ms' };
    }
    case 'scorecard':
      if (!scorecard) throw new Error('A scorecard policy needs its scorecard');
      return scorecardValue(tx, f, scorecard);
    default: {
      const q = await latencyQuantiles(tx, f);
      const value = metric === 'latency_p50_ms' ? q.p50 : metric === 'latency_p95_ms' ? q.p95 : q.p99;
      return { value, sample: q.samples, unit: 'ms' };
    }
  }
}
