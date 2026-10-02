/**
 * The campaign dialer: a Postgres-backed queue that places outbound calls without ever dialing a
 * contact attempt twice.
 *
 * One tick, per org with work:
 *  1. reconcile: release claims nobody dialed, close dials that never reported back (unconfirmed) and
 *     calls that never ended (lost), so slots and contacts are never stuck after a crash;
 *  2. claim (one transaction, serialized per org): pick due contacts, check do-not-call and the
 *     schedule in the contact's time zone, respect the campaign and org concurrency limits and the
 *     calls-per-minute pacing, then mark the contact "calling" and insert the attempt row. The unique
 *     (contact, attempt number) constraint makes a second claim of the same attempt impossible;
 *  3. dial each claim: re-check campaign state, do-not-call and hours immediately before the provider
 *     request (a hard block, not only a filter), create the call row, then call the provider with a
 *     timeout. The provider request is never inside a database transaction;
 *  4. provider events (routes/campaigns.ts) and the reconcile step finish attempts through
 *     finishAttempt, which applies the retry rules.
 *
 * Guarantee: at most one provider dial per attempt. A crash before the dial leaves a "claimed" row that
 * is released; a crash during or after leaves "dialing", which becomes "unconfirmed" and is not retried
 * (a retry could ring someone who already picked up).
 */
import type { FastifyBaseLogger } from 'fastify';
import { TelephonyDialError, type OutboundCallRequest } from '../../../../../packages/engine/src/telephony/types.ts';
import { newId } from '../../auth/crypto.ts';
import type { AppContext } from '../../context.ts';
import type { Queryable } from '../../db/database.ts';
import { ApiError } from '../../http/errors.ts';
import { finishAttempt } from './attempts.ts';
import { activeNumbers, callConfig, campaignSchedule, pauseForReason, resolveTarget, type CampaignRow, type PhoneRow, CAMPAIGN_SELECT } from './campaigns.ts';
import { isOnDnc, listedNumbers } from './dnc.ts';
import { providerUsable } from './providers.ts';
import type { AttemptOutcome } from './outcome.ts';
import { checkAllowed, nextAllowedAt, scheduleEnded } from './schedule.ts';

interface ContactRow {
  id: string;
  e164: string;
  name: string | null;
  time_zone: string;
  variables: Record<string, string>;
  attempts: number;
}

export interface Claim {
  orgId: string;
  attemptId: string;
  callId: string;
  attemptNo: number;
  campaign: CampaignRow;
  contact: ContactRow;
  phone: PhoneRow;
}

export interface TickSummary {
  orgs: number;
  claimed: number;
  dialed: number;
  released: number;
}

/** Claims that were stale (nobody dialed them) after this long are released. */
const STALE_CLAIM_MS = 60_000;
const PACING_WINDOW_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class CampaignDialer {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private chain: Promise<unknown> = Promise.resolve();
  lastTickAt: Date | null = null;
  lastError: string | null = null;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
    /** The clock for every schedule, pacing and retry decision (routes use it too, so tests can move it). */
    readonly now: () => Date = () => new Date()
  ) {}

  get running(): boolean {
    return !this.stopped;
  }

  /** Start ticking in the background (the API server does this when CAMPAIGN_DIALER_ENABLED). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((err) => this.log.error({ err }, 'campaign dialer tick failed'))
        .finally(() => this.schedule());
    }, this.ctx.config.campaigns.tickMs);
    this.timer.unref?.();
  }

  /** Stop ticking and wait for the work in progress (dials already sent are recorded before returning). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.chain.catch(() => undefined);
    await Promise.allSettled([...this.inflight]);
  }

  /** One pass over every org with running campaigns or calls in flight. Ticks never overlap. */
  tick(): Promise<TickSummary> {
    const run = this.chain.then(() => this.runTick()).then((result) => ((this.lastTickAt = this.now()), (this.lastError = null), result), (error) => { this.lastError = error instanceof Error ? error.message : String(error); throw error; });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async runTick(): Promise<TickSummary> {
    const summary: TickSummary = { orgs: 0, claimed: 0, dialed: 0, released: 0 };
    // The only cross-org read: which orgs have work. Everything after runs inside one org (RLS).
    const orgs = (
      await this.ctx.db.query<{ org_id: string }>(
        `SELECT org_id FROM campaign WHERE status = 'running'
         UNION SELECT org_id FROM campaign_attempt WHERE status IN ('claimed', 'dialing', 'ringing', 'in-progress')`
      )
    ).rows;
    for (const { org_id: orgId } of orgs) {
      summary.orgs++;
      try {
        const now = this.now();
        await this.ctx.tenants.withOrg(orgId, (tx) => this.reconcile(tx, orgId, now));
        const claims = await this.ctx.tenants.withOrg(orgId, (tx) => this.claim(tx, orgId, now));
        summary.claimed += claims.length;
        const results = await this.dialClaims(claims);
        for (const dialed of results) dialed ? summary.dialed++ : summary.released++;
        await this.ctx.tenants.withOrg(orgId, (tx) => this.closeFinished(tx, orgId, this.now()));
      } catch (err) {
        this.log.error({ err, org_id: orgId }, 'campaign dialer failed for an org; it is retried next tick');
        this.ctx.errors.capture(err, { source: 'dialer', orgId });
      }
    }
    return summary;
  }

  /** Dial claims in parallel. Each is re-checked first; true = a provider dial was made, false = released. */
  dialClaims(claims: Claim[]): Promise<boolean[]> {
    return Promise.all(claims.map((claim) => this.track(this.dial(claim))));
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inflight.add(promise);
    void promise.then(() => this.inflight.delete(promise), () => this.inflight.delete(promise));
    return promise;
  }

  // ---------------------------------------------------------------- reconcile

  /** Make sure nothing is stuck after a crash, a lost callback or a stopped worker. */
  async reconcile(tx: Queryable, orgId: string, now: Date): Promise<void> {
    const cfg = this.ctx.config.campaigns;
    const staleClaims = (
      await tx.query<{ id: string }>(`SELECT id FROM campaign_attempt WHERE org_id = $1 AND status = 'claimed' AND claimed_at < $2::timestamptz FOR UPDATE SKIP LOCKED`, [orgId, new Date(now.getTime() - STALE_CLAIM_MS).toISOString()])
    ).rows;
    for (const { id } of staleClaims) {
      if (await this.release(tx, orgId, id, { reason: 'stale-claim' })) this.log.warn({ org_id: orgId, attempt_id: id }, 'released a claim nobody dialed (the dialer stopped before the provider request)');
    }
    const unconfirmed = (
      await tx.query<{ id: string }>(`SELECT id FROM campaign_attempt WHERE org_id = $1 AND status = 'dialing' AND dialed_at < $2::timestamptz`, [orgId, new Date(now.getTime() - cfg.dialConfirmMs).toISOString()])
    ).rows;
    for (const { id } of unconfirmed) {
      await finishAttempt(tx, { orgId, attemptId: id, outcome: 'unconfirmed', now, error: 'No confirmation from the provider after the dial request' }, this.log, this.ctx.metrics);
    }
    const lost = (
      await tx.query<{ id: string }>(`SELECT id FROM campaign_attempt WHERE org_id = $1 AND status IN ('ringing', 'in-progress') AND dialed_at < $2::timestamptz`, [orgId, new Date(now.getTime() - cfg.callTimeoutMs).toISOString()])
    ).rows;
    for (const { id } of lost) {
      await finishAttempt(tx, { orgId, attemptId: id, outcome: 'lost', now, error: 'No final event from the provider' }, this.log, this.ctx.metrics);
    }
  }

  /**
   * Take back a claim that was not dialed. The attempt is not counted: the contact goes back to
   * `contactStatus` (default pending) with its attempt counter restored.
   */
  private async release(tx: Queryable, orgId: string, attemptId: string, options: { reason: string; contactStatus?: 'pending' | 'do_not_call' | 'expired'; nextAttemptAt?: Date | null }): Promise<boolean> {
    const released = await tx.query<{ contact_id: string }>(
      `UPDATE campaign_attempt SET status = 'skipped', error = $3 WHERE org_id = $1 AND id = $2 AND status = 'claimed' RETURNING contact_id`,
      [orgId, attemptId, options.reason]
    );
    if (!released.rows[0]) return false;
    await tx.query(
      `UPDATE campaign_contact SET status = $3, attempts = GREATEST(attempts - 1, 0), next_attempt_at = $4::timestamptz,
         last_outcome = CASE WHEN $3 = 'pending' THEN last_outcome WHEN $3 = 'do_not_call' THEN 'do-not-call' ELSE 'schedule-ended' END, updated_at = now()
       WHERE org_id = $1 AND id = $2 AND status = 'calling'`,
      [orgId, released.rows[0].contact_id, options.contactStatus ?? 'pending', options.nextAttemptAt?.toISOString() ?? null]
    );
    return true;
  }

  // ---------------------------------------------------------------- claim

  async claim(tx: Queryable, orgId: string, now: Date): Promise<Claim[]> {
    const cfg = this.ctx.config.campaigns;
    // One claimer per org at a time, so the concurrency counts below cannot be raced by another node
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`campaign-claim:${orgId}`]);
    const campaigns = (await tx.query<CampaignRow>(`${CAMPAIGN_SELECT} WHERE c.org_id = $1 AND c.status = 'running' ORDER BY c.started_at, c.id`, [orgId])).rows;
    if (!campaigns.length) return [];

    const orgActive =
      Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM call WHERE org_id = $1 AND status IN ('queued', 'ringing', 'in-progress')`, [orgId])).rows[0].n) +
      Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM campaign_attempt WHERE org_id = $1 AND status = 'claimed'`, [orgId])).rows[0].n);
    let orgSlots = this.ctx.telephony.maxConcurrentCalls - orgActive;

    const claims: Claim[] = [];
    for (const campaign of campaigns) {
      if (orgSlots <= 0) break;
      const numbers = await activeNumbers(tx, orgId, campaign.id);
      if (!numbers.length) {
        await pauseForReason(tx, orgId, campaign.id, 'no-active-phone-number');
        this.log.warn({ org_id: orgId, campaign_id: campaign.id }, 'campaign paused: none of its phone numbers can place calls');
        continue;
      }
      const counts = (
        await tx.query<{ active: string; recent: string; total: string }>(
          `SELECT count(*) FILTER (WHERE status IN ('claimed', 'dialing', 'ringing', 'in-progress'))::text AS active,
                  count(*) FILTER (WHERE status <> 'skipped' AND claimed_at > $3::timestamptz)::text AS recent,
                  count(*) FILTER (WHERE status <> 'skipped')::text AS total
           FROM campaign_attempt WHERE org_id = $1 AND campaign_id = $2`,
          [orgId, campaign.id, new Date(now.getTime() - PACING_WINDOW_MS).toISOString()]
        )
      ).rows[0];
      // Spread the minute's budget over the ticks instead of dialing it all at once
      const perTick = Math.max(1, Math.ceil((campaign.calls_per_minute * cfg.tickMs) / 60_000));
      const slots = Math.min(campaign.max_concurrent_calls - Number(counts.active), campaign.calls_per_minute - Number(counts.recent), perTick, orgSlots);
      if (slots <= 0) continue;

      const scan = Math.min(500, slots * 10 + 50);
      const candidates = (
        await tx.query<ContactRow>(
          `SELECT id, e164, name, time_zone, variables, attempts FROM campaign_contact
           WHERE org_id = $1 AND campaign_id = $2 AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $3::timestamptz)
           ORDER BY next_attempt_at NULLS FIRST, id LIMIT $4 FOR UPDATE SKIP LOCKED`,
          [orgId, campaign.id, now.toISOString(), scan]
        )
      ).rows;
      const listed = await listedNumbers(tx, orgId, candidates.map((c) => c.e164));
      const schedule = campaignSchedule(campaign);
      let rotation = Number(counts.total);
      let taken = 0;
      for (const contact of candidates) {
        if (taken >= slots) break;
        if (listed.has(contact.e164)) {
          await tx.query(`UPDATE campaign_contact SET status = 'do_not_call', next_attempt_at = NULL, last_outcome = 'do-not-call', updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, contact.id]);
          continue;
        }
        const allowed = checkAllowed(now, contact.time_zone, schedule, cfg.hardCap);
        if (!allowed.allowed) {
          const next = nextAllowedAt(now, contact.time_zone, schedule, cfg.hardCap);
          if (next) await tx.query('UPDATE campaign_contact SET next_attempt_at = $3::timestamptz, updated_at = now() WHERE org_id = $1 AND id = $2', [orgId, contact.id, next.toISOString()]);
          else await tx.query(`UPDATE campaign_contact SET status = 'expired', next_attempt_at = NULL, last_outcome = 'schedule-ended', updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, contact.id]);
          continue;
        }
        const phone = numbers[rotation++ % numbers.length];
        const attemptId = newId();
        const callId = newId();
        const attemptNo = contact.attempts + 1;
        await tx.query(`UPDATE campaign_contact SET status = 'calling', attempts = attempts + 1, next_attempt_at = NULL, updated_at = now() WHERE org_id = $1 AND id = $2 AND status = 'pending'`, [orgId, contact.id]);
        await tx.query(
          `INSERT INTO campaign_attempt (id, org_id, campaign_id, contact_id, attempt_no, status, call_id, phone_number_id, claimed_at)
           VALUES ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8::timestamptz)`,
          [attemptId, orgId, campaign.id, contact.id, attemptNo, callId, phone.id, now.toISOString()]
        );
        claims.push({ orgId, attemptId, callId, attemptNo, campaign, contact, phone });
        taken++;
        orgSlots--;
      }
    }
    return claims;
  }

  // ---------------------------------------------------------------- dial

  private credentialsFor(provider: PhoneRow['provider']): Record<string, string> | null {
    if (!providerUsable(this.ctx.config.env, provider)) return null;
    if (provider !== 'twilio') return {};
    const { accountSid, authToken, apiUrl } = this.ctx.config.twilio;
    return accountSid && authToken ? { accountSid, authToken, apiUrl: apiUrl ?? 'https://api.twilio.com' } : null;
  }

  /** Returns true when a provider dial was made, false when the claim was released instead. */
  private async dial(claim: Claim): Promise<boolean> {
    const { orgId, campaign, contact, phone } = claim;
    const log = this.log.child({ org_id: orgId, campaign_id: campaign.id, contact_id: contact.id, attempt_id: claim.attemptId, call_id: claim.callId, attempt_no: claim.attemptNo });
    const publicUrl = this.ctx.config.publicUrl;
    const request: OutboundCallRequest = {
      to: contact.e164,
      from: { id: phone.id, provider: phone.provider, providerNumberId: phone.provider_number_id, e164: phone.e164, capabilities: phone.capabilities },
      streamUrl: `${publicUrl.replace(/^http/, 'ws')}/v1/telephony/${phone.provider}/media/${claim.callId}`,
      voicemailDetection: true,
      statusCallbackUrl: `${publicUrl}/v1/telephony/${phone.provider}/status/${claim.attemptId}`,
    };

    let ready: boolean;
    try {
      ready = await this.ctx.tenants.withOrg(orgId, (tx) => this.prepare(tx, claim, log));
    } catch (err) {
      // Nothing was dialed; the stale claim is released on a later tick if this release fails too
      log.error({ err }, 'could not prepare the dial; releasing the claim');
      await this.ctx.tenants.withOrg(orgId, (tx) => this.release(tx, orgId, claim.attemptId, { reason: 'prepare-failed' })).catch(() => undefined);
      return false;
    }
    if (!ready) return false;

    const adapter = this.ctx.telephony.adapters[phone.provider];
    const credentials = this.credentialsFor(phone.provider) ?? {};
    try {
      const started = await withTimeout(adapter.startOutbound(request, credentials), this.ctx.config.campaigns.dialTimeoutMs, () => new TelephonyDialError('The provider did not answer the dial request in time', 'maybe'));
      await this.ctx.tenants.withOrg(orgId, async (tx) => {
        await tx.query(
          `UPDATE campaign_attempt SET status = CASE WHEN status = 'dialing' THEN CASE WHEN $3 = 'in-progress' THEN 'in-progress' ELSE 'ringing' END ELSE status END, provider_call_id = coalesce(provider_call_id, $4)
           WHERE org_id = $1 AND id = $2`,
          [orgId, claim.attemptId, started.status, started.providerCallId]
        );
        await tx.query(
          `UPDATE call SET provider_call_id = coalesce(provider_call_id, $3), status = CASE WHEN status = 'queued' THEN CASE WHEN $4 = 'in-progress' THEN 'in-progress' ELSE 'ringing' END ELSE status END WHERE org_id = $1 AND id = $2`,
          [orgId, claim.callId, started.providerCallId, started.status]
        );
        // Adapters that learn the result at once (an answering machine, a refused call)
        if (started.status === 'ended' || started.status === 'failed') {
          await finishAttempt(tx, { orgId, attemptId: claim.attemptId, outcome: started.status === 'ended' ? 'voicemail' : 'failed', now: this.now(), providerCallId: started.providerCallId }, log, this.ctx.metrics);
        }
      });
      log.info({ provider: phone.provider, provider_call_id: started.providerCallId }, 'campaign call dialed');
    } catch (err) {
      const { outcome, message } = classifyDialError(err);
      log.warn({ err, outcome }, 'campaign dial failed');
      await this.ctx.tenants.withOrg(orgId, (tx) => finishAttempt(tx, { orgId, attemptId: claim.attemptId, outcome, now: this.now(), error: message }, log, this.ctx.metrics));
    }
    return true;
  }

  /**
   * The last check before the provider request, with a fresh clock and fresh data: the campaign must
   * still be running, the number off the do-not-call list, and the contact inside its calling hours.
   * Passing it creates the call row and marks the attempt "dialing" (from here on it counts as dialed).
   */
  private async prepare(tx: Queryable, claim: Claim, log: FastifyBaseLogger): Promise<boolean> {
    const { orgId, campaign, contact, phone } = claim;
    const cfg = this.ctx.config.campaigns;
    const now = this.now();
    const attempt = (await tx.query<{ status: string }>('SELECT status FROM campaign_attempt WHERE org_id = $1 AND id = $2 FOR UPDATE', [orgId, claim.attemptId])).rows[0];
    if (attempt?.status !== 'claimed') return false;

    const state = (await tx.query<{ status: string }>('SELECT status FROM campaign WHERE org_id = $1 AND id = $2', [orgId, campaign.id])).rows[0];
    if (state?.status !== 'running') {
      await this.release(tx, orgId, claim.attemptId, { reason: `campaign-${state?.status ?? 'missing'}` });
      return false;
    }
    if (await isOnDnc(tx, orgId, contact.e164)) {
      log.info('contact is on the do-not-call list; not dialing');
      await this.release(tx, orgId, claim.attemptId, { reason: 'do-not-call', contactStatus: 'do_not_call' });
      return false;
    }
    const allowed = checkAllowed(now, contact.time_zone, campaignSchedule(campaign), cfg.hardCap);
    if (!allowed.allowed) {
      log.info({ reason: allowed.reason }, 'outside the allowed calling hours; not dialing');
      const next = nextAllowedAt(now, contact.time_zone, campaignSchedule(campaign), cfg.hardCap);
      await this.release(tx, orgId, claim.attemptId, { reason: allowed.reason, contactStatus: next ? 'pending' : 'expired', nextAttemptAt: next });
      return false;
    }
    if (this.credentialsFor(phone.provider) === null) {
      log.error({ provider: phone.provider }, 'telephony provider is not configured; pausing the campaign');
      await this.release(tx, orgId, claim.attemptId, { reason: 'telephony-not-configured' });
      await pauseForReason(tx, orgId, campaign.id, 'telephony-not-configured');
      return false;
    }
    let target;
    try {
      target = await resolveTarget(tx, orgId, campaign, { requirePublished: true });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      log.error({ err: err.message }, 'assistant is not available; pausing the campaign');
      await this.release(tx, orgId, claim.attemptId, { reason: 'assistant-unavailable' });
      await pauseForReason(tx, orgId, campaign.id, 'assistant-unavailable');
      return false;
    }
    const marked = await tx.query(`UPDATE campaign_attempt SET status = 'dialing', dialed_at = $3::timestamptz WHERE org_id = $1 AND id = $2 AND status = 'claimed'`, [orgId, claim.attemptId, now.toISOString()]);
    if (marked.rowCount !== 1) return false;
    this.ctx.metrics.callsStarted.inc({ type: 'outbound', direction: 'outbound' });
    await tx.query(
      `INSERT INTO call (id, org_id, type, test, assistant_id, assistant_version_id, squad_id, config_source, assistant_name, config, config_schema, variable_values, status,
         created_by_type, customer_number, direction, phone_number_id, campaign_id, campaign_contact_id)
       VALUES ($1, $2, 'outbound', false, $3, $4, $5, 'published', $6, $7, $8, $9, 'queued', 'system', $10, 'outbound', $11, $12, $13)`,
      [claim.callId, orgId, target.assistantId, target.versionId, target.squadId, target.assistantName, JSON.stringify(callConfig(target.config, campaign.disclosure_text)), target.configSchema,
        JSON.stringify(contact.variables), contact.e164, phone.id, campaign.id, contact.id]
    );
    await tx.query('UPDATE campaign_contact SET last_call_id = $3 WHERE org_id = $1 AND id = $2', [orgId, contact.id, claim.callId]);
    return true;
  }

  // ---------------------------------------------------------------- completion

  /** Expire contacts the schedule can no longer reach, and complete campaigns with nothing left to call. */
  async closeFinished(tx: Queryable, orgId: string, now: Date): Promise<void> {
    const running = (await tx.query<{ id: string; end_date: string }>(`SELECT id, end_date::text AS end_date FROM campaign WHERE org_id = $1 AND status = 'running'`, [orgId])).rows;
    for (const campaign of running) {
      if (scheduleEnded(now, campaign.end_date)) {
        await tx.query(
          `UPDATE campaign_contact SET status = 'expired', next_attempt_at = NULL, last_outcome = coalesce(last_outcome, 'schedule-ended'), updated_at = now() WHERE org_id = $1 AND campaign_id = $2 AND status = 'pending'`,
          [orgId, campaign.id]
        );
      }
      const open = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM campaign_contact WHERE org_id = $1 AND campaign_id = $2 AND status IN ('pending', 'calling')`, [orgId, campaign.id])).rows[0];
      if (Number(open.n) === 0) {
        await tx.query(`UPDATE campaign SET status = 'completed', completed_at = $3::timestamptz, updated_at = now() WHERE org_id = $1 AND id = $2 AND status = 'running'`, [orgId, campaign.id, now.toISOString()]);
        this.log.info({ org_id: orgId, campaign_id: campaign.id }, 'campaign completed');
      }
    }
  }
}

/**
 * How a failed dial request is recorded. Only a server error from the provider (it answered, so
 * nothing was placed) is worth a retry; anything where the call may exist is "unconfirmed" and a
 * rejected request (bad number, bad credentials) is "failed".
 */
export function classifyDialError(err: unknown): { outcome: AttemptOutcome; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof TelephonyDialError && err.callPlaced === 'no') {
    const retryable = err.httpStatus === undefined || err.httpStatus >= 500 || err.httpStatus === 429;
    return { outcome: retryable ? 'dial-error' : 'failed', message };
  }
  return { outcome: 'unconfirmed', message };
}
