/**
 * The analysis queue: one `call_analysis` row per call is both the job and its result.
 *
 * - Enqueued (idempotently) when a call ends; re-run on request.
 * - A tick claims due jobs per org with FOR UPDATE SKIP LOCKED and a lease (`locked_until`), so two
 *   nodes never run the same job, and a job whose worker died is picked up again when its lease ends.
 *   Each claim counts as an attempt, so a job that keeps killing its worker still ends as `failed`.
 * - The model calls run outside any transaction. Provider failures are retried with exponential
 *   backoff up to ANALYSIS_MAX_ATTEMPTS; whatever steps succeeded are kept and not repeated.
 * - When a job reaches a final state the end-of-call-report webhook is queued, once.
 * Runs in the API process (like the campaign dialer, D51); the same code can move to apps/worker.
 */
import type { FastifyBaseLogger } from 'fastify';
import { newId } from '../../auth/crypto.ts';
import type { AppContext } from '../../context.ts';
import type { Queryable } from '../../db/database.ts';
import { ApiError } from '../../http/errors.ts';
import { analyzeCall, type Outcome } from './analyzer.ts';
import { enqueueEndOfCallReport } from './report.ts';

/** Create the analysis job for a call that has ended (a second call does nothing). */
export async function enqueueAnalysis(tx: Queryable, orgId: string, callId: string, now: Date): Promise<void> {
  await tx.query('INSERT INTO call_analysis (id, org_id, call_id, next_attempt_at) VALUES ($1, $2, $3, $4::timestamptz) ON CONFLICT (call_id) DO NOTHING', [newId(), orgId, callId, now.toISOString()]);
}

/** Run the analysis again from scratch (results are replaced; the webhook is not sent twice). */
export async function rerunAnalysis(tx: Queryable, orgId: string, callId: string, now: Date): Promise<void> {
  const call = (await tx.query<{ status: string }>('SELECT status FROM call WHERE org_id = $1 AND id = $2', [orgId, callId])).rows[0];
  if (!call) throw new ApiError('not_found', 'Call not found');
  if (call.status !== 'ended' && call.status !== 'failed') throw new ApiError('conflict', 'The call has not ended yet', { status: call.status });
  const row = (await tx.query<{ status: string }>('SELECT status FROM call_analysis WHERE org_id = $1 AND call_id = $2 FOR UPDATE', [orgId, callId])).rows[0];
  if (row && (row.status === 'pending' || row.status === 'running')) throw new ApiError('conflict', 'The analysis is already queued or running', { status: row.status });
  if (!row) return enqueueAnalysis(tx, orgId, callId, now);
  await tx.query(
    `UPDATE call_analysis SET status = 'pending', skip_reason = NULL, attempts = 0, next_attempt_at = $3::timestamptz, locked_until = NULL, last_error = NULL, summary = NULL,
       success_rubric = NULL, success_passed = NULL, success_score = NULL, success_category = NULL, success_reason = NULL, steps = '{}', outputs = '{}', analysed_at = NULL, updated_at = now()
     WHERE org_id = $1 AND call_id = $2`,
    [orgId, callId, now.toISOString()]
  );
}

export interface AnalysisTick {
  claimed: number;
  succeeded: number;
  skipped: number;
  retried: number;
  failed: number;
}

interface Job {
  id: string;
  call_id: string;
  attempts: number;
}

export class AnalysisWorker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private chain: Promise<unknown> = Promise.resolve();
  lastTickAt: Date | null = null;
  lastError: string | null = null;

  get running(): boolean {
    return !this.stopped;
  }

  constructor(
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
    /** The clock for leases and backoff (tests move it). */
    readonly now: () => Date = () => new Date()
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((err) => this.log.error({ err }, 'analysis tick failed'))
        .finally(() => this.schedule());
    }, this.ctx.config.analysis.tickMs);
    this.timer.unref?.();
  }

  /** Stop ticking and wait for the jobs in progress (their results are saved before this returns). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.chain.catch(() => undefined);
  }

  /** One pass over every org with due jobs. Ticks never overlap. */
  tick(): Promise<AnalysisTick> {
    const run = this.chain.then(() => this.runTick()).then((result) => ((this.lastTickAt = this.now()), (this.lastError = null), result), (error) => { this.lastError = error instanceof Error ? error.message : String(error); throw error; });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async runTick(): Promise<AnalysisTick> {
    const summary: AnalysisTick = { claimed: 0, succeeded: 0, skipped: 0, retried: 0, failed: 0 };
    const now = this.now();
    // The only cross-org read: which orgs have due jobs. Everything after runs inside one org (RLS).
    const orgs = (
      await this.ctx.db.query<{ org_id: string }>(
        `SELECT DISTINCT org_id FROM call_analysis WHERE (status = 'pending' AND next_attempt_at <= $1::timestamptz) OR (status = 'running' AND locked_until <= $1::timestamptz)`,
        [now.toISOString()]
      )
    ).rows;
    for (const { org_id: orgId } of orgs) {
      try {
        const jobs = await this.ctx.tenants.withOrg(orgId, (tx) => this.claim(tx, orgId, now, summary));
        summary.claimed += jobs.length;
        const results = await Promise.all(jobs.map((job) => this.process(orgId, job)));
        for (const result of results) {
          summary[result]++;
          this.ctx.metrics.analysisJobs.inc({ result });
        }
      } catch (err) {
        this.log.error({ err, org_id: orgId }, 'analysis failed for an org; its jobs are retried');
        this.ctx.errors.capture(err, { source: 'analysis', orgId });
      }
    }
    return summary;
  }

  private async claim(tx: Queryable, orgId: string, now: Date, summary: AnalysisTick): Promise<Job[]> {
    const { maxAttempts, concurrency, leaseMs } = this.ctx.config.analysis;
    const nowIso = now.toISOString();
    // A job whose worker kept dying has used its attempts: it ends as failed instead of looping
    const exhausted = await tx.query<{ id: string }>(
      `UPDATE call_analysis SET status = 'failed', locked_until = NULL, last_error = 'The analysis worker stopped before finishing, repeatedly', updated_at = now()
       WHERE org_id = $1 AND status = 'running' AND locked_until <= $2::timestamptz AND attempts >= $3 RETURNING id`,
      [orgId, nowIso, maxAttempts]
    );
    for (const { id } of exhausted.rows) {
      summary.failed++;
      await enqueueEndOfCallReport(tx, orgId, id, now);
    }
    const due = (
      await tx.query<Job>(
        `SELECT id, call_id, attempts FROM call_analysis
         WHERE org_id = $1 AND ((status = 'pending' AND next_attempt_at <= $2::timestamptz) OR (status = 'running' AND locked_until <= $2::timestamptz))
         ORDER BY next_attempt_at, id LIMIT $3 FOR UPDATE SKIP LOCKED`,
        [orgId, nowIso, concurrency]
      )
    ).rows;
    if (!due.length) return [];
    await tx.query(
      `UPDATE call_analysis SET status = 'running', attempts = attempts + 1, locked_until = $3::timestamptz + ($4::bigint * interval '1 millisecond'), updated_at = now() WHERE org_id = $1 AND id = ANY ($2::uuid[])`,
      [orgId, due.map((j) => j.id), nowIso, leaseMs]
    );
    return due.map((j) => ({ ...j, attempts: j.attempts + 1 }));
  }

  /** Run one claimed job and record how it ended. */
  private async process(orgId: string, job: Job): Promise<'succeeded' | 'skipped' | 'retried' | 'failed'> {
    const log = this.log.child({ org_id: orgId, call_id: job.call_id, analysis_id: job.id, attempt: job.attempts });
    let outcome: Outcome;
    try {
      outcome = await analyzeCall(this.ctx, orgId, job.id, job.call_id, log);
    } catch (err) {
      log.error({ err }, 'analysis crashed');
      outcome = { kind: 'retry', error: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 900) };
    }
    const now = this.now();
    const { maxAttempts, retryBaseMs } = this.ctx.config.analysis;
    return this.ctx.tenants.withOrg(orgId, async (tx) => {
      if (outcome.kind === 'done') {
        await tx.query(
          `UPDATE call_analysis SET status = $3, skip_reason = $4, last_error = NULL, locked_until = NULL, analysed_at = $5::timestamptz, updated_at = now() WHERE org_id = $1 AND id = $2`,
          [orgId, job.id, outcome.skipped ? 'skipped' : 'succeeded', outcome.skipped ?? null, now.toISOString()]
        );
        await enqueueEndOfCallReport(tx, orgId, job.id, now);
        log.info({ skipped: outcome.skipped ?? null }, outcome.skipped ? 'call analysis skipped' : 'call analysis finished');
        return outcome.skipped ? ('skipped' as const) : ('succeeded' as const);
      }
      if (job.attempts >= maxAttempts) {
        await tx.query(`UPDATE call_analysis SET status = 'failed', last_error = $3, locked_until = NULL, updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, job.id, outcome.error]);
        await enqueueEndOfCallReport(tx, orgId, job.id, now);
        log.error({ error: outcome.error }, 'call analysis failed for good');
        return 'failed' as const;
      }
      // 30 s, 2 min, 8 min ... (x4 each time), at most an hour
      const delay = Math.min(60 * 60_000, retryBaseMs * 4 ** (job.attempts - 1));
      await tx.query(
        `UPDATE call_analysis SET status = 'pending', last_error = $3, locked_until = NULL, next_attempt_at = $4::timestamptz + ($5::bigint * interval '1 millisecond'), updated_at = now() WHERE org_id = $1 AND id = $2`,
        [orgId, job.id, outcome.error, now.toISOString(), delay]
      );
      log.warn({ error: outcome.error, retry_in_ms: delay }, 'call analysis will be retried');
      return 'retried' as const;
    });
  }
}
