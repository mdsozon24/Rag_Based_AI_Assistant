/**
 * Sends queued call events (end-of-call-report) to customer webhook endpoints, signed, with retries.
 *
 * - Only rows tied to a call (`call_id`) are sent here. Chat events stay queued for manual redelivery
 *   (owner decision, 2026-10-02): turning delivery on for them would start traffic to endpoints that
 *   have never received any.
 * - Requests go through the guarded HTTP client: https only, and connections to private, loopback and
 *   metadata addresses are refused at connect time (DNS rebinding included). The manual redeliver
 *   route does not have this guard.
 * - A claim counts as an attempt and holds a lease, so a crash mid-send is retried, and two nodes never
 *   send the same row. Failures back off 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h; the 8th failure is
 *   final (`dead`). Receivers should de-duplicate on the event `id`.
 */
import type { FastifyBaseLogger } from 'fastify';
import { guardedHttpClient, type HttpClient } from '../../../../packages/engine/src/providers/net.ts';
import type { AppContext } from '../context.ts';
import type { Queryable } from '../db/database.ts';
import { decryptWebhookSecret, signWebhook } from './webhooks.ts';

const SEND_TIMEOUT_MS = 10_000;
const LEASE_MS = 2 * 60_000;
const BATCH = 20;
export const MAX_DELIVERY_ATTEMPTS = 8;
/** Wait after the Nth failed attempt (index N-1). */
export const DELIVERY_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000];

interface DeliveryJob {
  id: string;
  endpoint_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

interface EndpointRow {
  id: string;
  url: string;
  headers: Record<string, string>;
  secret_encrypted: Parameters<typeof decryptWebhookSecret>[1];
  enabled: boolean;
}

export interface DeliveryTick {
  claimed: number;
  succeeded: number;
  retried: number;
  dead: number;
}

export class WebhookDeliveryWorker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly http: HttpClient;
  lastTickAt: Date | null = null;
  lastError: string | null = null;

  get running(): boolean {
    return !this.stopped;
  }

  constructor(
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
    readonly now: () => Date = () => new Date(),
    http?: HttpClient
  ) {
    this.http = http ?? guardedHttpClient(ctx.voice.endpointPolicy);
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
        .catch((err) => this.log.error({ err }, 'webhook delivery tick failed'))
        .finally(() => this.schedule());
    }, this.ctx.config.webhookDelivery.tickMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.chain.catch(() => undefined);
  }

  tick(): Promise<DeliveryTick> {
    const run = this.chain.then(() => this.runTick()).then((result) => ((this.lastTickAt = this.now()), (this.lastError = null), result), (error) => { this.lastError = error instanceof Error ? error.message : String(error); throw error; });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async runTick(): Promise<DeliveryTick> {
    const summary: DeliveryTick = { claimed: 0, succeeded: 0, retried: 0, dead: 0 };
    const nowIso = this.now().toISOString();
    // The only cross-org read: which orgs have due deliveries. Everything after runs inside one org (RLS).
    const orgs = (
      await this.ctx.db.query<{ org_id: string }>(
        `SELECT DISTINCT org_id FROM webhook_delivery WHERE call_id IS NOT NULL AND status IN ('pending', 'failed', 'delivering') AND next_attempt_at <= $1::timestamptz`,
        [nowIso]
      )
    ).rows;
    for (const { org_id: orgId } of orgs) {
      try {
        const jobs = await this.ctx.tenants.withOrg(orgId, (tx) => this.claim(tx, orgId, nowIso));
        summary.claimed += jobs.length;
        for (const result of await Promise.all(jobs.map((job) => this.send(orgId, job)))) {
          summary[result]++;
          this.ctx.metrics.webhookDeliveries.inc({ result: result === 'retried' ? 'failed' : result });
        }
      } catch (err) {
        this.log.error({ err, org_id: orgId }, 'webhook delivery failed for an org; its rows are retried');
        this.ctx.errors.capture(err, { source: 'webhook-delivery', orgId });
      }
    }
    return summary;
  }

  private async claim(tx: Queryable, orgId: string, nowIso: string): Promise<DeliveryJob[]> {
    const due = (
      await tx.query<DeliveryJob>(
        `SELECT id, endpoint_id, event_type, payload, attempts FROM webhook_delivery
         WHERE org_id = $1 AND call_id IS NOT NULL AND status IN ('pending', 'failed', 'delivering') AND next_attempt_at <= $2::timestamptz
         ORDER BY next_attempt_at, id LIMIT $3 FOR UPDATE SKIP LOCKED`,
        [orgId, nowIso, BATCH]
      )
    ).rows;
    if (!due.length) return [];
    await tx.query(
      `UPDATE webhook_delivery SET status = 'delivering', attempts = attempts + 1, next_attempt_at = $3::timestamptz + ($4::bigint * interval '1 millisecond') WHERE org_id = $1 AND id = ANY ($2::uuid[])`,
      [orgId, due.map((d) => d.id), nowIso, LEASE_MS]
    );
    return due.map((d) => ({ ...d, attempts: d.attempts + 1 }));
  }

  private async send(orgId: string, job: DeliveryJob): Promise<'succeeded' | 'retried' | 'dead'> {
    const log = this.log.child({ org_id: orgId, delivery_id: job.id, endpoint_id: job.endpoint_id, event_type: job.event_type, attempt: job.attempts });
    const endpoint = (
      await this.ctx.tenants.withOrg(orgId, async (tx) => (await tx.query<EndpointRow>('SELECT id, url, headers, secret_encrypted, enabled FROM webhook_endpoint WHERE org_id = $1 AND id = $2', [orgId, job.endpoint_id])).rows[0])
    );
    let status: number | null = null;
    let error: string | null = null;
    let body: string | null = null;
    let final = false;
    if (!endpoint || !endpoint.enabled) {
      error = !endpoint ? 'The webhook endpoint was deleted' : 'The webhook endpoint is disabled';
      final = true;
    } else if (!this.ctx.toolCipher) {
      error = 'Webhook secrets need CREDENTIALS_ENCRYPTION_KEY';
      final = true;
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      try {
        const payload = JSON.stringify(job.payload);
        const secret = decryptWebhookSecret(this.ctx.toolCipher, endpoint.secret_encrypted, orgId, endpoint.id);
        const response = await this.http(endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...endpoint.headers,
            'x-octo-signature': signWebhook(secret, Math.floor(this.now().getTime() / 1000), payload),
            'x-octo-event': job.event_type,
            'x-octo-delivery': job.id,
          },
          body: payload,
          signal: controller.signal,
        });
        status = response.status;
        if (!response.ok) {
          error = `HTTP ${response.status}`;
          body = (await response.text().catch(() => '')).slice(0, 500);
        } else {
          await response.text().catch(() => undefined);
        }
      } catch (err) {
        error = controller.signal.aborted ? `No answer within ${SEND_TIMEOUT_MS / 1000} seconds` : err instanceof Error ? err.message.slice(0, 300) : 'delivery failed';
      } finally {
        clearTimeout(timer);
      }
    }
    const now = this.now();
    const succeeded = !error && status !== null;
    const dead = !succeeded && (final || job.attempts >= MAX_DELIVERY_ATTEMPTS);
    const next = new Date(now.getTime() + (DELIVERY_BACKOFF_MS[job.attempts - 1] ?? DELIVERY_BACKOFF_MS.at(-1)!));
    await this.ctx.tenants.withOrg(orgId, (tx) =>
      tx.query(
        `UPDATE webhook_delivery SET status = $3, response_status = $4, last_error = $5, response_body = $6, delivered_at = CASE WHEN $3 = 'succeeded' THEN $7::timestamptz ELSE delivered_at END, next_attempt_at = $8::timestamptz
         WHERE org_id = $1 AND id = $2`,
        [orgId, job.id, succeeded ? 'succeeded' : dead ? 'dead' : 'failed', status, error, body, now.toISOString(), next.toISOString()]
      )
    );
    if (succeeded) log.info({ status }, 'webhook delivered');
    else log.warn({ status, error, dead }, dead ? 'webhook delivery gave up' : 'webhook delivery failed; will retry');
    return succeeded ? 'succeeded' : dead ? 'dead' : 'retried';
  }
}
