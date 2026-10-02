/**
 * Monitoring policies (org-defined alert rules), their alerts, and a dry-run. Reference:
 * docs/API.md ("Monitoring policies"). Evaluation and notification are the monitoring worker's job.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp } from '../auth/authenticate.ts';
import type { AppContext } from '../context.ts';
import { cursorClause, idParam, iso, pageRequest, parse, toPage } from '../http/validation.ts';
import { audit } from '../services/audit.ts';
import { createPolicy, evaluate, getPolicy, POLICY_COLUMNS, policyPatchSchema, policySchema, policyView, scorecardSpecOf, unitOf, updatePolicy, type PolicyRow } from '../services/alerts.ts';
import { scope } from './org.ts';

interface EventListRow {
  id: string;
  cursor_ts: string;
  policy_id: string;
  policy_name: string | null;
  type: string;
  value: string;
  sample: number;
  metric: string;
  comparison: string;
  threshold: string;
  window_minutes: number;
  created_at: Date;
}

export function registerMonitoringRoutes(app: FastifyInstance, ctx: AppContext): void {
  const view = async (tx: Parameters<typeof scorecardSpecOf>[0], row: PolicyRow) => policyView(row, await scorecardSpecOf(tx, row.org_id, row.scorecard_id));

  app.post('/v1/alert-policies', { config: { permission: 'monitoring:manage' } }, async (request, reply) => {
    const org = scope(request);
    const input = parse(policySchema, request.body);
    const body = await org.run(async (tx) => {
      const created = await createPolicy(tx, org.id, org.actor, input);
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'alert_policy.created', targetType: 'alert_policy', targetId: created.id, metadata: { name: created.name, metric: created.metric }, ip: clientIp(request) });
      return view(tx, created);
    });
    return reply.code(201).send(body);
  });

  app.get('/v1/alert-policies', { config: { permission: 'monitoring:read' } }, async (request) => {
    const org = scope(request);
    const page = pageRequest(request.query);
    const { state } = parse(z.object({ state: z.enum(['unknown', 'ok', 'firing']).optional() }), request.query);
    const cursor = cursorClause(page, state ? 4 : 3);
    return org.run(async (tx) => {
      const rows = (await tx.query<PolicyRow>(`SELECT ${POLICY_COLUMNS} FROM alert_policy WHERE org_id = $1${state ? ' AND state = $3' : ''}${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT $2`, [org.id, page.limit + 1, ...(state ? [state] : []), ...cursor.params])).rows;
      const shown = await Promise.all(rows.slice(0, page.limit).map((row) => view(tx, row)));
      return { ...toPage(rows, page.limit, (row) => row.id), data: shown };
    });
  });

  app.get('/v1/alert-policies/:id', { config: { permission: 'monitoring:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Alert policy');
    return org.run(async (tx) => view(tx, await getPolicy(tx, org.id, id)));
  });

  app.patch('/v1/alert-policies/:id', { config: { permission: 'monitoring:manage' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Alert policy');
    const patch = parse(policyPatchSchema, request.body);
    return org.run(async (tx) => {
      const row = await updatePolicy(tx, org.id, id, patch);
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'alert_policy.updated', targetType: 'alert_policy', targetId: id, metadata: { fields: Object.keys(patch) }, ip: clientIp(request) });
      return view(tx, row);
    });
  });

  app.delete('/v1/alert-policies/:id', { config: { permission: 'monitoring:manage' } }, async (request, reply) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Alert policy');
    await org.run(async (tx) => {
      await getPolicy(tx, org.id, id);
      await tx.query('DELETE FROM alert_policy WHERE org_id = $1 AND id = $2', [org.id, id]);
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'alert_policy.deleted', targetType: 'alert_policy', targetId: id, ip: clientIp(request) });
    });
    return reply.code(204).send();
  });

  /** What the rule says right now. Records and notifies nothing. */
  app.post('/v1/alert-policies/:id/test', { config: { permission: 'monitoring:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Alert policy');
    return org.run(async (tx) => {
      const policy = await getPolicy(tx, org.id, id);
      const result = await evaluate(tx, policy, ctx.monitoring.now());
      return { policyId: id, status: result.status, value: result.value, sample: result.sample, unit: unitOf(policy, await scorecardSpecOf(tx, org.id, policy.scorecard_id)), threshold: Number(policy.threshold), comparison: policy.comparison, windowMinutes: policy.window_minutes, minSamples: policy.min_samples };
    });
  });

  /** Alerts (fired, reminders, resolved) with who was told and whether it worked. */
  app.get('/v1/alert-events', { config: { permission: 'monitoring:read' } }, async (request) => {
    const org = scope(request);
    const page = pageRequest(request.query);
    const { policyId, type } = parse(z.object({ policyId: z.string().uuid().optional(), type: z.enum(['fired', 'reminder', 'resolved']).optional() }), request.query);
    const params: unknown[] = [org.id, page.limit + 1];
    const where = ['e.org_id = $1'];
    if (policyId) where.push(`e.policy_id = $${params.push(policyId)}`);
    if (type) where.push(`e.type = $${params.push(type)}`);
    const cursor = cursorClause(page, params.length + 1, 'e');
    params.push(...cursor.params);
    return org.run(async (tx) => {
      const rows = (
        await tx.query<EventListRow>(
          `SELECT e.id, e.created_at::text AS cursor_ts, e.policy_id, p.name AS policy_name, e.type, e.value::text AS value, e.sample, e.metric, e.comparison, e.threshold::text AS threshold, e.window_minutes, e.created_at
           FROM alert_event e LEFT JOIN alert_policy p ON p.id = e.policy_id AND p.org_id = e.org_id
           WHERE ${where.join(' AND ')}${cursor.sql} ORDER BY e.created_at DESC, e.id DESC LIMIT $2`,
          params
        )
      ).rows;
      const shown = rows.slice(0, page.limit).map((r) => r.id);
      const notifications = shown.length
        ? (await tx.query<{ event_id: string; channel: string; target: string; status: string; attempts: number; last_error: string | null; sent_at: Date | null }>('SELECT event_id, channel, target, status, attempts, last_error, sent_at FROM alert_notification WHERE org_id = $1 AND event_id = ANY ($2::uuid[]) ORDER BY channel, target', [org.id, shown])).rows
        : [];
      return toPage(rows, page.limit, (r) => ({
        id: r.id,
        policyId: r.policy_id,
        policyName: r.policy_name,
        type: r.type,
        value: Number(r.value),
        sample: r.sample,
        rule: { metric: r.metric, comparison: r.comparison, threshold: Number(r.threshold), windowMinutes: r.window_minutes },
        createdAt: iso(r.created_at),
        notifications: notifications.filter((n) => n.event_id === r.id).map((n) => ({ channel: n.channel, target: n.target, status: n.status, attempts: n.attempts, error: n.last_error, sentAt: iso(n.sent_at) })),
      }));
    });
  });
}
