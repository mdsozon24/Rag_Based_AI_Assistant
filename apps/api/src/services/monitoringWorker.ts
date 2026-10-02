/**
 * The monitoring worker: every tick it
 *  1. evaluates each enabled monitoring policy (org by org, one transaction per policy, so one bad
 *     policy cannot stop the others), writing alert events and queuing notifications;
 *  2. sends queued alert notifications (email to org members, signed webhook to the org's endpoint)
 *     with a lease and retries;
 *  3. about once an hour, deletes expired debug data (full LLM prompts and replies of calls that
 *     turned capture on, after DEBUG_RETENTION_DAYS).
 * Runs in the API process like the other workers (D51); two nodes cannot double-send because every
 * policy evaluation locks its row and every notification is claimed with FOR UPDATE SKIP LOCKED.
 */
import type { FastifyBaseLogger } from 'fastify';
import { guardedHttpClient, type HttpClient } from '../../../../packages/engine/src/providers/net.ts';
import type { AppContext } from '../context.ts';
import type { Queryable } from '../db/database.ts';
import { evaluateAndRecord, loadSubject, renderEmail, webhookPayload } from './alerts.ts';
import { decryptWebhookSecret, signWebhook } from './webhooks.ts';

const LEASE_MS = 2 * 60_000;
const BATCH = 25;
const SEND_TIMEOUT_MS = 10_000;
const PRUNE_EVERY_MS = 60 * 60_000;
export const MAX_NOTIFICATION_ATTEMPTS = 5;
/** Wait after the Nth failed attempt (index N-1). */
export const NOTIFICATION_BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000];

export interface MonitoringTick {
  evaluated: number;
  fired: number;
  reminders: number;
  resolved: number;
  noData: number;
  errors: number;
  sent: number;
  retried: number;
  dead: number;
  pruned: number;
}

interface Notification {
  id: string;
  event_id: string;
  channel: 'email' | 'webhook';
  target: string;
  attempts: number;
}

export class MonitoringWorker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private chain: Promise<unknown> = Promise.resolve();
  private lastPruneAt = 0;
  private readonly http: HttpClient;
  lastTickAt: Date | null = null;
  lastError: string | null = null;
  lastPruned = { at: null as Date | null, deleted: 0 };

  constructor(
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
    readonly now: () => Date = () => new Date(),
    http?: HttpClient
  ) {
    this.http = http ?? guardedHttpClient(ctx.voice.endpointPolicy);
  }

  get running(): boolean {
    return !this.stopped;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((err) => {
          this.lastError = err instanceof Error ? err.message : String(err);
          this.log.error({ err }, 'monitoring tick failed');
          this.ctx.errors.capture(err, { source: 'monitoring' });
        })
        .finally(() => this.schedule());
    }, this.ctx.config.monitoring.tickMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.chain.catch(() => undefined);
  }

  tick(): Promise<MonitoringTick> {
    const run = this.chain.then(() => this.runTick()).then((result) => ((this.lastTickAt = this.now()), result));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async runTick(): Promise<MonitoringTick> {
    const summary: MonitoringTick = { evaluated: 0, fired: 0, reminders: 0, resolved: 0, noData: 0, errors: 0, sent: 0, retried: 0, dead: 0, pruned: 0 };
    const now = this.now();
    // The only cross-org read: which orgs have policies or notifications to look at
    const orgs = (
      await this.ctx.db.query<{ org_id: string }>(
        `SELECT org_id FROM alert_policy WHERE enabled
         UNION SELECT org_id FROM alert_notification WHERE status IN ('pending', 'sending', 'failed') AND next_attempt_at <= $1::timestamptz`,
        [now.toISOString()]
      )
    ).rows;
    for (const { org_id: orgId } of orgs) {
      try {
        await this.evaluatePolicies(orgId, now, summary);
        await this.sendNotifications(orgId, now, summary);
      } catch (err) {
        summary.errors++;
        this.log.error({ err, org_id: orgId }, 'monitoring failed for an org; it is tried again next tick');
        this.ctx.errors.capture(err, { source: 'monitoring', orgId });
      }
    }
    if (now.getTime() - this.lastPruneAt >= PRUNE_EVERY_MS) {
      this.lastPruneAt = now.getTime();
      summary.pruned = await this.pruneDebugData(now);
    }
    this.lastError = null;
    return summary;
  }

  // ---------------------------------------------------------------- policies

  private async evaluatePolicies(orgId: string, now: Date, summary: MonitoringTick): Promise<void> {
    const ids = (await this.ctx.tenants.withOrg(orgId, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM alert_policy WHERE org_id = $1 AND enabled ORDER BY created_at, id', [orgId])).rows)).map((r) => r.id);
    for (const id of ids) {
      try {
        const result = await this.ctx.tenants.withOrg(orgId, (tx) => evaluateAndRecord(tx, orgId, id, now));
        if (!result) continue;
        summary.evaluated++;
        const { evaluation, transition, policy } = result;
        this.ctx.metrics.alertEvaluations.inc({ result: evaluation.status === 'breach' ? 'breach' : evaluation.status });
        if (evaluation.status === 'no-data') summary.noData++;
        if (transition === 'fired') summary.fired++;
        if (transition === 'reminder') summary.reminders++;
        if (transition === 'resolved') summary.resolved++;
        if (transition) this.log.info({ org_id: orgId, policy_id: id, transition, metric: policy.metric, value: evaluation.value, sample: evaluation.sample }, 'alert policy changed state');
      } catch (err) {
        summary.errors++;
        this.ctx.metrics.alertEvaluations.inc({ result: 'error' });
        this.log.error({ err, org_id: orgId, policy_id: id }, 'alert policy evaluation failed');
        this.ctx.errors.capture(err, { source: 'monitoring', orgId });
      }
    }
  }

  // ---------------------------------------------------------------- notifications

  private async claim(tx: Queryable, orgId: string, now: Date): Promise<Notification[]> {
    const nowIso = now.toISOString();
    const due = (
      await tx.query<Notification>(
        `SELECT id, event_id, channel, target, attempts FROM alert_notification
         WHERE org_id = $1 AND status IN ('pending', 'failed', 'sending') AND next_attempt_at <= $2::timestamptz
         ORDER BY next_attempt_at, id LIMIT $3 FOR UPDATE SKIP LOCKED`,
        [orgId, nowIso, BATCH]
      )
    ).rows;
    if (!due.length) return [];
    await tx.query(`UPDATE alert_notification SET status = 'sending', attempts = attempts + 1, next_attempt_at = $3::timestamptz + ($4::bigint * interval '1 millisecond') WHERE org_id = $1 AND id = ANY ($2::uuid[])`, [orgId, due.map((d) => d.id), nowIso, LEASE_MS]);
    return due.map((d) => ({ ...d, attempts: d.attempts + 1 }));
  }

  private async sendNotifications(orgId: string, now: Date, summary: MonitoringTick): Promise<void> {
    const jobs = await this.ctx.tenants.withOrg(orgId, (tx) => this.claim(tx, orgId, now));
    for (const job of jobs) {
      const log = this.log.child({ org_id: orgId, notification_id: job.id, channel: job.channel, attempt: job.attempts });
      let error: string | null = null;
      let final = false;
      try {
        const subject = await this.ctx.tenants.withOrg(orgId, (tx) => loadSubject(tx, orgId, job.event_id));
        if (!subject) {
          error = 'The alert event no longer exists';
          final = true;
        } else if (job.channel === 'email') {
          const mail = renderEmail(subject, this.ctx.config.dashboardUrl);
          await this.ctx.mailer.send({ to: job.target, subject: mail.subject, text: mail.text });
        } else {
          error = await this.sendWebhook(orgId, job.target, subject, this.now());
          final = error?.startsWith('The webhook endpoint') ?? false;
        }
      } catch (err) {
        error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      }
      const done = this.now();
      const dead = error !== null && (final || job.attempts >= MAX_NOTIFICATION_ATTEMPTS);
      const next = new Date(done.getTime() + (NOTIFICATION_BACKOFF_MS[job.attempts - 1] ?? NOTIFICATION_BACKOFF_MS.at(-1)!));
      await this.ctx.tenants.withOrg(orgId, (tx) =>
        tx.query(
          `UPDATE alert_notification SET status = $3, last_error = $4, sent_at = CASE WHEN $3 = 'sent' THEN $5::timestamptz ELSE sent_at END, next_attempt_at = $6::timestamptz WHERE org_id = $1 AND id = $2`,
          [orgId, job.id, error === null ? 'sent' : dead ? 'dead' : 'failed', error, done.toISOString(), next.toISOString()]
        )
      );
      const result = error === null ? 'sent' : dead ? 'dead' : 'failed';
      this.ctx.metrics.alertNotifications.inc({ channel: job.channel, result });
      if (error === null) summary.sent++;
      else if (dead) summary.dead++;
      else summary.retried++;
      if (error === null) log.info({}, 'alert notification sent');
      else log.warn({ error, dead }, dead ? 'alert notification gave up' : 'alert notification failed; will retry');
    }
  }

  /** POST the alert to the org's webhook endpoint. Returns an error message, or null when delivered. */
  private async sendWebhook(orgId: string, endpointId: string, subject: Parameters<typeof webhookPayload>[0], now: Date): Promise<string | null> {
    const endpoint = (
      await this.ctx.tenants.withOrg(orgId, async (tx) => (await tx.query<{ url: string; headers: Record<string, string>; secret_encrypted: Parameters<typeof decryptWebhookSecret>[1]; enabled: boolean }>('SELECT url, headers, secret_encrypted, enabled FROM webhook_endpoint WHERE org_id = $1 AND id = $2', [orgId, endpointId])).rows[0])
    );
    if (!endpoint) return 'The webhook endpoint was deleted';
    if (!endpoint.enabled) return 'The webhook endpoint is disabled';
    if (!this.ctx.toolCipher) return 'The webhook endpoint needs CREDENTIALS_ENCRYPTION_KEY to be signed';
    const payload = JSON.stringify(webhookPayload(subject));
    const secret = decryptWebhookSecret(this.ctx.toolCipher, endpoint.secret_encrypted, orgId, endpointId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const response = await this.http(endpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...endpoint.headers, 'x-octo-signature': signWebhook(secret, Math.floor(now.getTime() / 1000), payload), 'x-octo-event': `alert.${subject.type}`, 'x-octo-delivery': `alert_${subject.eventId}` },
        body: payload,
        signal: controller.signal,
      });
      await response.text().catch(() => undefined);
      return response.ok ? null : `HTTP ${response.status}`;
    } catch (err) {
      return controller.signal.aborted ? `No answer within ${SEND_TIMEOUT_MS / 1000} seconds` : err instanceof Error ? err.message.slice(0, 300) : 'delivery failed';
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------- retention

  /** Delete debug bodies older than the retention. Platform-wide maintenance, so it uses the owner connection. */
  async pruneDebugData(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.ctx.config.debug.retentionDays * 86_400_000);
    const deleted = (await this.ctx.db.query('DELETE FROM call_debug_body WHERE created_at < $1::timestamptz', [cutoff.toISOString()])).rowCount;
    this.lastPruned = { at: now, deleted };
    if (deleted) this.log.info({ deleted, retention_days: this.ctx.config.debug.retentionDays }, 'expired debug data deleted');
    return deleted;
  }
}
