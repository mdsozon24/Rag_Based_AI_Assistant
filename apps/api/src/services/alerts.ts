/**
 * Monitoring policies: an org-defined rule over its own calls ("success rate below 70% over the last
 * hour") that notifies people when it starts to fail, reminds while it keeps failing, and says when it
 * recovers.
 *
 * De-duplication (a policy never repeats itself):
 * - a rule that is breached for the first time is `firing` and sends ONE "fired" notification;
 * - while it keeps breaching it sends nothing, except an optional reminder every `renotifyMinutes`;
 * - when it stops breaching it sends ONE "resolved" notification;
 * - an evaluation with too few data points (`minSamples`) is inconclusive: it changes nothing and
 *   sends nothing, so a quiet night neither raises nor clears an alert;
 * - each notification is an outbox row unique per (event, channel, recipient), so a retried tick or a
 *   second node cannot send the same one twice.
 * Editing a rule resets its state (the old state described the old rule) without notifying.
 *
 * Email goes only to members of the org (owners and admins unless the policy names members); the
 * webhook goes to one of the org's own webhook endpoints, signed, through the guarded HTTP client.
 */
import { z } from 'zod';
import { newId } from '../auth/crypto.ts';
import type { Queryable } from '../db/database.ts';
import { ApiError } from '../http/errors.ts';
import { iso } from '../http/validation.ts';
import { METRIC_UNITS, metricValue, POLICY_METRICS, type BoardFilter, type MetricResult, type PolicyMetric, type ScorecardSpec } from '../observability/stats.ts';
import type { Actor } from './audit.ts';

const uuid = z.string().uuid();

export const policySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
    metric: z.enum(POLICY_METRICS),
    /** For metric "scorecard": the scorecard whose value is watched. */
    scorecardId: uuid.optional(),
    comparison: z.enum(['lt', 'gt']),
    /** success_rate, error_rate and rate scorecards are percentages (0-100); latency and duration are milliseconds. */
    threshold: z.number().finite(),
    /** The rule looks at calls created in the last windowMinutes (5 minutes to 7 days). */
    windowMinutes: z.number().int().min(5).max(10_080),
    /** Fewer data points than this (calls, or turns for latency) and the rule says nothing. */
    minSamples: z.number().int().min(0).max(100_000).default(5),
    assistantId: uuid.optional(),
    phoneNumberId: uuid.optional(),
    notify: z
      .object({
        email: z.boolean().default(true),
        /** Members to email; empty means every owner and admin. */
        userIds: z.array(uuid).max(50).default([]),
        /** One of the org's own org-scoped webhook endpoints. */
        webhookEndpointId: uuid.nullable().optional(),
      })
      .strict()
      .default({}),
    /** While still breaching, remind this often (0: never). */
    renotifyMinutes: z.number().int().min(0).max(10_080).default(360),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const add = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if ((policy.metric === 'scorecard') !== (policy.scorecardId !== undefined)) add('scorecardId', 'Give scorecardId with metric "scorecard", and only then');
    if (policy.metric === 'success_rate' || policy.metric === 'error_rate') {
      if (policy.threshold < 0 || policy.threshold > 100) add('threshold', 'Rates are percentages between 0 and 100');
    } else if (policy.metric !== 'scorecard' && policy.threshold < 0) add('threshold', 'Must not be negative');
    if (!policy.notify.email && !policy.notify.webhookEndpointId) add('notify', 'Turn on email or give a webhook endpoint, or nobody would hear about it');
  });

export const policyPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    metric: z.enum(POLICY_METRICS),
    scorecardId: uuid.nullable(),
    comparison: z.enum(['lt', 'gt']),
    threshold: z.number().finite(),
    windowMinutes: z.number().int().min(5).max(10_080),
    minSamples: z.number().int().min(0).max(100_000),
    assistantId: uuid.nullable(),
    phoneNumberId: uuid.nullable(),
    notify: z.object({ email: z.boolean(), userIds: z.array(uuid).max(50), webhookEndpointId: uuid.nullable() }).partial().strict(),
    renotifyMinutes: z.number().int().min(0).max(10_080),
  })
  .partial()
  .strict();

export interface PolicyRow {
  id: string;
  cursor_ts: string;
  org_id: string;
  name: string;
  enabled: boolean;
  metric: PolicyMetric;
  scorecard_id: string | null;
  comparison: 'lt' | 'gt';
  threshold: string;
  window_minutes: number;
  min_samples: number;
  assistant_id: string | null;
  phone_number_id: string | null;
  notify_email: boolean;
  notify_user_ids: string[];
  notify_webhook_endpoint_id: string | null;
  renotify_minutes: number;
  state: 'unknown' | 'ok' | 'firing';
  state_since: Date | null;
  last_value: string | null;
  last_sample: number | null;
  last_evaluated_at: Date | null;
  last_notified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export const POLICY_COLUMNS = `id, created_at::text AS cursor_ts, org_id, name, enabled, metric, scorecard_id, comparison, threshold::text AS threshold, window_minutes, min_samples, assistant_id, phone_number_id,
  notify_email, notify_user_ids, notify_webhook_endpoint_id, renotify_minutes, state, state_since, last_value::text AS last_value, last_sample, last_evaluated_at, last_notified_at, created_at, updated_at`;

export function unitOf(policy: Pick<PolicyRow, 'metric'>, scorecard?: ScorecardSpec): MetricResult['unit'] {
  if (policy.metric !== 'scorecard') return METRIC_UNITS[policy.metric];
  return scorecard?.aggregate === 'rate' ? 'percent' : scorecard?.aggregate === 'count' ? 'count' : 'value';
}

export function policyView(row: PolicyRow, scorecard?: ScorecardSpec) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    metric: row.metric,
    scorecardId: row.scorecard_id,
    comparison: row.comparison,
    threshold: Number(row.threshold),
    unit: unitOf(row, scorecard),
    windowMinutes: row.window_minutes,
    minSamples: row.min_samples,
    assistantId: row.assistant_id,
    phoneNumberId: row.phone_number_id,
    notify: { email: row.notify_email, userIds: row.notify_user_ids, webhookEndpointId: row.notify_webhook_endpoint_id },
    renotifyMinutes: row.renotify_minutes,
    status: { state: row.state, since: iso(row.state_since), lastValue: row.last_value === null ? null : Number(row.last_value), lastSample: row.last_sample, lastEvaluatedAt: iso(row.last_evaluated_at), lastNotifiedAt: iso(row.last_notified_at) },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

// ---------------------------------------------------------------- references

async function assertReferences(tx: Queryable, orgId: string, p: { scorecardId?: string | null; assistantId?: string | null; phoneNumberId?: string | null; notifyUserIds: string[]; webhookEndpointId?: string | null }): Promise<void> {
  const issues: { path: string; message: string }[] = [];
  if (p.scorecardId && !(await tx.query('SELECT 1 FROM scorecard WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL', [orgId, p.scorecardId])).rowCount) issues.push({ path: 'scorecardId', message: 'Scorecard not found' });
  if (p.assistantId && !(await tx.query('SELECT 1 FROM assistant WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL', [orgId, p.assistantId])).rowCount) issues.push({ path: 'assistantId', message: 'Assistant not found' });
  if (p.phoneNumberId && !(await tx.query('SELECT 1 FROM phone_number WHERE org_id = $1 AND id = $2', [orgId, p.phoneNumberId])).rowCount) issues.push({ path: 'phoneNumberId', message: 'Phone number not found' });
  if (p.notifyUserIds.length) {
    const members = new Set((await tx.query<{ user_id: string }>('SELECT user_id FROM membership WHERE org_id = $1 AND user_id = ANY ($2::uuid[])', [orgId, p.notifyUserIds])).rows.map((r) => r.user_id));
    p.notifyUserIds.forEach((id, i) => {
      if (!members.has(id)) issues.push({ path: `notify.userIds.${i}`, message: 'Only members of this organization can be notified' });
    });
  }
  if (p.webhookEndpointId) {
    const endpoint = (await tx.query<{ scope_type: string; enabled: boolean }>('SELECT scope_type, enabled FROM webhook_endpoint WHERE org_id = $1 AND id = $2', [orgId, p.webhookEndpointId])).rows[0];
    if (!endpoint) issues.push({ path: 'notify.webhookEndpointId', message: 'Webhook endpoint not found' });
    else if (endpoint.scope_type !== 'org') issues.push({ path: 'notify.webhookEndpointId', message: 'Use an organization-wide webhook endpoint' });
  }
  if (issues.length) throw new ApiError('validation_error', 'The request is invalid', { issues });
}

export async function getPolicy(tx: Queryable, orgId: string, id: string, options: { lock?: boolean } = {}): Promise<PolicyRow> {
  const row = (await tx.query<PolicyRow>(`SELECT ${POLICY_COLUMNS} FROM alert_policy WHERE org_id = $1 AND id = $2${options.lock ? ' FOR UPDATE' : ''}`, [orgId, id])).rows[0];
  if (!row) throw new ApiError('not_found', 'Alert policy not found');
  return row;
}

export async function scorecardSpecOf(tx: Queryable, orgId: string, scorecardId: string | null): Promise<ScorecardSpec | undefined> {
  if (!scorecardId) return undefined;
  return (await tx.query<{ spec: ScorecardSpec }>('SELECT spec FROM scorecard WHERE org_id = $1 AND id = $2', [orgId, scorecardId])).rows[0]?.spec;
}

export async function createPolicy(tx: Queryable, orgId: string, actor: Actor, input: z.infer<typeof policySchema>): Promise<PolicyRow> {
  await assertReferences(tx, orgId, { scorecardId: input.scorecardId, assistantId: input.assistantId, phoneNumberId: input.phoneNumberId, notifyUserIds: input.notify.userIds, webhookEndpointId: input.notify.webhookEndpointId });
  const id = newId();
  await tx.query(
    `INSERT INTO alert_policy (id, org_id, name, enabled, metric, scorecard_id, comparison, threshold, window_minutes, min_samples, assistant_id, phone_number_id, notify_email, notify_user_ids,
       notify_webhook_endpoint_id, renotify_minutes, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [id, orgId, input.name, input.enabled, input.metric, input.scorecardId ?? null, input.comparison, input.threshold, input.windowMinutes, input.minSamples, input.assistantId ?? null, input.phoneNumberId ?? null,
      input.notify.email, input.notify.userIds, input.notify.webhookEndpointId ?? null, input.renotifyMinutes, actor.type === 'user' ? actor.id : null]
  );
  return getPolicy(tx, orgId, id);
}

export async function updatePolicy(tx: Queryable, orgId: string, id: string, patch: z.infer<typeof policyPatchSchema>): Promise<PolicyRow> {
  const c = await getPolicy(tx, orgId, id, { lock: true });
  const metric = patch.metric ?? c.metric;
  const scorecardId = patch.scorecardId === undefined ? c.scorecard_id : patch.scorecardId;
  const issues: { path: string; message: string }[] = [];
  if ((metric === 'scorecard') !== (scorecardId !== null)) issues.push({ path: 'scorecardId', message: 'Give scorecardId with metric "scorecard", and only then' });
  const threshold = patch.threshold ?? Number(c.threshold);
  if ((metric === 'success_rate' || metric === 'error_rate') && (threshold < 0 || threshold > 100)) issues.push({ path: 'threshold', message: 'Rates are percentages between 0 and 100' });
  else if (metric !== 'scorecard' && metric !== 'success_rate' && metric !== 'error_rate' && threshold < 0) issues.push({ path: 'threshold', message: 'Must not be negative' });
  const email = patch.notify?.email ?? c.notify_email;
  const userIds = patch.notify?.userIds ?? c.notify_user_ids;
  const webhookEndpointId = patch.notify?.webhookEndpointId === undefined ? c.notify_webhook_endpoint_id : patch.notify.webhookEndpointId;
  if (!email && !webhookEndpointId) issues.push({ path: 'notify', message: 'Turn on email or give a webhook endpoint, or nobody would hear about it' });
  if (issues.length) throw new ApiError('validation_error', 'The request is invalid', { issues });
  const assistantId = patch.assistantId === undefined ? c.assistant_id : patch.assistantId;
  const phoneNumberId = patch.phoneNumberId === undefined ? c.phone_number_id : patch.phoneNumberId;
  await assertReferences(tx, orgId, { scorecardId, assistantId, phoneNumberId, notifyUserIds: userIds, webhookEndpointId });
  const next = { comparison: patch.comparison ?? c.comparison, windowMinutes: patch.windowMinutes ?? c.window_minutes, minSamples: patch.minSamples ?? c.min_samples };
  // A changed rule starts over: the old state described the old rule
  const ruleChanged = metric !== c.metric || scorecardId !== c.scorecard_id || next.comparison !== c.comparison || threshold !== Number(c.threshold) || next.windowMinutes !== c.window_minutes
    || next.minSamples !== c.min_samples || assistantId !== c.assistant_id || phoneNumberId !== c.phone_number_id;
  await tx.query(
    `UPDATE alert_policy SET name = $3, enabled = $4, metric = $5, scorecard_id = $6, comparison = $7, threshold = $8, window_minutes = $9, min_samples = $10, assistant_id = $11, phone_number_id = $12,
       notify_email = $13, notify_user_ids = $14, notify_webhook_endpoint_id = $15, renotify_minutes = $16,
       state = CASE WHEN $17 THEN 'unknown' ELSE state END, state_since = CASE WHEN $17 THEN NULL ELSE state_since END,
       last_value = CASE WHEN $17 THEN NULL ELSE last_value END, last_sample = CASE WHEN $17 THEN NULL ELSE last_sample END, last_evaluated_at = CASE WHEN $17 THEN NULL ELSE last_evaluated_at END,
       updated_at = now()
     WHERE org_id = $1 AND id = $2`,
    [orgId, id, patch.name ?? c.name, patch.enabled ?? c.enabled, metric, scorecardId, next.comparison, threshold, next.windowMinutes, next.minSamples, assistantId, phoneNumberId, email, userIds, webhookEndpointId,
      patch.renotifyMinutes ?? c.renotify_minutes, ruleChanged]
  );
  return getPolicy(tx, orgId, id);
}

// ---------------------------------------------------------------- evaluation

export type EvaluationStatus = 'breach' | 'ok' | 'no-data';

export interface Evaluation extends MetricResult {
  status: EvaluationStatus;
}

const breached = (policy: Pick<PolicyRow, 'comparison' | 'threshold'>, value: number) => (policy.comparison === 'lt' ? value < Number(policy.threshold) : value > Number(policy.threshold));

/** What the rule says right now, without recording or notifying anything. */
export async function evaluate(tx: Queryable, policy: PolicyRow, now: Date): Promise<Evaluation> {
  const filter: BoardFilter = {
    orgId: policy.org_id,
    from: new Date(now.getTime() - policy.window_minutes * 60_000),
    to: new Date(now.getTime() + 1000),
    ...(policy.assistant_id ? { assistantId: policy.assistant_id } : {}),
    ...(policy.phone_number_id ? { phoneNumberId: policy.phone_number_id } : {}),
  };
  const scorecard = await scorecardSpecOf(tx, policy.org_id, policy.scorecard_id);
  const result = await metricValue(tx, filter, policy.metric, scorecard);
  // A call-count rule is about the count itself, so a quiet window is a real reading, not missing data
  const enough = policy.metric === 'call_count' ? true : result.sample >= Math.max(1, policy.min_samples);
  if (result.value === null || !enough) return { ...result, status: 'no-data' };
  return { ...result, status: breached(policy, result.value) ? 'breach' : 'ok' };
}

export type Transition = 'fired' | 'reminder' | 'resolved' | null;

/**
 * Evaluate a policy, move its state, and (on a transition worth announcing) write the event and its
 * notifications. Runs in the org transaction with the policy row locked.
 */
export async function evaluateAndRecord(tx: Queryable, orgId: string, policyId: string, now: Date): Promise<{ evaluation: Evaluation; transition: Transition; policy: PolicyRow } | null> {
  const policy = (await tx.query<PolicyRow>(`SELECT ${POLICY_COLUMNS} FROM alert_policy WHERE org_id = $1 AND id = $2 AND enabled FOR UPDATE`, [orgId, policyId])).rows[0];
  if (!policy) return null;
  const evaluation = await evaluate(tx, policy, now);
  let transition: Transition = null;
  let state = policy.state;
  let stateSince = policy.state_since;
  if (evaluation.status === 'breach') {
    if (policy.state !== 'firing') {
      transition = 'fired';
      state = 'firing';
      stateSince = now;
    } else if (policy.renotify_minutes > 0 && policy.last_notified_at && now.getTime() - policy.last_notified_at.getTime() >= policy.renotify_minutes * 60_000) {
      transition = 'reminder';
    }
  } else if (evaluation.status === 'ok') {
    if (policy.state === 'firing') transition = 'resolved';
    if (policy.state !== 'ok') {
      state = 'ok';
      stateSince = now;
    }
  }
  await tx.query(
    `UPDATE alert_policy SET state = $3, state_since = $4::timestamptz, last_value = $5, last_sample = $6, last_evaluated_at = $7::timestamptz,
       last_notified_at = CASE WHEN $8 THEN $7::timestamptz ELSE last_notified_at END WHERE org_id = $1 AND id = $2`,
    [orgId, policyId, state, stateSince?.toISOString() ?? null, evaluation.value, evaluation.sample, now.toISOString(), transition !== null]
  );
  if (transition && evaluation.value !== null) await recordEvent(tx, policy, transition, evaluation.value, evaluation.sample, now);
  return { evaluation, transition, policy: { ...policy, state } };
}

async function recipients(tx: Queryable, policy: PolicyRow): Promise<string[]> {
  if (!policy.notify_email) return [];
  const rows = policy.notify_user_ids.length
    ? await tx.query<{ email: string }>(
        `SELECT u.email FROM membership m JOIN app_user u ON u.id = m.user_id WHERE m.org_id = $1 AND m.user_id = ANY ($2::uuid[]) AND u.email_verified_at IS NOT NULL ORDER BY u.email`,
        [policy.org_id, policy.notify_user_ids]
      )
    : await tx.query<{ email: string }>(`SELECT u.email FROM membership m JOIN app_user u ON u.id = m.user_id WHERE m.org_id = $1 AND m.role IN ('owner', 'admin') AND u.email_verified_at IS NOT NULL ORDER BY u.email`, [policy.org_id]);
  return rows.rows.map((r) => r.email);
}

async function recordEvent(tx: Queryable, policy: PolicyRow, type: Exclude<Transition, null>, value: number, sample: number, now: Date): Promise<void> {
  const eventId = newId();
  await tx.query(
    `INSERT INTO alert_event (id, org_id, policy_id, type, value, sample, metric, comparison, threshold, window_minutes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz)`,
    [eventId, policy.org_id, policy.id, type, value, sample, policy.metric, policy.comparison, policy.threshold, policy.window_minutes, now.toISOString()]
  );
  const targets: [string, string][] = (await recipients(tx, policy)).map((email) => ['email', email]);
  if (policy.notify_webhook_endpoint_id) targets.push(['webhook', policy.notify_webhook_endpoint_id]);
  for (const [channel, target] of targets) {
    await tx.query('INSERT INTO alert_notification (id, org_id, event_id, channel, target, next_attempt_at) VALUES ($1,$2,$3,$4,$5,$6::timestamptz) ON CONFLICT (event_id, channel, target) DO NOTHING', [newId(), policy.org_id, eventId, channel, target, now.toISOString()]);
  }
}

// ---------------------------------------------------------------- what a notification says

export const METRIC_LABELS: Record<PolicyMetric, string> = {
  success_rate: 'Success rate',
  error_rate: 'Error rate',
  latency_p50_ms: 'Voice-to-voice latency p50',
  latency_p95_ms: 'Voice-to-voice latency p95',
  latency_p99_ms: 'Voice-to-voice latency p99',
  call_count: 'Number of calls',
  avg_duration_ms: 'Average call duration',
  scorecard: 'Scorecard',
};

export function formatValue(value: number, unit: MetricResult['unit']): string {
  if (unit === 'percent') return `${value}%`;
  if (unit === 'ms') return `${value} ms`;
  return String(value);
}

export interface AlertSubject {
  eventId: string;
  type: 'fired' | 'reminder' | 'resolved';
  policyId: string;
  policyName: string;
  metric: PolicyMetric;
  scorecardName: string | null;
  comparison: 'lt' | 'gt';
  threshold: number;
  windowMinutes: number;
  value: number;
  sample: number;
  unit: MetricResult['unit'];
  assistantName: string | null;
  phoneNumber: string | null;
  at: Date;
}

const VERBS = { fired: 'is firing', reminder: 'is still firing', resolved: 'has recovered' } as const;

export function describeRule(a: AlertSubject): string {
  const metric = a.metric === 'scorecard' ? `Scorecard "${a.scorecardName ?? 'deleted'}"` : METRIC_LABELS[a.metric];
  return `${metric} ${a.comparison === 'lt' ? 'below' : 'above'} ${formatValue(a.threshold, a.unit)} over the last ${a.windowMinutes >= 60 && a.windowMinutes % 60 === 0 ? `${a.windowMinutes / 60} h` : `${a.windowMinutes} min`}`;
}

export function renderEmail(a: AlertSubject, dashboardUrl: string): { subject: string; text: string } {
  const label = { fired: 'ALERT', reminder: 'STILL FIRING', resolved: 'RESOLVED' }[a.type];
  const scope = [a.assistantName ? `Assistant: ${a.assistantName}` : null, a.phoneNumber ? `Number: ${a.phoneNumber}` : null].filter(Boolean);
  return {
    subject: `[Voice of Octo] ${label}: ${a.policyName}`,
    text: [
      `The monitoring policy "${a.policyName}" ${VERBS[a.type]}.`,
      '',
      `Rule: ${describeRule(a)}`,
      `Now: ${formatValue(a.value, a.unit)} (based on ${a.sample} ${a.metric.startsWith('latency') ? 'turns' : 'calls'})`,
      ...scope,
      `Time: ${a.at.toISOString()}`,
      '',
      `Details and history: ${dashboardUrl}/monitoring/policies/${a.policyId}`,
      '',
      a.type === 'fired' ? 'You will not get another message about this unless it recovers, or as a reminder if the policy has one.' : '',
    ]
      .filter((line, i, all) => line !== '' || all[i - 1] !== '')
      .join('\n'),
  };
}

export function webhookPayload(a: AlertSubject): Record<string, unknown> {
  return {
    id: `alert_${a.eventId}`,
    type: `alert.${a.type}`,
    createdAt: a.at.toISOString(),
    data: {
      policy: { id: a.policyId, name: a.policyName, metric: a.metric, scorecard: a.scorecardName, comparison: a.comparison, threshold: a.threshold, windowMinutes: a.windowMinutes },
      state: a.type === 'resolved' ? 'ok' : 'firing',
      value: a.value,
      sample: a.sample,
      unit: a.unit,
      description: describeRule(a),
    },
  };
}

/** Everything a notification says, from the event and the policy it came from. */
export async function loadSubject(tx: Queryable, orgId: string, eventId: string): Promise<AlertSubject | null> {
  const row = (
    await tx.query<{
      id: string; type: AlertSubject['type']; policy_id: string; name: string; metric: PolicyMetric; comparison: 'lt' | 'gt'; threshold: string; window_minutes: number; value: string; sample: number; created_at: Date;
      scorecard_name: string | null; scorecard_spec: ScorecardSpec | null; assistant_name: string | null; e164: string | null;
    }>(
      `SELECT e.id, e.type, e.policy_id, p.name, e.metric, e.comparison, e.threshold::text AS threshold, e.window_minutes, e.value::text AS value, e.sample, e.created_at,
              s.name AS scorecard_name, s.spec AS scorecard_spec, a.name AS assistant_name, n.e164
       FROM alert_event e JOIN alert_policy p ON p.id = e.policy_id AND p.org_id = e.org_id
       LEFT JOIN scorecard s ON s.id = p.scorecard_id AND s.org_id = p.org_id
       LEFT JOIN assistant a ON a.id = p.assistant_id AND a.org_id = p.org_id
       LEFT JOIN phone_number n ON n.id = p.phone_number_id AND n.org_id = p.org_id
       WHERE e.org_id = $1 AND e.id = $2`,
      [orgId, eventId]
    )
  ).rows[0];
  if (!row) return null;
  return {
    eventId: row.id,
    type: row.type,
    policyId: row.policy_id,
    policyName: row.name,
    metric: row.metric,
    scorecardName: row.scorecard_name,
    comparison: row.comparison,
    threshold: Number(row.threshold),
    windowMinutes: row.window_minutes,
    value: Number(row.value),
    sample: row.sample,
    unit: unitOf({ metric: row.metric }, row.scorecard_spec ?? undefined),
    assistantName: row.assistant_name,
    phoneNumber: row.e164,
    at: row.created_at,
  };
}
