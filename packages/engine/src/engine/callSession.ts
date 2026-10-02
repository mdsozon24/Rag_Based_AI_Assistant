/**
 * One conversation: audio in -> VAD/endpointing -> STT -> LLM -> sentence chunker -> TTS -> audio out,
 * streaming at every step.
 *
 * Turn flow:
 * 1. Caller audio is converted to PCM16 16 kHz, fed to the speech detector and streamed to STT.
 * 2. speech-end (silence >= endpointing.silenceMs) -> STT commit -> final transcript -> LLM stream.
 * 3. LLM text is cut into sentences; the first one goes to TTS immediately, later ones are
 *    synthesized while earlier ones play.
 * 4. Barge-in: user speech while the agent is audible clears the far-end buffer, aborts LLM and
 *    TTS, and records only the text the caller heard.
 *
 * Every provider call has a timeout and one safe retry; when that fails the session speaks the
 * fallback message and ends (or transfers). It never sits silent.
 */
import { randomUUID } from 'node:crypto';
import { AudioConverter, durationMs, ENGINE_SAMPLE_RATE, PCM16_16K } from '../audio/format.ts';
import { createLogger, type Logger } from '../logger.ts';
import type { FallbackInfo } from '../providers/chain.ts';
import { ModelChain, toChain, TranscriberChain, VoiceChain, type ProviderChain } from '../providers/chain.ts';
import { isAbortError, toProviderError, withTimeout } from '../providers/resilience.ts';
import {
  ProviderError,
  type ChatMessage,
  type LanguageModel,
  type LlmEvent,
  type ToolDefinition,
  type Transcriber,
  type TranscriberStream,
  type VoiceSynthesizer,
} from '../providers/types.ts';
import type { Transport } from '../transport/types.ts';
import { SpeechDetector } from '../vad/speechDetector.ts';
import type { AssistantConfig, TransferDestination } from './config.ts';
import { EndReason, errorEndReason, type ProviderStage } from './endReason.ts';
import type { CallSummary, DebugEvent, HistoryEntry, SessionEvent } from './events.ts';
import { computeLatency, LatencyRecorder, summarizeLatency, type TurnKind, type TurnRecord } from './metrics.ts';
import { PlayoutTracker } from './playout.ts';
import { SentenceChunker } from './sentenceChunker.ts';
import { SpeechPipeline } from './speechPipeline.ts';
import { CallStateMachine, type CallState } from './stateMachine.ts';
import { OPT_OUT_TOOL, REPORT_OUTCOME_TOOL, type CampaignHooks } from './campaign.ts';
import { UsageMeter } from './usage.ts';

export interface CallSessionOptions {
  config: AssistantConfig;
  transport: Transport;
  /** Each component: a provider chain (primary + fallbacks, from resolveCallProviders) or a bare instance. */
  providers: {
    transcriber: Transcriber | ProviderChain<Transcriber>;
    model: LanguageModel | ProviderChain<LanguageModel>;
    voice: VoiceSynthesizer | ProviderChain<VoiceSynthesizer>;
  };
  /** Org the call belongs to (logs, usage records). */
  orgId?: string;
  callId?: string;
  logger?: Logger;
  now?: () => number;
  /** Shared across calls to report p50/p95 over many calls. */
  latencyRecorder?: LatencyRecorder;
  /**
   * voice (default): audio in and out. chat: typed text in, text out; no STT or TTS requests,
   * no idle reminders, caller audio ignored. Same turn manager, history and tools.
   */
  mode?: SessionMode;
  /** Campaign calls: opt-out detection and outcome reporting (see campaign.ts). */
  campaign?: CampaignHooks;
}

export type SessionMode = 'voice' | 'chat';

/** Longest typed message accepted by submitUserText (characters). */
export const MAX_USER_TEXT_CHARS = 2000;

async function* noAudio(): AsyncGenerator<Uint8Array> {}

/** Real caller audio kept while the agent talks, replayed to STT on barge-in. */
const PRE_ROLL_MS = 400;
const TRANSFER_TIMEOUT_MS = 10000;

export const END_CALL_TOOL = 'endCall';
export const TRANSFER_CALL_TOOL = 'transferCall';

interface ActiveTurn {
  id: number;
  record: TurnRecord;
  controller: AbortController;
  playout: PlayoutTracker;
  outConverter: AudioConverter;
  audioStarted: boolean;
  /** User text is in history (it is added once the reply becomes audible or completes). */
  userCommitted: boolean;
  finalized: boolean;
  /** Detach the turn from the call lifetime signal. */
  dispose: () => void;
  pipeline?: SpeechPipeline;
}

type SpeakOutcome = 'completed' | 'interrupted' | 'cancelled';

/** Lower case, punctuation removed, single spaces, padded: phrase matching works for any script. */
function normalizePhrase(text: string): string {
  return ` ${text.toLocaleLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim()} `;
}

/** The first of `phrases` that `text` contains as whole words, or null. */
export function findPhrase(text: string, phrases: readonly string[]): string | null {
  if (!phrases.length || !text.trim()) return null;
  const said = normalizePhrase(text);
  return (
    phrases.find((phrase) => {
      const wanted = normalizePhrase(phrase);
      return wanted.trim().length > 0 && said.includes(wanted);
    }) ?? null
  );
}

/** Does `text` contain one of `phrases` as whole words? */
export function containsEndCallPhrase(text: string, phrases: readonly string[]): boolean {
  return findPhrase(text, phrases) !== null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export class CallSession {
  readonly callId: string;
  readonly config: AssistantConfig;
  readonly history: HistoryEntry[] = [];
  readonly turns: TurnRecord[] = [];
  readonly startedAt: number;
  readonly mode: SessionMode;

  private readonly campaign: CampaignHooks | undefined;
  /** Hook calls still running (outcome persistence); awaited before the call is reported ended. */
  private readonly pendingHooks = new Set<Promise<unknown>>();
  private readonly transport: Transport;
  readonly orgId: string | undefined;
  private readonly transcriber: TranscriberChain;
  private readonly model: ModelChain;
  private readonly voice: VoiceChain;
  private readonly usage = new UsageMeter();
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly sm: CallStateMachine;
  private readonly detector: SpeechDetector;
  private readonly inConverter: AudioConverter;
  private readonly latencyRecorder?: LatencyRecorder;
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly debugListeners = new Set<(event: DebugEvent) => void>();
  private readonly lifetime = new AbortController();

  private stt: TranscriberStream | null = null;
  private sttReconnects = 0;
  private sttPartial = '';
  private sttFinals: string[] = [];
  private finalWaiter: ((text: string | null) => void) | null = null;
  private pendingUserText = '';
  private userSpeechStartAt: number | undefined;
  private preRoll: Int16Array[] = [];
  private preRollSamples = 0;

  private activeTurn: ActiveTurn | null = null;
  private turnCounter = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idlePrompts = 0;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  /** Ending or failing over: no new turns, no barge-in. */
  private terminating = false;
  private fallbackAudio: Promise<Uint8Array[] | null> | null = null;
  private endReason: EndReason | null = null;
  private endedAt = 0;
  private error: CallSummary['error'];
  private transferredTo: string | undefined;
  private assistantMuted = false;
  private injectedContext: string[] = [];
  private resolveEnded!: (summary: CallSummary) => void;
  /** Resolves with the call summary once the call has ended. */
  readonly ended: Promise<CallSummary>;

  constructor(options: CallSessionOptions) {
    this.callId = options.callId ?? randomUUID();
    this.config = options.config;
    this.transport = options.transport;
    this.orgId = options.orgId;
    this.mode = options.mode ?? 'voice';
    this.campaign = options.campaign;
    this.now = options.now ?? Date.now;
    this.latencyRecorder = options.latencyRecorder;
    this.log = (options.logger ?? createLogger()).child({ call_id: this.callId, ...(this.orgId ? { org_id: this.orgId } : {}) });
    const chain = { callId: this.callId, logger: this.log, meter: this.usage, onFallback: (info: FallbackInfo) => this.emitDebug({ type: 'provider-fallback', at: this.now(), ...info }) };
    const { transcriber, model, voice } = this.config;
    this.transcriber = new TranscriberChain(
      toChain(options.providers.transcriber),
      { ...chain, component: 'transcriber', retries: Number(transcriber.retries) },
      { connectTimeoutMs: Number(transcriber.connectTimeoutMs) }
    );
    this.model = new ModelChain(
      toChain(options.providers.model),
      { ...chain, component: 'model', retries: Number(model.retries) },
      { firstTokenTimeoutMs: Number(model.firstTokenTimeoutMs), idleTimeoutMs: Number(model.idleTimeoutMs) }
    );
    this.voice = new VoiceChain(
      toChain(options.providers.voice),
      { ...chain, component: 'voice', retries: Number(voice.retries) },
      { firstByteTimeoutMs: Number(voice.firstByteTimeoutMs), idleTimeoutMs: Number(voice.idleTimeoutMs) }
    );
    this.startedAt = this.now();
    this.ended = new Promise((resolve) => (this.resolveEnded = resolve));
    this.sm = new CallStateMachine(this.now, (change) => {
      this.log.info({ from: change.from, to: change.to, reason: change.reason }, 'state');
      this.applyTurnTakingThresholds(change.to);
      this.emit({ type: 'state', state: change.to, at: change.at });
    });
    const { endpointing } = this.config;
    this.detector = new SpeechDetector(
      {
        sampleRate: ENGINE_SAMPLE_RATE,
        silenceMs: endpointing.silenceMs,
        minSpeechMs: endpointing.minSpeechMs,
        marginDb: endpointing.vadMarginDb,
        minSpeechDb: endpointing.vadMinSpeechDb,
      },
      this.now
    );
    this.inConverter = new AudioConverter(this.transport.inputFormat, PCM16_16K);
  }

  get state(): CallState {
    return this.sm.state;
  }

  get stateHistory() {
    return this.sm.history;
  }

  /** Observe session events (the same events the transport receives). */
  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Server-side diagnostics (LLM requests and responses, provider errors and fallbacks). Never sent to the transport. */
  onDebug(listener: (event: DebugEvent) => void): () => void {
    this.debugListeners.add(listener);
    return () => this.debugListeners.delete(listener);
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    const { config } = this;
    this.log.info(
      {
        assistant: config.name,
        mode: this.mode,
        language: config.language,
        input_format: this.transport.inputFormat,
        output_format: this.transport.outputFormat,
        transcriber: `${this.transcriber.primary.provider}/${this.transcriber.primary.model}`,
        model: `${this.model.primary.provider}/${this.model.primary.model}`,
        voice: `${this.voice.primary.provider}/${this.voice.primary.model}`,
      },
      'call starting'
    );
    this.transport.start({ onAudio: (chunk) => this.onCallerAudio(chunk), onHangup: () => void this.end(EndReason.CustomerHungUp) });

    if (config.maxDurationMs > 0) {
      this.maxDurationTimer = setTimeout(() => void this.onMaxDuration(), config.maxDurationMs);
    }

    if (this.mode === 'voice') {
      try {
        await this.connectStt();
      } catch (error) {
        // Runs on its own: start() returns while the fallback message plays
        void this.failOver('stt', error);
        return;
      }
    }
    if (this.sm.isEnded) return;

    if (config.firstMessage.mode === 'assistant-speaks-first' && config.firstMessage.text.trim()) {
      void this.runFixedTurn('first-message', config.firstMessage.text, 'listen');
    } else {
      this.sm.transition('listening', 'waiting for user');
      this.armIdleTimer();
      this.ensureFallbackPrefetch();
    }
  }

  /** End the call (idempotent). */
  async end(reason: EndReason, detail?: { error?: CallSummary['error'] }): Promise<CallSummary> {
    if (this.endReason) return this.ended;
    this.endReason = reason;
    this.terminating = true;
    if (detail?.error) this.error = detail.error;
    this.clearIdleTimer();
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    this.finalWaiter?.(null);

    const turn = this.activeTurn;
    if (turn && !turn.finalized) {
      turn.controller.abort();
      if (turn.audioStarted) this.finalizeTurn(turn, { interrupted: true });
    }
    this.lifetime.abort();
    this.sm.transition('ended', reason);
    this.endedAt = this.now();

    const stt = this.stt;
    this.stt = null;
    if (stt) await stt.close().catch((err) => this.log.warn({ err }, 'stt close failed'));
    await Promise.allSettled([...this.pendingHooks]);

    const summary = this.summary();
    this.log.info(
      {
        end_reason: reason,
        duration_ms: summary.durationMs,
        turns: summary.turns.length,
        latency: summary.latency,
        usage: summary.usage,
        ...(summary.error ? { error: summary.error } : {}),
        ...(summary.transferredTo ? { transferred_to: summary.transferredTo } : {}),
      },
      'call ended'
    );
    this.emit({ type: 'ended', reason, summary });
    this.transport.close();
    this.resolveEnded(summary);
    return summary;
  }

  summary(): CallSummary {
    const endedAt = this.endedAt || this.now();
    return {
      callId: this.callId,
      endReason: this.endReason ?? EndReason.ErrorInternal,
      startedAt: this.startedAt,
      endedAt,
      durationMs: endedAt - this.startedAt,
      history: [...this.history],
      turns: [...this.turns],
      stateHistory: [...this.sm.history],
      latency: summarizeLatency(this.turns.filter((t) => t.kind === 'reply')),
      usage: this.usage.snapshot(),
      ...(this.orgId ? { orgId: this.orgId } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.transferredTo ? { transferredTo: this.transferredTo } : {}),
    };
  }

  /** Speak an operator message without waiting for caller speech. */
  async say(message: string): Promise<void> {
    if (!message.trim() || this.sm.isEnded) return;
    await this.runFixedTurn('goodbye', message, 'stay');
  }

  /**
   * The caller typed a message (chat mode, or text sent during a voice call). It interrupts the
   * agent like speech would and is answered with the normal reply path. Returns false when the
   * text was not accepted (empty, too long, or the call is not in a state that takes input).
   */
  submitUserText(input: string): boolean {
    const text = input.trim();
    if (!text || text.length > MAX_USER_TEXT_CHARS) return false;
    if (this.terminating || this.sm.is('connecting', 'transferring', 'ended')) return false;
    const turn = this.activeTurn;
    if (turn && !turn.finalized) {
      if (turn.audioStarted) {
        const stoppedAt = this.now();
        this.transport.clearAudio();
        turn.controller.abort();
        this.finalizeTurn(turn, { interrupted: true, at: stoppedAt });
        this.emit({ type: 'interrupted', at: stoppedAt, heardText: turn.record.heardText });
      } else {
        this.cancelTurn(turn, 'user typed');
      }
    }
    if (!this.sm.is('listening')) this.sm.transition('listening', 'user typed');
    this.clearIdleTimer();
    this.idlePrompts = 0;
    void this.runTypedTurn(text);
    return true;
  }

  /** Add operator context to subsequent LLM requests without exposing it as caller speech. */
  async injectContext(context: string): Promise<void> {
    if (context.trim()) this.injectedContext.push(context.trim());
  }

  /** Suppress or resume agent audio while keeping STT alive. */
  async setMuted(muted: boolean): Promise<void> {
    this.assistantMuted = muted;
    if (muted) this.transport.clearAudio();
  }

  /** Operator transfer with warm mode and explicit no-answer recovery. */
  async transferControl(destination: string, options: { mode: 'cold' | 'warm'; summary?: string; failureAction: 'return-to-agent' | 'take-message' | 'end' }): Promise<void> {
    if (options.mode === 'warm' && options.summary?.trim()) await this.say(options.summary);
    await this.transferTo(destination, EndReason.Transferred, undefined, options.failureAction);
  }

  // ---------------------------------------------------------------- inbound audio

  private onCallerAudio(chunk: Uint8Array): void {
    if (this.sm.isEnded || this.mode === 'chat') return;
    let samples: Int16Array;
    try {
      samples = this.inConverter.toPcm16(chunk);
    } catch (err) {
      this.log.warn({ err, bytes: chunk.length }, 'dropping undecodable caller audio');
      return;
    }
    if (samples.length === 0) return;
    this.rememberPreRoll(samples);

    // While the agent is audible, STT gets silence: the stream stays alive, but echo of the
    // agent's own voice is not transcribed. On barge-in the real pre-roll audio is replayed.
    const agentAudible = this.sm.is('speaking');
    if (this.stt && !this.sm.is('connecting', 'transferring')) {
      this.stt.sendAudio(agentAudible ? new Int16Array(samples.length) : samples);
    }

    for (const event of this.detector.push(samples)) {
      if (event.type === 'speech-start') this.onUserSpeechStart(event.at);
      else this.onUserSpeechEnd(event.at);
    }
  }

  private rememberPreRoll(samples: Int16Array): void {
    this.preRoll.push(samples);
    this.preRollSamples += samples.length;
    const max = (ENGINE_SAMPLE_RATE * PRE_ROLL_MS) / 1000;
    while (this.preRoll.length > 1 && this.preRollSamples - this.preRoll[0].length >= max) {
      this.preRollSamples -= (this.preRoll.shift() as Int16Array).length;
    }
  }

  private applyTurnTakingThresholds(state: CallState): void {
    const { endpointing, interruption } = this.config;
    if (state === 'speaking') {
      this.detector.configure({ minSpeechMs: interruption.minSpeechMs, extraMarginDb: interruption.echoGuardDb });
    } else {
      this.detector.configure({ minSpeechMs: endpointing.minSpeechMs, extraMarginDb: 0 });
    }
  }

  private onUserSpeechStart(at: number): void {
    if (this.terminating || this.sm.is('connecting', 'transferring', 'ended')) return;
    const turn = this.activeTurn;

    if (this.sm.is('speaking')) {
      if (!this.config.interruption.enabled || !turn) return;
      this.bargeIn(turn, at);
    } else if (turn && !turn.finalized) {
      // The user kept talking (or spoke over a reminder) before the agent became audible:
      // drop the pending reply and merge what they said into the next turn.
      this.cancelTurn(turn, 'user kept talking');
    }

    this.clearIdleTimer();
    this.idlePrompts = 0;
    this.userSpeechStartAt = at;
    this.emit({ type: 'user-speech', speaking: true, at });
  }

  private onUserSpeechEnd(at: number): void {
    if (this.terminating || !this.sm.is('listening') || this.activeTurn) return;
    this.emit({ type: 'user-speech', speaking: false, at });
    void this.runReplyTurn(this.userSpeechStartAt ?? at, at);
    this.userSpeechStartAt = undefined;
  }

  // ---------------------------------------------------------------- STT

  private async connectStt(): Promise<void> {
    const handlers = {
      onPartial: (text: string) => {
        if (this.sm.isEnded) return;
        this.sttPartial = text;
        if (text.trim()) this.emit({ type: 'transcript', role: 'user', text, final: false });
      },
      onFinal: (text: string) => {
        if (this.sm.isEnded) return;
        this.sttPartial = '';
        if (text.trim()) this.sttFinals.push(text.trim());
        const waiter = this.finalWaiter;
        this.finalWaiter = null;
        waiter?.(text);
      },
      onError: (error: ProviderError) => void this.onSttError(error),
    };
    // Retries and fallback providers are handled by the transcriber chain
    const language = (this.config.transcriber.language as string | undefined) ?? this.config.language;
    this.stt = await this.transcriber.connect({ sampleRate: ENGINE_SAMPLE_RATE, language }, handlers, this.lifetime.signal);
  }

  private async onSttError(error: ProviderError): Promise<void> {
    if (this.terminating || this.sm.isEnded) return;
    const old = this.stt;
    this.stt = null;
    void old?.close().catch(() => {});
    if (this.sttReconnects >= 1 || !error.retryable) {
      await this.failOver('stt', error);
      return;
    }
    this.sttReconnects++;
    this.log.warn({ err: error, provider: this.transcriber.current.provider }, 'stt stream failed, reconnecting');
    try {
      await this.connectStt();
    } catch (reconnectError) {
      await this.failOver('stt', reconnectError);
    }
  }

  /**
   * Commit the current STT segment and wait for its final text (falls back to the last partial).
   * If the turn is cancelled meanwhile, returns '' and leaves any finals for the next turn.
   */
  private async collectUserText(timeoutMs: number, signal: AbortSignal): Promise<string> {
    let waiter: ((text: string | null) => void) | null = null;
    const finalArrived = new Promise<'final'>((resolve) => {
      waiter = () => resolve('final');
      this.finalWaiter = waiter;
    });
    if (this.stt) this.stt.commit();
    const outcome = await Promise.race([finalArrived, sleep(timeoutMs, signal).then(() => 'timeout' as const)]);
    if (this.finalWaiter === waiter) this.finalWaiter = null;
    if (signal.aborted) return '';
    if (outcome === 'timeout' && this.sttPartial.trim()) {
      this.log.warn({ timeout_ms: timeoutMs }, 'stt final timed out, using last partial transcript');
      this.sttFinals.push(this.sttPartial.trim());
    }
    const text = this.sttFinals.join(' ').trim();
    this.sttFinals = [];
    this.sttPartial = '';
    return text;
  }

  // ---------------------------------------------------------------- turns

  private newTurn(kind: TurnKind, userText = ''): ActiveTurn {
    const controller = new AbortController();
    const abortTurn = () => controller.abort();
    this.lifetime.signal.addEventListener('abort', abortTurn, { once: true });
    const dispose = () => this.lifetime.signal.removeEventListener('abort', abortTurn);
    controller.signal.addEventListener('abort', dispose, { once: true });
    const turn: ActiveTurn = {
      id: ++this.turnCounter,
      record: { index: this.turnCounter, kind, userText, generatedText: '', heardText: '', interrupted: false, timestamps: {}, latency: {} },
      controller,
      playout: new PlayoutTracker(this.now, this.transport.playbackLeadMs),
      outConverter: new AudioConverter(this.voice.outputFormat, this.transport.outputFormat),
      audioStarted: false,
      userCommitted: false,
      finalized: false,
      dispose,
    };
    this.activeTurn = turn;
    return turn;
  }

  private async runReplyTurn(speechStartAt: number, speechEndAt: number): Promise<void> {
    const endpointAt = this.now();
    const turn = this.newTurn('reply');
    const ts = turn.record.timestamps;
    ts.userSpeechStartAt = speechStartAt;
    ts.userSpeechEndAt = speechEndAt;
    ts.endpointAt = endpointAt;
    this.sm.transition('thinking', 'endpoint');

    try {
      const heard = await this.collectUserText(this.config.endpointing.sttFinalTimeoutMs, turn.controller.signal);
      ts.sttFinalAt = this.now();
      if (turn.controller.signal.aborted) {
        if (!this.sm.isEnded) this.pendingUserText = [this.pendingUserText, heard].filter(Boolean).join(' ');
        return;
      }
      const userText = [this.pendingUserText, heard].filter(Boolean).join(' ').trim();
      this.pendingUserText = '';
      if (!userText) {
        this.log.debug({}, 'empty transcript after endpoint, back to listening');
        this.activeTurn = null;
        this.sm.transition('listening', 'empty transcript');
        this.armIdleTimer();
        return;
      }
      turn.record.userText = userText;
      this.emit({ type: 'transcript', role: 'user', text: userText, final: true, startedAt: speechStartAt, endedAt: speechEndAt });
      this.log.info({ turn: turn.id, text_chars: userText.length, stt_final_ms: ts.sttFinalAt - endpointAt }, 'user turn');
      // "Stop calling me": the assistant does not argue or reply; the number is blocked and the call ends
      const optOutPhrase = this.campaign ? findPhrase(userText, this.campaign.optOutPhrases) : null;
      if (optOutPhrase) {
        turn.finalized = true;
        turn.dispose();
        if (this.activeTurn === turn) this.activeTurn = null;
        this.history.push({ role: 'user', content: userText, at: this.now() });
        await this.optOutAndEnd('phrase', userText, { phrase: optOutPhrase, speak: true });
        return;
      }
      await this.respond(turn);
    } catch (error) {
      await this.handleTurnError(turn, error);
    }
  }

  /** Answer typed text: the reply path without endpointing or STT. */
  private async runTypedTurn(text: string): Promise<void> {
    const turn = this.newTurn('typed-reply');
    const userText = [this.pendingUserText, text].filter(Boolean).join(' ').trim();
    this.pendingUserText = '';
    turn.record.userText = userText;
    turn.record.timestamps.endpointAt = this.now();
    this.sm.transition('thinking', 'typed message');
    const typedAt = this.now();
    this.emit({ type: 'transcript', role: 'user', text: userText, final: true, startedAt: typedAt, endedAt: typedAt });
    this.log.info({ turn: turn.id, text_chars: userText.length }, 'typed user turn');
    try {
      await this.respond(turn);
    } catch (error) {
      await this.handleTurnError(turn, error);
    }
  }

  /** Generate and speak the reply to turn.record.userText, then act on any tool call. */
  private async respond(turn: ActiveTurn): Promise<void> {
    const toolCall = await this.generateAndSpeak(turn);
    if (turn.controller.signal.aborted) return;
    await this.waitForPlayout(turn);
    if (turn.controller.signal.aborted) return;
    this.finalizeTurn(turn, { interrupted: false });

    if (toolCall?.name === END_CALL_TOOL) {
      await this.end(EndReason.AssistantEnded);
    } else if (!toolCall && containsEndCallPhrase(turn.record.heardText, this.config.endCallPhrases)) {
      this.log.info({ turn: turn.id }, 'end-call phrase spoken');
      await this.end(EndReason.AssistantEnded);
    } else if (toolCall?.name === TRANSFER_CALL_TOOL) {
      await this.transferTo(String(toolCall.args.destination ?? ''), EndReason.Transferred);
    } else if (toolCall?.name === OPT_OUT_TOOL) {
      // The assistant already acknowledged it in this turn
      await this.optOutAndEnd('tool', turn.record.userText, { speak: false });
    } else {
      this.backToListening();
    }
  }

  /** Record the opt-out (awaited: it must be saved before the call ends), say goodbye, hang up. */
  private async optOutAndEnd(source: 'phrase' | 'tool', text: string, options: { phrase?: string; speak: boolean }): Promise<void> {
    const campaign = this.campaign;
    if (!campaign || this.sm.isEnded) return;
    this.terminating = true;
    this.clearIdleTimer();
    this.log.info({ source, ...(options.phrase ? { phrase: options.phrase } : {}) }, 'caller opted out');
    this.emit({ type: 'opt-out', source, ...(options.phrase ? { phrase: options.phrase } : {}) });
    try {
      await campaign.onOptOut({ source, text, ...(options.phrase ? { phrase: options.phrase } : {}) });
    } catch (err) {
      // The hang-up still happens; this log line is how an operator learns the list was not updated
      this.log.error({ err }, 'could not record the opt-out');
    }
    if (options.speak && campaign.optOutMessage.trim()) await this.runFixedTurn('goodbye', campaign.optOutMessage, 'stay');
    await this.end(EndReason.OptOut);
  }

  private track(work: void | Promise<void>, what: string): void {
    if (!work) return;
    const tracked = Promise.resolve(work).catch((err) => this.log.error({ err }, `${what} failed`));
    this.pendingHooks.add(tracked);
    void tracked.finally(() => this.pendingHooks.delete(tracked));
  }

  private toolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    const { endCall, transferCall } = this.config.tools;
    if (endCall.enabled) {
      tools.push({
        name: END_CALL_TOOL,
        description:
          'End the phone call. Call this only after you have said goodbye, when the caller says they are done or asks to hang up.',
        parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Short reason for ending the call' } } },
      });
    }
    if (transferCall.enabled && transferCall.destinations.length > 0) {
      tools.push({
        name: TRANSFER_CALL_TOOL,
        description:
          'Transfer the caller to a human or another line. Destinations: ' +
          transferCall.destinations.map((d) => `${d.name}${d.description ? ` (${d.description})` : ''}`).join('; '),
        parameters: {
          type: 'object',
          properties: { destination: { type: 'string', enum: transferCall.destinations.map((d) => d.name) } },
          required: ['destination'],
        },
      });
    }
    if (this.campaign) {
      tools.push({
        name: OPT_OUT_TOOL,
        description: 'Call this when the person says they do not want to be called again or asks to be removed from the list. Say a brief polite goodbye first.',
        parameters: { type: 'object', properties: {} },
      });
      if (this.campaign.outcomeLabels.length) {
        tools.push({
          name: REPORT_OUTCOME_TOOL,
          description: 'Record how the conversation went, once the result is clear. Call it at most once per call.',
          parameters: {
            type: 'object',
            properties: { label: { type: 'string', enum: [...this.campaign.outcomeLabels] }, notes: { type: 'string', description: 'One short sentence of detail' } },
            required: ['label'],
          },
        });
      }
    }
    return tools;
  }

  private llmMessages(userText: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const entry of this.history) {
      if (!entry.content.trim()) continue;
      const last = messages[messages.length - 1];
      if (last && last.role === entry.role) last.content += '\n' + entry.content;
      else messages.push({ role: entry.role, content: entry.content });
    }
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') last.content += '\n' + userText;
    else messages.push({ role: 'user', content: userText });
    return messages;
  }

  /** Stream the LLM reply into TTS. Returns the tool call the model made, if any. */
  private async generateAndSpeak(turn: ActiveTurn): Promise<Extract<LlmEvent, { type: 'tool-call' }> | null> {
    const { model: modelConfig } = this.config;
    const ts = turn.record.timestamps;
    const llmAbort = new AbortController();
    const abortLlm = () => llmAbort.abort();
    turn.controller.signal.addEventListener('abort', abortLlm, { once: true });

    const pipeline = this.createPipeline(turn);
    pipeline.done.catch(() => llmAbort.abort());
    const chunker = new SentenceChunker();
    let toolCall: Extract<LlmEvent, { type: 'tool-call' }> | null = null;
    ts.llmRequestAt = this.now();

    // Timeouts, retries and fallback models are handled by the model chain
    const request = {
      systemPrompt: [this.config.systemPrompt, ...this.injectedContext.map((context) => `Operator context: ${context}`)].join('\n\n'),
      messages: this.llmMessages(turn.record.userText),
      tools: this.toolDefinitions(),
      temperature: modelConfig.temperature as number | undefined,
      maxTokens: modelConfig.maxTokens as number | undefined,
    };
    const stream = this.model.stream(request, llmAbort.signal);
    const tokensBefore = this.meteredTokens();
    const requestedAt = ts.llmRequestAt ?? this.now();
    const requestedProvider = this.model.current;
    this.emitDebug({
      type: 'llm-request',
      at: requestedAt,
      turn: turn.record.index,
      provider: requestedProvider.provider,
      model: requestedProvider.model,
      messageCount: request.messages.length,
      systemPromptChars: request.systemPrompt.length,
      toolNames: request.tools.map((tool) => tool.name),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      request: { systemPrompt: request.systemPrompt, messages: request.messages },
    });
    const toolCallsSeen: { name: string; args: Record<string, unknown> }[] = [];
    let streamError: unknown;

    try {
      for await (const event of stream) {
        ts.llmFirstTokenAt ??= this.now();
        if (event.type === 'tool-call') {
          toolCallsSeen.push({ name: event.name, args: event.args });
          this.log.info({ tool: event.name, args: event.args }, 'llm tool call');
          this.emit({ type: 'tool-call', name: event.name, args: event.args, at: this.now() });
          if (!toolCall && (event.name === END_CALL_TOOL || event.name === TRANSFER_CALL_TOOL || (this.campaign && event.name === OPT_OUT_TOOL))) toolCall = event;
          if (this.campaign && event.name === REPORT_OUTCOME_TOOL) this.reportOutcome(event.args);
          continue;
        }
        if (event.type !== 'text') continue;
        turn.record.generatedText += event.text;
        for (const chunk of chunker.push(event.text)) this.pushSpeech(turn, pipeline, chunk);
      }
    } catch (error) {
      streamError = error;
      throw error;
    } finally {
      turn.controller.signal.removeEventListener('abort', abortLlm);
      const used = this.meteredTokens();
      const responder = this.model.current;
      this.emitDebug({
        type: 'llm-response',
        at: this.now(),
        turn: turn.record.index,
        provider: responder.provider,
        model: responder.model,
        firstTokenMs: ts.llmFirstTokenAt !== undefined ? ts.llmFirstTokenAt - requestedAt : null,
        durationMs: this.now() - requestedAt,
        inputTokens: used.input - tokensBefore.input,
        outputTokens: used.output - tokensBefore.output,
        outcome: streamError ? 'error' : llmAbort.signal.aborted || turn.controller.signal.aborted ? 'aborted' : 'completed',
        ...(streamError ? { error: streamError instanceof Error ? streamError.message : String(streamError) } : {}),
        response: { text: turn.record.generatedText, toolCalls: toolCallsSeen },
      });
    }
    // TTS failed while the LLM was streaming: report the TTS error, not the abort
    if (llmAbort.signal.aborted && !turn.controller.signal.aborted) await pipeline.done;
    if (turn.controller.signal.aborted) return null;

    for (const chunk of chunker.flush()) this.pushSpeech(turn, pipeline, chunk);
    if (!turn.record.generatedText.trim() && toolCall) {
      const message =
        toolCall.name === END_CALL_TOOL
          ? this.config.tools.endCall.message
          : toolCall.name === OPT_OUT_TOOL
            ? this.campaign?.optOutMessage ?? ''
            : this.findDestination(String(toolCall.args.destination ?? ''))?.message ?? '';
      if (message.trim()) {
        turn.record.generatedText = message;
        this.pushSpeech(turn, pipeline, message);
      }
    }
    pipeline.finish();
    await pipeline.done;
    return toolCall;
  }

  /** Tokens metered so far for the model (input, output), to attribute them to one request. */
  private meteredTokens(): { input: number; output: number } {
    let input = 0;
    let output = 0;
    for (const record of this.usage.snapshot()) {
      if (record.component !== 'model') continue;
      input += record.units.inputTokens ?? 0;
      output += record.units.outputTokens ?? 0;
    }
    return { input, output };
  }

  private reportOutcome(args: Record<string, unknown>): void {
    const campaign = this.campaign;
    const label = typeof args.label === 'string' ? args.label : '';
    // Only labels the campaign defined: a made-up one is ignored, not stored
    if (!campaign || !campaign.outcomeLabels.includes(label)) {
      this.log.warn({ label }, 'ignoring an outcome label the campaign does not define');
      return;
    }
    const notes = typeof args.notes === 'string' ? args.notes.slice(0, 500) : undefined;
    this.emit({ type: 'outcome', label, ...(notes ? { notes } : {}) });
    this.track(campaign.onOutcome({ label, ...(notes ? { notes } : {}) }), 'outcome hook');
  }

  private pushSpeech(turn: ActiveTurn, pipeline: SpeechPipeline, text: string): void {
    this.emit({ type: 'transcript', role: 'assistant', text, final: false });
    pipeline.push(text);
  }

  private createPipeline(turn: ActiveTurn): SpeechPipeline {
    const { language } = this.config;
    return (turn.pipeline = new SpeechPipeline({
      // Timeouts, retries and fallback voices are handled by the voice chain. Chat mode has no
      // audio: segments complete at once and the text reaches the client as transcript events.
      synthesize: (text, signal) => (this.mode === 'chat' ? noAudio() : this.voice.stream({ text, language }, signal)),
      signal: turn.controller.signal,
      now: this.now,
      onSegmentStart: (text) => turn.playout.beginSegment(text),
      onAudio: (segmentId, bytes) => this.sendTurnAudio(turn, segmentId, bytes),
      onSegmentEnd: (segmentId) => turn.playout.completeSegment(segmentId),
    }));
  }

  private sendTurnAudio(turn: ActiveTurn, segmentId: number, bytes: Uint8Array): void {
    if (turn.controller.signal.aborted || this.activeTurn !== turn || this.sm.isEnded || this.assistantMuted) return;
    const audio = turn.outConverter.convert(bytes);
    if (audio.length === 0) return;
    if (!turn.audioStarted) {
      turn.audioStarted = true;
      turn.record.timestamps.agentAudioStartAt = this.now();
      if (!this.sm.is('speaking', 'transferring')) this.sm.transition('speaking', turn.record.kind);
      this.commitUserText(turn);
    }
    this.transport.sendAudio(audio);
    turn.playout.addAudio(segmentId, durationMs(this.transport.outputFormat, audio.length));
  }

  private commitUserText(turn: ActiveTurn): void {
    if (turn.userCommitted || !turn.record.userText) return;
    turn.userCommitted = true;
    this.history.push({ role: 'user', content: turn.record.userText, at: turn.record.timestamps.userSpeechEndAt ?? this.now() });
  }

  private async waitForPlayout(turn: ActiveTurn): Promise<void> {
    for (;;) {
      const remaining = turn.playout.playbackEndsAt - this.now();
      if (remaining <= 0 || turn.controller.signal.aborted) return;
      // Whole milliseconds: a sub-ms timer would not move an integer clock and could spin
      await sleep(Math.ceil(remaining), turn.controller.signal);
    }
  }

  /** Close out a turn: write history and metrics. */
  private finalizeTurn(turn: ActiveTurn, outcome: { interrupted: boolean; at?: number }): void {
    if (turn.finalized) return;
    turn.finalized = true;
    turn.dispose();
    const record = turn.record;
    if (turn.pipeline) {
      const timing = turn.pipeline.firstTiming;
      record.timestamps.ttsRequestAt ??= timing.requestAt;
      record.timestamps.ttsFirstByteAt ??= timing.firstByteAt;
    }
    this.commitUserText(turn);
    if (outcome.interrupted) {
      const heard = turn.playout.heardText(outcome.at ?? this.now());
      record.heardText = heard.text;
      record.interrupted = true;
    } else {
      record.heardText = record.generatedText.trim();
      if (turn.audioStarted) record.timestamps.agentAudioEndAt = turn.playout.playbackEndsAt;
    }
    if (record.heardText) {
      this.history.push({
        role: 'assistant',
        content: record.heardText,
        at: this.now(),
        kind: record.kind,
        ...(record.interrupted ? { interrupted: true } : {}),
      });
    }
    record.latency = computeLatency(record.timestamps);
    this.turns.push(record);
    if (record.kind === 'reply') this.latencyRecorder?.record(record);
    if (this.activeTurn === turn) this.activeTurn = null;
    this.log.info(
      {
        turn: record.index,
        kind: record.kind,
        interrupted: record.interrupted,
        heard_chars: record.heardText.length,
        generated_chars: record.generatedText.length,
        ...record.latency,
      },
      'turn complete'
    );
    if (record.heardText) {
      const spokenAt = record.timestamps.agentAudioStartAt ?? record.timestamps.llmRequestAt ?? this.now();
      const spokenEnd = (record.interrupted ? record.timestamps.playbackStoppedAt : record.timestamps.agentAudioEndAt) ?? this.now();
      this.emit({ type: 'transcript', role: 'assistant', text: record.heardText, final: true, startedAt: spokenAt, endedAt: Math.max(spokenAt, spokenEnd), ...(record.interrupted ? { interrupted: true } : {}) });
    }
    this.emit({ type: 'turn', turn: record });
  }

  private bargeIn(turn: ActiveTurn, speechAt: number): void {
    const stoppedAt = this.now();
    this.transport.clearAudio();
    turn.controller.abort();
    turn.record.timestamps.interruptSpeechAt = speechAt;
    turn.record.timestamps.playbackStoppedAt = stoppedAt;
    this.finalizeTurn(turn, { interrupted: true, at: stoppedAt });
    this.log.info({ turn: turn.id, barge_in_stop_ms: stoppedAt - speechAt, heard: turn.record.heardText.length }, 'barge-in');
    this.emit({ type: 'interrupted', at: stoppedAt, heardText: turn.record.heardText });
    this.sm.transition('listening', 'barge-in');
    // The STT received silence while the agent talked; give it the caller's real words
    if (this.stt) for (const samples of this.preRoll) this.stt.sendAudio(samples);
  }

  private cancelTurn(turn: ActiveTurn, reason: string): void {
    turn.controller.abort();
    if (turn.record.userText && !turn.userCommitted) {
      this.pendingUserText = [turn.record.userText, this.pendingUserText].filter(Boolean).join(' ');
    }
    if (this.activeTurn === turn) this.activeTurn = null;
    this.log.info({ turn: turn.id, kind: turn.record.kind, reason }, 'turn cancelled');
    if (this.sm.is('thinking')) this.sm.transition('listening', reason);
  }

  private backToListening(): void {
    if (this.terminating || this.sm.isEnded) return;
    this.sm.transition('listening', 'agent finished');
    this.armIdleTimer();
    this.ensureFallbackPrefetch();
  }

  /** Synthesize the fallback message once, after the greeting (keeps TTS concurrency low). */
  private ensureFallbackPrefetch(): void {
    const { fallback } = this.config;
    if (this.mode === 'chat' || this.fallbackAudio || !fallback.prefetchAudio || !fallback.message.trim()) return;
    this.fallbackAudio = this.prefetchFallbackAudio();
  }

  /** Speak fixed text (first message, reminder, goodbye). */
  private async runFixedTurn(kind: TurnKind, text: string, then: 'listen' | 'stay'): Promise<SpeakOutcome> {
    const turn = this.newTurn(kind);
    try {
      turn.record.generatedText = text;
      const pipeline = this.createPipeline(turn);
      const chunker = new SentenceChunker();
      for (const chunk of [...chunker.push(text), ...chunker.flush()]) this.pushSpeech(turn, pipeline, chunk);
      pipeline.finish();
      await pipeline.done;
      if (turn.controller.signal.aborted) return turn.record.interrupted ? 'interrupted' : 'cancelled';
      await this.waitForPlayout(turn);
      if (turn.controller.signal.aborted) return turn.record.interrupted ? 'interrupted' : 'cancelled';
      this.finalizeTurn(turn, { interrupted: false });
      if (then === 'listen') this.backToListening();
      return 'completed';
    } catch (error) {
      await this.handleTurnError(turn, error);
      return 'cancelled';
    }
  }

  private async handleTurnError(turn: ActiveTurn, error: unknown): Promise<void> {
    if (this.sm.isEnded) return;
    if (turn.controller.signal.aborted) {
      if (!isAbortError(error)) this.log.debug({ err: error, turn: turn.id }, 'error after turn was cancelled (ignored)');
      return;
    }
    if (error instanceof ProviderError) {
      if (this.terminating) return;
      await this.failOver(error.stage, error, turn);
      return;
    }
    this.log.error({ err: error, turn: turn.id }, 'unexpected error in turn');
    await this.end(EndReason.ErrorInternal, { error: { stage: 'internal', message: error instanceof Error ? error.message : String(error) } });
  }

  // ---------------------------------------------------------------- idle, max duration, failure

  private armIdleTimer(): void {
    this.clearIdleTimer();
    const { timeoutMs } = this.config.idle;
    // Typing takes longer than speaking; chat calls are bounded by maxDurationMs instead
    if (timeoutMs <= 0 || this.terminating || this.mode === 'chat') return;
    this.idleTimer = setTimeout(() => void this.onIdle(), timeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async onIdle(): Promise<void> {
    this.idleTimer = null;
    if (this.terminating || !this.sm.is('listening') || this.activeTurn || this.detector.inSpeech) return;
    const { idle } = this.config;
    if (this.idlePrompts < idle.maxPrompts) {
      this.idlePrompts++;
      this.log.info({ prompt: this.idlePrompts, of: idle.maxPrompts }, 'caller silent, reminding');
      await this.runFixedTurn('idle-prompt', idle.message, 'listen');
      return;
    }
    this.log.info({ prompts: this.idlePrompts }, 'caller silent, ending call');
    this.terminating = true;
    if (idle.endMessage.trim()) await this.runFixedTurn('goodbye', idle.endMessage, 'stay');
    await this.end(EndReason.SilenceTimeout);
  }

  private async onMaxDuration(): Promise<void> {
    if (this.terminating || this.sm.isEnded) return;
    this.log.info({ max_duration_ms: this.config.maxDurationMs }, 'max call duration reached');
    this.terminating = true;
    this.stopActiveTurn();
    if (this.config.maxDurationMessage.trim()) await this.runFixedTurn('goodbye', this.config.maxDurationMessage, 'stay');
    await this.end(EndReason.MaxDuration);
  }

  /** Abort the active turn, stop far-end playback, and keep what the caller heard. */
  private stopActiveTurn(): void {
    const turn = this.activeTurn;
    if (!turn) return;
    turn.controller.abort();
    if (turn.audioStarted) {
      this.transport.clearAudio();
      this.finalizeTurn(turn, { interrupted: true });
    } else if (this.activeTurn === turn) {
      this.activeTurn = null;
    }
  }

  /**
   * A provider failed after its retry: tell the caller, then end or transfer. The fallback message
   * uses audio synthesized at call start when available, so it still plays if TTS is the problem.
   */
  private async failOver(stage: ProviderStage, error: unknown, failedTurn?: ActiveTurn): Promise<void> {
    if (this.terminating || this.sm.isEnded) return;
    this.terminating = true;
    const chainFor = { stt: this.transcriber, llm: this.model, tts: this.voice }[stage];
    const providerError = toProviderError(error, stage, chainFor.current.provider);
    this.log.error({ stage, provider: providerError.provider, err: providerError, code: providerError.code, turn: failedTurn?.id }, 'provider failed, failing over');
    this.emit({ type: 'error', stage, message: providerError.message });
    this.emitDebug({ type: 'provider-error', at: this.now(), stage, provider: providerError.provider, model: chainFor.current.model, ...(providerError.code ? { code: providerError.code } : {}), message: providerError.message, retryable: providerError.retryable });
    this.clearIdleTimer();
    this.stopActiveTurn();
    await this.speakFallback(stage);

    const { fallback } = this.config;
    const errorDetail = { error: { stage, message: providerError.message } };
    if (fallback.action === 'transfer' && fallback.transferTo) {
      await this.transferTo(fallback.transferTo, errorEndReason(stage), errorDetail);
    } else {
      await this.end(errorEndReason(stage), errorDetail);
    }
  }

  private async speakFallback(stage: ProviderStage): Promise<void> {
    const message = this.config.fallback.message.trim();
    if (!message || this.sm.isEnded) return;
    const audio = this.fallbackAudio ? await this.fallbackAudio : null;
    if (audio && audio.length > 0) {
      const turn = this.newTurn('fallback');
      turn.record.generatedText = message;
      const segment = turn.playout.beginSegment(message);
      for (const bytes of audio) this.sendTurnAudio(turn, segment, bytes);
      turn.playout.completeSegment(segment);
      await this.waitForPlayout(turn);
      this.finalizeTurn(turn, { interrupted: false });
      return;
    }
    if (stage === 'tts') {
      this.log.warn({}, 'no fallback audio available and TTS is down; ending without a spoken message');
      return;
    }
    await this.runFixedTurn('fallback', message, 'stay');
  }

  private async prefetchFallbackAudio(): Promise<Uint8Array[] | null> {
    const chunks: Uint8Array[] = [];
    try {
      const text = this.config.fallback.message;
      for await (const chunk of this.voice.stream({ text, language: this.config.language }, this.lifetime.signal)) chunks.push(chunk);
      return chunks;
    } catch (err) {
      this.log.warn({ err }, 'could not prefetch fallback audio');
      return null;
    }
  }

  private findDestination(name: string): TransferDestination | undefined {
    return this.config.tools.transferCall.destinations.find((d) => d.name === name);
  }

  private async transferTo(name: string, reason: EndReason, detail?: { error?: CallSummary['error'] }, failureAction: 'return-to-agent' | 'take-message' | 'end' = 'end'): Promise<void> {
    if (this.sm.isEnded) return;
    const destination = this.findDestination(name) ?? { name, target: name };
    this.terminating = true;
    this.clearIdleTimer();
    this.sm.transition('transferring', destination.name);
    try {
      await withTimeout(this.transport.transfer(destination), TRANSFER_TIMEOUT_MS, 'transfer');
      this.transferredTo = destination.name;
      this.log.info({ destination: destination.name }, 'call transferred');
      await this.end(reason, detail);
    } catch (err) {
      this.log.error({ err, destination: destination.name }, 'transfer failed');
      if (failureAction === 'return-to-agent') {
        this.terminating = false;
        this.backToListening();
        return;
      }
      if (failureAction === 'take-message') await this.runFixedTurn('goodbye', 'I could not reach the person you requested. Please leave a message after the tone.', 'stay');
      await this.end(detail?.error ? reason : EndReason.ErrorInternal, { error: detail?.error ?? { stage: 'transfer', message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private emitDebug(event: DebugEvent): void {
    for (const listener of this.debugListeners) {
      try {
        listener(event);
      } catch (err) {
        this.log.warn({ err }, 'debug listener threw');
      }
    }
  }

  private emit(event: SessionEvent): void {
    try {
      this.transport.sendEvent(event);
    } catch (err) {
      this.log.warn({ err, event: event.type }, 'transport rejected event');
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.log.warn({ err }, 'session listener threw');
      }
    }
  }
}
