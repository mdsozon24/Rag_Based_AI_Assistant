/**
 * Browser calls: the media socket behind POST /v1/calls (GET /v1/calls/:id/connect).
 *
 * Handshake (first text frame, within HANDSHAKE_TIMEOUT_MS; the token is never in the URL):
 *   {"type":"hello","protocol":1,"token":"<connectToken>","mode":"voice"|"chat"}
 *   {"type":"resume","protocol":1,"resumeToken":"<from the last ready message>"}
 * The server answers {"type":"ready",...} and the call runs over protocol v1 (see
 * packages/engine/src/transport/browser.ts), or closes the socket with one of CLOSE below.
 *
 * Checks on hello, in order: the connect token (single use, 10 minutes), the org is active, the
 * Origin header equals the origin the call was created for, this process has room
 * (VOICE_MAX_SESSIONS), and the org is under MAX_CONCURRENT_CALLS_PER_ORG.
 *
 * The CallSession runs in this process (one node: see ARCHITECTURE 3.19). A dropped client may
 * resume with the rotating resume token for VOICE_RESUME_GRACE_MS. Transcript and timeline rows are
 * written off the audio path, in order, under the call's org.
 */
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { buildCallConfig } from '../../../../packages/engine/src/assistant/engineConfig.ts';
import type { AssistantSpec } from '../../../../packages/engine/src/assistant/spec.ts';
import { CallSession, type SessionMode } from '../../../../packages/engine/src/engine/callSession.ts';
import type { AssistantConfig } from '../../../../packages/engine/src/engine/config.ts';
import { EndReason } from '../../../../packages/engine/src/engine/endReason.ts';
import type { CallSummary, DebugEvent, SessionEvent } from '../../../../packages/engine/src/engine/events.ts';
import { STAGE_OF } from '../../../../packages/engine/src/providers/types.ts';
import { BROWSER_PROTOCOL_VERSION, BrowserTransport } from '../../../../packages/engine/src/transport/browser.ts';
import { newId, sha256 } from '../auth/crypto.ts';
import type { Queryable } from '../db/database.ts';
import { appendTranscript } from '../services/analysis/transcript.ts';
import { enqueueAnalysis } from '../services/analysis/worker.ts';
import type { AppContext } from '../context.ts';
import { isUuid } from '../db/tenant.ts';
import type { LiveCallHandle } from '../services/liveCalls.ts';
import { engineLogger } from './runtime.ts';
import { teeLogger, type CallLogLine } from '../observability/callLogs.ts';

/** WebSocket close codes the SDK maps to errors (4000-4999 are application codes). */
export const CLOSE = {
  badHandshake: { code: 4400, reason: 'bad_handshake' },
  invalidToken: { code: 4401, reason: 'invalid_token' },
  tokenExpired: { code: 4401, reason: 'token_expired' },
  originNotAllowed: { code: 4403, reason: 'origin_not_allowed' },
  orgSuspended: { code: 4403, reason: 'org_suspended' },
  handshakeTimeout: { code: 4408, reason: 'handshake_timeout' },
  notResumable: { code: 4409, reason: 'call_not_resumable' },
  concurrencyLimit: { code: 4429, reason: 'concurrency_limit' },
  internalError: { code: 4500, reason: 'internal_error' },
  serverBusy: { code: 4503, reason: 'server_busy' },
} as const;

const HANDSHAKE_TIMEOUT_MS = 5000;
/** Typed messages and say requests per call per minute (each one costs an LLM or TTS request). */
const TEXT_MESSAGES_PER_MINUTE = 20;

const handshakeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.literal(BROWSER_PROTOCOL_VERSION), token: z.string().min(20).max(200), mode: z.enum(['voice', 'chat']).default('voice') }),
  z.object({ type: z.literal('resume'), protocol: z.literal(BROWSER_PROTOCOL_VERSION), resumeToken: z.string().min(20).max(200) }),
]);

interface CallRow {
  id: string;
  org_id: string;
  org_status: string;
  status: string;
  origin: string | null;
  token_expires_at: Date | null;
  config: AssistantSpec;
  variable_values: Record<string, string>;
  assistant_name: string;
}

interface LiveWebCall {
  callId: string;
  orgId: string;
  origin: string | null;
  mode: SessionMode;
  session: CallSession;
  transport: BrowserTransport;
  resumeHash: string;
  log: FastifyBaseLogger;
  /** Ordered persistence queue (transcripts, timeline, final status). */
  writes: Promise<void>;
  /** The assistant turned debug.captureLlm on: full LLM prompts and replies are stored (metadata always is). */
  captureLlm: boolean;
  /** Debug timeline volume: lines and partial transcripts stored, and how many were left out past the per-call caps. */
  debug: { logs: number; droppedLogs: number; partials: number; droppedPartials: number; lastPartial: Record<string, { at: number; text: string }> };
  finished: Promise<void>;
}

type CloseSpec = (typeof CLOSE)[keyof typeof CLOSE];

class HandshakeError extends Error {
  constructor(readonly close: CloseSpec) {
    super(close.reason);
  }
}

function closeWith(socket: WebSocket, spec: CloseSpec): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(spec.code, spec.reason);
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export class WebCallService {
  private readonly live = new Map<string, LiveWebCall>();
  /** Calls between token claim and session registration (count against VOICE_MAX_SESSIONS). */
  private starting = 0;

  constructor(private readonly ctx: AppContext) {}

  get activeCount(): number {
    return this.live.size;
  }

  /** A client opened /v1/calls/:id/connect: authenticate the first frame, then run or resume the call. */
  accept(socket: WebSocket, request: FastifyRequest, callId: string): void {
    const log = request.log.child({ call_id: callId });
    if (!isUuid(callId)) return closeWith(socket, CLOSE.badHandshake);
    const timer = setTimeout(() => closeWith(socket, CLOSE.handshakeTimeout), HANDSHAKE_TIMEOUT_MS);
    socket.once('message', (data, isBinary) => {
      clearTimeout(timer);
      if (isBinary) return closeWith(socket, CLOSE.badHandshake);
      let parsed: z.infer<typeof handshakeSchema>;
      try {
        const result = handshakeSchema.safeParse(JSON.parse(data.toString()));
        if (!result.success) return closeWith(socket, CLOSE.badHandshake);
        parsed = result.data;
      } catch {
        return closeWith(socket, CLOSE.badHandshake);
      }
      const origin = typeof request.headers.origin === 'string' ? request.headers.origin : null;
      const work = parsed.type === 'hello' ? this.start(socket, callId, parsed.token, parsed.mode, origin, log) : this.resume(socket, callId, parsed.resumeToken, origin, log);
      work.catch((error: unknown) => {
        if (error instanceof HandshakeError) {
          log.info({ reason: error.close.reason }, 'browser call connection refused');
          return closeWith(socket, error.close);
        }
        log.error({ err: error }, 'browser call failed to start');
        closeWith(socket, CLOSE.internalError);
      });
    });
    socket.once('close', () => clearTimeout(timer));
  }

  /** End every live call (server shutdown) and wait until their rows are written. */
  async shutdown(): Promise<void> {
    const calls = [...this.live.values()];
    await Promise.all(calls.map((call) => call.session.end(EndReason.ServerShutdown)));
    await Promise.all(calls.map((call) => call.finished));
  }

  // ---------------------------------------------------------------- hello

  private async start(socket: WebSocket, callId: string, token: string, mode: SessionMode, origin: string | null, log: FastifyBaseLogger): Promise<void> {
    const { ctx } = this;
    const tokenHash = sha256(token);
    // Identity lookup (owner connection): the token, not a session, says which org this is
    const row = (
      await ctx.tenants.identity((tx) =>
        tx.query<CallRow>(
          `SELECT c.id, c.org_id, o.status AS org_status, c.status, c.origin, c.token_expires_at, c.config, c.variable_values, c.assistant_name
             FROM call c JOIN org o ON o.id = c.org_id
            WHERE c.id = $1 AND c.token_hash = $2`,
          [callId, tokenHash]
        )
      )
    ).rows[0];
    if (!row || row.status !== 'queued') throw new HandshakeError(CLOSE.invalidToken);
    if (!row.token_expires_at || row.token_expires_at.getTime() <= Date.now()) throw new HandshakeError(CLOSE.tokenExpired);
    if (row.org_status !== 'active') throw new HandshakeError(CLOSE.orgSuspended);
    // A call created for a browser origin only connects from that origin
    if (row.origin && row.origin !== origin) throw new HandshakeError(CLOSE.originNotAllowed);
    if (this.live.size + this.starting >= ctx.config.voice.maxSessions) throw new HandshakeError(CLOSE.serverBusy);

    this.starting++;
    try {
      const orgId = row.org_id;
      const claimed = await ctx.tenants.withOrg(orgId, async (tx) => {
        const active = await tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM call WHERE org_id = $1 AND status = 'in-progress'`, [orgId]);
        if (Number(active.rows[0]?.count ?? 0) >= ctx.config.maxConcurrentCallsPerOrg) throw new HandshakeError(CLOSE.concurrencyLimit);
        // Single use: the token is cleared in the same statement that checks it
        const result = await tx.query(
          `UPDATE call SET token_hash = NULL, status = 'in-progress', started_at = now()
            WHERE id = $1 AND org_id = $2 AND token_hash = $3 AND status = 'queued' AND token_expires_at > now()
            RETURNING id`,
          [callId, orgId, tokenHash]
        );
        return result.rows.length === 1;
      });
      if (!claimed) throw new HandshakeError(CLOSE.invalidToken);

      const callLog = log.child({ org_id: orgId });
      let config: AssistantConfig;
      let providers;
      try {
        config = buildCallConfig({ spec: row.config, name: row.assistant_name, callId, startedAt: new Date(), variables: row.variable_values }, ctx.voice.registry);
        providers = await ctx.voice.providersForCall(config, orgId, engineLogger(callLog));
      } catch (error) {
        callLog.error({ err: error }, 'browser call could not be set up');
        await this.markFailed(orgId, callId, error);
        throw new HandshakeError(CLOSE.internalError);
      }

      const call = { callId, orgId, origin: row.origin, mode, log: callLog, writes: Promise.resolve(), captureLlm: row.config.debug?.captureLlm === true, debug: { logs: 0, droppedLogs: 0, partials: 0, droppedPartials: 0, lastPartial: {} } } as LiveWebCall;
      ctx.metrics.callsStarted.inc({ type: 'web', direction: 'web' });
      // The same lines that go to stdout (with call_id and org_id) are kept in the call's debug timeline
      const callLogger = teeLogger(engineLogger(callLog), (line) => this.persistLog(call, line));
      call.transport = new BrowserTransport({
        logger: callLogger,
        resumeGraceMs: ctx.config.voice.resumeGraceMs,
        onControl: (message) => this.onControl(call, message.type, message.text),
        onConnectionChange: (connected) => this.write(call, (tx) => this.timeline(tx, call, connected ? 'client.connected' : 'client.disconnected', {})),
      });
      call.session = new CallSession({ config, transport: call.transport, providers, orgId, callId, mode, logger: callLogger });
      const resumeToken = this.rotateResumeToken(call);
      this.live.set(callId, call);
      const unregister = ctx.liveCalls.register(callId, this.controlHandle(call));
      call.session.onEvent((event) => this.persistEvent(call, event));
      call.session.onDebug((event) => this.persistDebug(call, event));
      call.finished = call.session.ended.then(async (summary) => {
        unregister();
        this.live.delete(callId);
        this.write(call, (tx) => this.finish(tx, call, summary));
        await call.writes;
      });

      this.write(call, (tx) => this.timeline(tx, call, 'call.connected', { mode, origin: row.origin }));
      call.transport.attach(socket, this.readyMessage(call, resumeToken));
      callLog.info({ mode, origin: row.origin }, 'browser call connected');
      await call.session.start();
    } finally {
      this.starting--;
    }
  }

  // ---------------------------------------------------------------- resume

  private async resume(socket: WebSocket, callId: string, resumeToken: string, origin: string | null, log: FastifyBaseLogger): Promise<void> {
    const call = this.live.get(callId);
    // Unknown here: the call ended, or it lives on another node (multi-node needs the Redis registry)
    if (!call || !sameHash(sha256(resumeToken), call.resumeHash)) throw new HandshakeError(CLOSE.notResumable);
    if (call.origin && call.origin !== origin) throw new HandshakeError(CLOSE.originNotAllowed);
    const next = this.rotateResumeToken(call);
    call.transport.attach(socket, this.readyMessage(call, next));
    log.info({ org_id: call.orgId }, 'browser call resumed');
  }

  private rotateResumeToken(call: LiveWebCall): string {
    const token = randomBytes(32).toString('base64url');
    call.resumeHash = sha256(token);
    return token;
  }

  private readyMessage(call: LiveWebCall, resumeToken: string): Record<string, unknown> {
    return {
      type: 'ready',
      protocol: BROWSER_PROTOCOL_VERSION,
      callId: call.callId,
      mode: call.mode,
      resumeToken,
      resumeGraceMs: this.ctx.config.voice.resumeGraceMs,
      inputFormat: call.transport.inputFormat,
      outputFormat: call.transport.outputFormat,
      state: call.session?.state ?? 'connecting',
    };
  }

  // ---------------------------------------------------------------- control

  private onControl(call: LiveWebCall, type: 'message' | 'say', text: string): void {
    const decision = this.ctx.rateLimiter.consume(`call-text:${call.callId}`, TEXT_MESSAGES_PER_MINUTE, 60_000);
    if (!decision.allowed) {
      call.log.warn({ type }, 'client text message rate limited');
      call.transport.sendEvent({ type: 'error', stage: 'internal', message: `Too many messages; retry after ${decision.retryAfterSeconds}s` });
      return;
    }
    if (type === 'message') {
      if (!call.session.submitUserText(text)) call.log.info({}, 'typed message not accepted in the current call state');
      return;
    }
    this.write(call, (tx) => this.timeline(tx, call, 'client.say', { text }));
    call.session.say(text).catch((err: unknown) => call.log.warn({ err }, 'say failed'));
  }

  /** What the control API (POST /v1/calls/:id/say|context|mute|end|transfer) drives. */
  private controlHandle(call: LiveWebCall): LiveCallHandle {
    const { session } = call;
    return {
      say: (message) => session.say(message),
      injectContext: (context) => session.injectContext(context),
      setMuted: (muted) => session.setMuted(muted),
      end: async () => void (await session.end(EndReason.ApiEnded)),
      transfer: (destination, options) => session.transferControl(destination, options),
      subscribe: (listener) => session.onEvent((event) => listener(event as unknown as Record<string, unknown>)),
    };
  }

  // ---------------------------------------------------------------- persistence

  private write(call: LiveWebCall, fn: (tx: Parameters<Parameters<AppContext['tenants']['withOrg']>[1]>[0]) => Promise<unknown>): void {
    call.writes = call.writes
      .then(() => this.ctx.tenants.withOrg(call.orgId, fn))
      .then(
        () => undefined,
        (err: unknown) => call.log.error({ err }, 'could not persist call data')
      );
  }

  private timeline(tx: { query(sql: string, params?: unknown[]): Promise<unknown> }, call: LiveWebCall, type: string, payload: Record<string, unknown>) {
    return tx.query('INSERT INTO call_event (id, org_id, call_id, type, payload) VALUES ($1, $2, $3, $4, $5)', [newId(), call.orgId, call.callId, type, JSON.stringify(payload)]);
  }

  private persistEvent(call: LiveWebCall, event: SessionEvent): void {
    switch (event.type) {
      case 'transcript':
        if (!event.final) {
          this.persistPartial(call, event.role, event.text);
          return;
        }
        {
          // When it was said (engine clock); falls back to now for a session that does not report times
          const at = Date.now();
          const startedAt = new Date(event.startedAt ?? at);
          const endedAt = new Date(Math.max(event.endedAt ?? at, startedAt.getTime()));
          const interrupted = event.role === 'assistant' && event.interrupted === true;
          this.write(call, (tx) => appendTranscript(tx, call.orgId, call.callId, { kind: 'speech', role: event.role, text: event.text, startedAt, endedAt, interrupted }));
        }
        return;
      case 'turn': {
        const { index, kind, interrupted, latency } = event.turn;
        this.write(call, (tx) => this.timeline(tx, call, 'turn', { index, kind, interrupted, latency }));
        return;
      }
      case 'interrupted':
        this.write(call, (tx) => this.timeline(tx, call, 'interrupted', { heardText: event.heardText }));
        return;
      case 'tool-call':
        {
          const at = new Date(event.at ?? Date.now());
          this.write(call, async (tx) => {
            await this.timeline(tx, call, 'tool-call', { name: event.name, args: event.args });
            await appendTranscript(tx, call.orgId, call.callId, { kind: 'tool-call', name: event.name, args: event.args, at });
          });
        }
        return;
      case 'error':
        this.write(call, (tx) => this.timeline(tx, call, 'error', { stage: event.stage, message: event.message }));
        return;
      case 'state':
        this.write(call, (tx) => this.timeline(tx, call, 'state', { state: event.state, at: new Date(event.at).toISOString() }));
        return;
      default:
        // user-speech and ended (handled in finish) are not stored row by row
        return;
    }
  }

  /**
   * Interim transcript, for the debug timeline: at most one per role every 250 ms, never the same text
   * twice, and at most DEBUG_PARTIALS_PER_CALL per call (the rest is counted).
   */
  private persistPartial(call: LiveWebCall, role: 'user' | 'assistant', text: string): void {
    const now = Date.now();
    const last = call.debug.lastPartial[role];
    if (!text.trim() || (last && (last.text === text || now - last.at < 250))) return;
    if (call.debug.partials >= this.ctx.config.debug.partialsPerCall) {
      call.debug.droppedPartials++;
      return;
    }
    call.debug.partials++;
    call.debug.lastPartial[role] = { at: now, text };
    this.write(call, (tx) => this.timeline(tx, call, 'transcript-partial', { role, text: text.slice(0, 500), at: new Date(now).toISOString() }));
  }

  /** A log line of this call, kept in the timeline (up to DEBUG_LOG_LINES_PER_CALL). */
  private persistLog(call: LiveWebCall, line: CallLogLine): void {
    if (call.debug.logs >= this.ctx.config.debug.logLinesPerCall) {
      call.debug.droppedLogs++;
      return;
    }
    call.debug.logs++;
    const at = new Date().toISOString();
    this.write(call, (tx) => this.timeline(tx, call, 'log', { level: line.level, msg: line.msg, fields: line.fields, at }));
  }

  /**
   * LLM requests and responses, provider errors and fallbacks. The timeline always gets the metadata
   * (sizes, tokens, timings, tool names); the text of the prompt and reply goes to call_debug_body only
   * for assistants with debug.captureLlm, and is deleted after DEBUG_RETENTION_DAYS.
   */
  private persistDebug(call: LiveWebCall, event: DebugEvent): void {
    const at = new Date(event.at).toISOString();
    switch (event.type) {
      case 'llm-request': {
        const eventId = newId();
        const metadata = {
          turn: event.turn, provider: event.provider, model: event.model, messageCount: event.messageCount, systemPromptChars: event.systemPromptChars, toolNames: event.toolNames,
          ...(event.temperature !== undefined ? { temperature: event.temperature } : {}), ...(event.maxTokens !== undefined ? { maxTokens: event.maxTokens } : {}), bodyStored: call.captureLlm, at,
        };
        // A long call re-sends its whole history every turn; keep the newest messages of each request
        const messages = event.request.messages.slice(-40);
        this.write(call, async (tx) => {
          await this.timelineWithId(tx, call, eventId, 'llm-request', metadata);
          if (call.captureLlm) await this.debugBody(tx, call, eventId, 'llm-request', { systemPrompt: event.request.systemPrompt, messages, omittedMessages: event.request.messages.length - messages.length });
        });
        return;
      }
      case 'llm-response': {
        const eventId = newId();
        const metadata = {
          turn: event.turn, provider: event.provider, model: event.model, firstTokenMs: event.firstTokenMs, durationMs: event.durationMs, inputTokens: event.inputTokens, outputTokens: event.outputTokens,
          outcome: event.outcome, ...(event.error ? { error: event.error.slice(0, 500) } : {}), toolCalls: event.response.toolCalls.map((c) => c.name), responseChars: event.response.text.length, bodyStored: call.captureLlm, at,
        };
        this.write(call, async (tx) => {
          await this.timelineWithId(tx, call, eventId, 'llm-response', metadata);
          if (call.captureLlm) await this.debugBody(tx, call, eventId, 'llm-response', { text: event.response.text, toolCalls: event.response.toolCalls });
        });
        return;
      }
      case 'provider-error':
        this.ctx.metrics.providerErrors.inc({ stage: event.stage, provider: event.provider, kind: 'failed' });
        this.write(call, (tx) => this.timeline(tx, call, 'provider-error', { stage: event.stage, provider: event.provider, model: event.model, ...(event.code ? { code: event.code } : {}), message: event.message.slice(0, 500), retryable: event.retryable, at }));
        return;
      case 'provider-fallback':
        this.ctx.metrics.providerErrors.inc({ stage: STAGE_OF[event.component], provider: event.from.provider, kind: 'fallback' });
        this.write(call, (tx) => this.timeline(tx, call, 'provider-fallback', { component: event.component, from: event.from, to: event.to, ...(event.code ? { code: event.code } : {}), message: event.message.slice(0, 500), at }));
        return;
    }
  }

  private timelineWithId(tx: Queryable, call: LiveWebCall, id: string, type: string, payload: Record<string, unknown>) {
    return tx.query('INSERT INTO call_event (id, org_id, call_id, type, payload) VALUES ($1, $2, $3, $4, $5)', [id, call.orgId, call.callId, type, JSON.stringify(payload)]);
  }

  private debugBody(tx: Queryable, call: LiveWebCall, eventId: string, kind: 'llm-request' | 'llm-response', body: Record<string, unknown>) {
    return tx.query('INSERT INTO call_debug_body (id, org_id, call_id, event_id, kind, body) VALUES ($1, $2, $3, $4, $5, $6)', [newId(), call.orgId, call.callId, eventId, kind, JSON.stringify(body)]);
  }

  /** Counters and histograms for a finished call (see observability/metrics.ts for the definitions). */
  private recordMetrics(call: LiveWebCall, summary: CallSummary): void {
    const m = this.ctx.metrics;
    m.callsEnded.inc({ reason: summary.endReason, type: 'web' });
    for (const usage of summary.usage) m.providerRequests.inc({ stage: STAGE_OF[usage.component], provider: usage.provider }, usage.units.requests ?? 0);
    const primary = (component: 'transcriber' | 'model' | 'voice') => summary.usage.find((u) => u.component === component && !u.fallback) ?? summary.usage.find((u) => u.component === component);
    const stt = primary('transcriber');
    const llm = primary('model');
    const tts = primary('voice');
    const stack = `${stt?.provider ?? 'none'}+${llm?.provider ?? 'none'}+${tts?.provider ?? 'none'}`;
    for (const turn of summary.turns) {
      if (turn.kind !== 'reply') continue;
      const l = turn.latency;
      if (l.sttFinalMs !== undefined && stt) m.turnLatency.observe({ stage: 'stt_final', provider: stt.provider, model: stt.model }, l.sttFinalMs / 1000);
      if (l.llmFirstTokenMs !== undefined && llm) m.turnLatency.observe({ stage: 'llm_first_token', provider: llm.provider, model: llm.model }, l.llmFirstTokenMs / 1000);
      if (l.ttsFirstByteMs !== undefined && tts) m.turnLatency.observe({ stage: 'tts_first_byte', provider: tts.provider, model: tts.model }, l.ttsFirstByteMs / 1000);
      if (l.voiceToVoiceMs !== undefined) m.turnLatency.observe({ stage: 'voice_to_voice', provider: stack, model: llm?.model ?? '' }, l.voiceToVoiceMs / 1000);
    }
  }

  private async finish(tx: Queryable, call: LiveWebCall, summary: CallSummary): Promise<void> {
    this.recordMetrics(call, summary);
    await tx.query(
      `UPDATE call SET status = 'ended', end_reason = $3, ended_at = now(), duration_ms = $4, usage = $5 WHERE id = $1 AND org_id = $2`,
      [call.callId, call.orgId, summary.endReason, Math.round(summary.durationMs), JSON.stringify(summary.usage)]
    );
    // The call is over and its transcript is written (this runs on the call's ordered write queue): analyse it
    await enqueueAnalysis(tx, call.orgId, call.callId, new Date());
    await this.timeline(tx, call, 'ended', { reason: summary.endReason, durationMs: summary.durationMs, latency: summary.latency, ...(summary.error ? { error: summary.error } : {}), ...(call.debug.droppedLogs || call.debug.droppedPartials ? { droppedLogLines: call.debug.droppedLogs, droppedPartials: call.debug.droppedPartials } : {}) });
    call.log.info({ end_reason: summary.endReason, duration_ms: summary.durationMs }, 'browser call ended');
  }

  private async markFailed(orgId: string, callId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.ctx.metrics.callsEnded.inc({ reason: EndReason.ErrorInternal, type: 'web' });
    await this.ctx.tenants.withOrg(orgId, async (tx) => {
      await tx.query(`UPDATE call SET status = 'ended', end_reason = $3, ended_at = now(), duration_ms = 0 WHERE id = $1 AND org_id = $2`, [callId, orgId, EndReason.ErrorInternal]);
      await tx.query('INSERT INTO call_event (id, org_id, call_id, type, payload) VALUES ($1, $2, $3, $4, $5)', [newId(), orgId, callId, 'error', JSON.stringify({ stage: 'setup', message })]);
      await enqueueAnalysis(tx, orgId, callId, new Date());
    });
  }
}
