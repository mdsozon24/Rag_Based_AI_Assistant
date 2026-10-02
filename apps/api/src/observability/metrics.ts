/**
 * Prometheus metrics for the platform (served at GET /metrics for the operator's scraper).
 *
 * Names are prefixed octo_. Labels are kept to bounded sets (provider, model, stage, reason, queue):
 * never org ids, call ids or numbers, which would grow without limit and would put customer
 * identifiers in the operator's monitoring system. Per-org numbers come from the boards API.
 *
 * Latency is recorded as histograms, so p50/p95/p99 per provider come from the scraper:
 *   histogram_quantile(0.95, sum by (le, provider) (rate(octo_turn_latency_seconds_bucket{stage="llm_first_token"}[5m])))
 * `voice_to_voice` is labelled with the provider stack ("stt+llm+tts"), since it is the sum of all three.
 * Provider error rate: rate(octo_provider_errors_total) / rate(octo_provider_requests_total) by stage and provider.
 */
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Database } from '../db/database.ts';

/** Seconds: from a voice turn's few hundred milliseconds up to a stalled provider. */
const LATENCY_BUCKETS = [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10];

export type LatencyStage = 'stt_final' | 'llm_first_token' | 'tts_first_byte' | 'voice_to_voice';

export interface MetricsSources {
  db: Database;
  /** Live browser sessions on this process. */
  liveSessions: () => number;
}

export class Metrics {
  readonly registry = new Registry();

  readonly callsStarted = new Counter({ name: 'octo_calls_started_total', help: 'Calls started', labelNames: ['type', 'direction'] as const, registers: [this.registry] });
  readonly callsEnded = new Counter({ name: 'octo_calls_ended_total', help: 'Calls ended, by end reason', labelNames: ['reason', 'type'] as const, registers: [this.registry] });
  readonly turnLatency = new Histogram({
    name: 'octo_turn_latency_seconds',
    help: 'Latency of a voice turn by stage and provider (voice_to_voice: end of caller speech to first agent audio)',
    labelNames: ['stage', 'provider', 'model'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });
  readonly providerRequests = new Counter({ name: 'octo_provider_requests_total', help: 'Requests made to providers during calls', labelNames: ['stage', 'provider'] as const, registers: [this.registry] });
  readonly providerErrors = new Counter({ name: 'octo_provider_errors_total', help: 'Provider failures during calls (failed: the call failed over; fallback: the next provider took over)', labelNames: ['stage', 'provider', 'kind'] as const, registers: [this.registry] });
  readonly webhookDeliveries = new Counter({ name: 'octo_webhook_deliveries_total', help: 'Customer webhook delivery attempts by result', labelNames: ['result'] as const, registers: [this.registry] });
  readonly analysisJobs = new Counter({ name: 'octo_analysis_jobs_total', help: 'Call analysis jobs by result', labelNames: ['result'] as const, registers: [this.registry] });
  readonly alertEvaluations = new Counter({ name: 'octo_alert_evaluations_total', help: 'Monitoring policy evaluations by outcome', labelNames: ['result'] as const, registers: [this.registry] });
  readonly alertNotifications = new Counter({ name: 'octo_alert_notifications_total', help: 'Alert notifications by channel and result', labelNames: ['channel', 'result'] as const, registers: [this.registry] });
  readonly errors = new Counter({ name: 'octo_errors_total', help: 'Unexpected errors captured, by source', labelNames: ['source'] as const, registers: [this.registry] });
  readonly httpDuration = new Histogram({
    name: 'octo_http_request_duration_seconds',
    help: 'API request duration by route pattern',
    labelNames: ['method', 'route', 'status_class'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly buildInfo = new Gauge({ name: 'octo_build_info', help: 'Version of this process (always 1)', labelNames: ['version'] as const, registers: [this.registry] });
  private readonly concurrent: Gauge;
  private readonly live: Gauge;
  private readonly queues: Gauge<'queue' | 'state'>;

  constructor(version: string, public sources?: MetricsSources) {
    collectDefaultMetrics({ register: this.registry, prefix: 'octo_' });
    this.buildInfo.set({ version }, 1);
    const sourcesRef = () => this.sources;
    this.concurrent = new Gauge({
      name: 'octo_calls_concurrent',
      help: 'Calls ringing or in progress, platform-wide',
      registers: [this.registry],
      async collect() {
        const s = sourcesRef();
        if (!s) return;
        this.set(Number((await s.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM call WHERE status IN ('ringing', 'in-progress')`)).rows[0].n));
      },
    });
    this.live = new Gauge({
      name: 'octo_live_sessions',
      help: 'Browser call sessions running on this process',
      registers: [this.registry],
      collect() {
        const s = sourcesRef();
        if (s) this.set(s.liveSessions());
      },
    });
    this.queues = new Gauge({
      name: 'octo_queue_depth',
      help: 'Work waiting in each queue (pending: due or waiting; dead: given up and not retried)',
      labelNames: ['queue', 'state'] as const,
      registers: [this.registry],
      async collect() {
        const s = sourcesRef();
        if (!s) return;
        this.reset();
        for (const row of (await s.db.query<{ queue: string; state: string; n: number }>(queueDepthSql)).rows) this.set({ queue: row.queue, state: row.state }, row.n);
      },
    });
  }

  /** Prometheus text exposition format. */
  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  /** Reads a counter's labelled values (tests and the admin status). */
  async counterValues(name: string): Promise<{ labels: Record<string, string>; value: number }[]> {
    const metric = this.registry.getSingleMetric(name);
    if (!metric) return [];
    return (await metric.get()).values.map((v) => ({ labels: v.labels as Record<string, string>, value: v.value }));
  }
}

/** Queue depth for every background queue, in one statement (platform-wide; the owner connection reads it). */
export const queueDepthSql = `
  SELECT 'analysis' AS queue, status AS state, count(*)::int AS n FROM call_analysis WHERE status IN ('pending', 'running', 'failed') GROUP BY status
  UNION ALL SELECT 'webhook_delivery', status, count(*)::int FROM webhook_delivery WHERE status IN ('pending', 'delivering', 'failed', 'dead') GROUP BY status
  UNION ALL SELECT 'alert_notification', status, count(*)::int FROM alert_notification WHERE status IN ('pending', 'sending', 'failed', 'dead') GROUP BY status
  UNION ALL SELECT 'campaign_contact', 'pending', count(*)::int FROM campaign_contact k JOIN campaign c ON c.id = k.campaign_id AND c.org_id = k.org_id WHERE k.status = 'pending' AND c.status = 'running'
  UNION ALL SELECT 'campaign_attempt', 'in_flight', count(*)::int FROM campaign_attempt WHERE status IN ('claimed', 'dialing', 'ringing', 'in-progress')`;
