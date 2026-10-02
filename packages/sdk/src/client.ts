/**
 * VoiceClient: one browser call at a time against the Voice of Octo API.
 *
 *   const client = new VoiceClient({ publicKey: 'pk_...', apiUrl: 'https://api.example.com' });
 *   client.on('message', (m) => ...);
 *   await client.start('assistant-id', { variables: { name: 'Ada' } });
 *
 * start(): POST /v1/calls with the public key (or use a call your server created), open the
 * media socket, send hello, wait for ready, then stream microphone frames and play agent audio.
 * A dropped socket is resumed with the server-issued resume token while the server keeps the call
 * (VOICE_RESUME_GRACE_MS). No DOM access here: audio and sockets are injected, so it unit-tests in Node.
 */
import { BrowserAudio } from './audio.ts';
import { apiError, closeError, OctoVoiceError } from './errors.ts';
import type { AudioIO, CallInfo, CallMode, CallStatus, Message, Role, ServerCreatedCall, SocketLike, StartOptions, VoiceClientEvents, VoiceClientOptions } from './types.ts';

export const PROTOCOL_VERSION = 1;
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const READY_TIMEOUT_MS = 10_000;
const RESUME_READY_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 5000;
const MAX_TEXT_CHARS = 2000;
/** Close code the client uses when it gives up on a silent connection (never sent by the server). */
const LIVENESS_CLOSE = 4999;

interface ReadyMessage {
  type: 'ready';
  callId: string;
  mode: CallMode;
  resumeToken: string;
  resumeGraceMs: number;
}

type Listener = (...args: any[]) => void;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class VoiceClient {
  private readonly listeners = new Map<keyof VoiceClientEvents, Set<Listener>>();
  private readonly apiUrl: string;
  private currentStatus: CallStatus = 'idle';
  private call: { id: string; wsUrl: string; mode: CallMode } | null = null;
  private socket: SocketLike | null = null;
  private audio: AudioIO | null = null;
  private resumeToken: string | null = null;
  private resumeGraceMs = 15_000;
  private muted = false;
  private speaking: Record<Role, boolean> = { user: false, assistant: false };
  private serverEndReason: string | null = null;
  /** Bumped whenever a socket is abandoned, so its late events are ignored. */
  private generation = 0;
  /** Bumped by every start() and teardown, so a stopped start() notices it was cancelled. */
  private attempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenAt = 0;

  constructor(private readonly options: VoiceClientOptions) {
    if (options.publicKey?.startsWith('sk_')) {
      throw new OctoVoiceError('invalid-key', 'Use a public key (pk_...) in the browser. Private keys (sk_...) must stay on your server.');
    }
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
  }

  // ---------------------------------------------------------------- events

  on<K extends keyof VoiceClientEvents>(event: K, listener: VoiceClientEvents[K]): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener as Listener);
    this.listeners.set(event, set);
    return () => this.off(event, listener);
  }

  off<K extends keyof VoiceClientEvents>(event: K, listener: VoiceClientEvents[K]): void {
    this.listeners.get(event)?.delete(listener as Listener);
  }

  private emit<K extends keyof VoiceClientEvents>(event: K, ...args: Parameters<VoiceClientEvents[K]>): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        listener(...args);
      } catch (error) {
        // A failing app listener must not break the call
        console.error(`[octo-voice] "${event}" listener threw`, error);
      }
    }
  }

  // ---------------------------------------------------------------- state

  get status(): CallStatus {
    return this.currentStatus;
  }

  get callId(): string | null {
    return this.call?.id ?? null;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  private setStatus(status: CallStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.emit('status', status);
  }

  private get inCall(): boolean {
    return this.currentStatus === 'connecting' || this.currentStatus === 'active' || this.currentStatus === 'reconnecting';
  }

  // ---------------------------------------------------------------- controls

  /**
   * Start a call with a saved assistant (by id), or connect a call your server created with a
   * private key (inline assistants, full overrides): start({ call: { id, connectToken, wsUrl } }).
   * Resolves once the call is live; rejects (and emits `error`) with an OctoVoiceError.
   */
  async start(target: string | { call: ServerCreatedCall }, options: StartOptions = {}): Promise<CallInfo> {
    if (this.inCall) throw new OctoVoiceError('invalid-request', 'A call is already in progress; stop it first.');
    const mode: CallMode = options.mode ?? 'voice';
    this.reset();
    this.setStatus('connecting');
    const attempt = ++this.attempt;
    const stillStarting = () => {
      if (this.attempt !== attempt || this.currentStatus !== 'connecting') throw new OctoVoiceError('not-active', 'The call was stopped before it connected.');
    };
    try {
      if (mode === 'voice') {
        this.audio = this.options.audio?.() ?? new BrowserAudio();
        // Before the call is created: a blocked microphone should not cost a call
        await this.audio.open({ inputSampleRate: INPUT_SAMPLE_RATE, outputSampleRate: OUTPUT_SAMPLE_RATE });
        stillStarting();
        this.audio.onLevel((level, source) => this.emit('volume-level', level, source));
        this.audio.onPlayback((playing) => this.setSpeaking('assistant', playing));
      }
      const call = typeof target === 'string' ? await this.createCall(target, options) : target.call;
      stillStarting();
      if (!call?.id || !call.connectToken || !call.wsUrl) throw new OctoVoiceError('invalid-request', 'start({ call }) needs the id, connectToken and wsUrl returned by POST /v1/calls.');
      this.call = { id: call.id, wsUrl: call.wsUrl, mode };
      const ready = await this.connectSocket({ type: 'hello', protocol: PROTOCOL_VERSION, token: call.connectToken, mode }, READY_TIMEOUT_MS);
      stillStarting();
      this.onReady(ready);
      this.audio?.startCapture((frame) => {
        if (this.currentStatus === 'active' && this.socket?.readyState === 1) this.socket.send(frame);
      });
      const info: CallInfo = { id: call.id, mode };
      this.emit('call-start', info);
      return info;
    } catch (error) {
      const failure = error instanceof OctoVoiceError ? error : new OctoVoiceError('server-error', error instanceof Error ? error.message : String(error), { cause: error });
      if (failure.code !== 'not-active') await this.finish('error', failure);
      throw failure;
    }
  }

  /** Hang up. Resolves once the call is torn down; safe to call at any time. */
  async stop(): Promise<void> {
    if (!this.inCall) return;
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ type: 'hangup' }));
    await this.finish('client-ended');
  }

  /** Mute the microphone (the agent hears silence; the call stays up). */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.audio?.setMuted(muted);
    if (muted) this.setSpeaking('user', false);
  }

  /** Send a typed user message; the assistant answers it like speech (and stops talking if it was). */
  send(message: string): void {
    this.sendText('message', message);
  }

  /** Make the assistant say this text now. */
  say(text: string): void {
    this.sendText('say', text);
  }

  private sendText(type: 'message' | 'say', value: string): void {
    const text = String(value ?? '').trim();
    if (this.currentStatus !== 'active' || this.socket?.readyState !== 1) throw new OctoVoiceError('not-active', 'There is no active call.');
    if (!text || text.length > MAX_TEXT_CHARS) throw new OctoVoiceError('invalid-request', `Messages must be 1 to ${MAX_TEXT_CHARS} characters.`);
    this.socket.send(JSON.stringify({ type, text }));
  }

  // ---------------------------------------------------------------- call creation

  private async createCall(assistantId: string, options: StartOptions): Promise<ServerCreatedCall> {
    if (!this.options.publicKey) throw new OctoVoiceError('invalid-key', 'Starting a call by assistant id needs a public key (pk_...). Or pass a call your server created: start({ call }).');
    const fetcher = this.options.fetch ?? globalThis.fetch.bind(globalThis);
    let response: Response;
    try {
      response = await fetcher(`${this.apiUrl}/v1/calls`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.publicKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ assistantId, variables: options.variables ?? {}, overrides: options.overrides ?? {}, ...(options.version ? { version: options.version } : {}) }),
      });
    } catch (error) {
      // Offline, DNS, or a CORS rejection: the browser does not say which
      throw new OctoVoiceError('network', 'Could not reach the voice service. Check your connection and try again.', { cause: error });
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw apiError(response.status, body as { code?: string; message?: string } | null, response.headers.get('x-request-id') ?? undefined);
    return body as unknown as ServerCreatedCall;
  }

  // ---------------------------------------------------------------- socket

  /** Open the media socket, send the handshake, resolve with `ready` (or reject with the close reason). */
  private connectSocket(handshake: Record<string, unknown>, timeoutMs: number): Promise<ReadyMessage> {
    const call = this.call as NonNullable<typeof this.call>;
    const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket: SocketLike;
      const fail = (error: OctoVoiceError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket?.close();
        } catch {
          // already closed
        }
        reject(error);
      };
      const timer = setTimeout(() => fail(new OctoVoiceError('network', 'Timed out connecting to the voice service.')), timeoutMs);
      try {
        socket = (this.options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike))(call.wsUrl);
      } catch (error) {
        fail(new OctoVoiceError('network', 'Could not open the voice connection.', { cause: error }));
        return;
      }
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      socket.onopen = () => socket.send(JSON.stringify(handshake));
      socket.onerror = () => {
        // A close event always follows; the reason is reported there
      };
      socket.onmessage = (event) => {
        if (generation !== this.generation) return;
        this.lastSeenAt = Date.now();
        if (settled) return this.onSocketMessage(event.data);
        if (typeof event.data !== 'string') return;
        const message = safeJson(event.data);
        if (message?.type !== 'ready') return;
        settled = true;
        clearTimeout(timer);
        resolve(message as unknown as ReadyMessage);
      };
      socket.onclose = (event) => {
        if (generation !== this.generation) return;
        if (!settled) return fail(closeError(event.code, event.reason) ?? new OctoVoiceError('network', 'The voice connection closed before the call started.', { closeCode: event.code }));
        this.onSocketClosed(event.code, event.reason);
      };
    });
  }

  private onReady(ready: ReadyMessage): void {
    this.resumeToken = ready.resumeToken;
    if (Number.isFinite(ready.resumeGraceMs)) this.resumeGraceMs = ready.resumeGraceMs;
    this.lastSeenAt = Date.now();
    this.startPing();
    this.setStatus('active');
  }

  private onSocketMessage(data: unknown): void {
    if (typeof data !== 'string') {
      if (data instanceof ArrayBuffer) this.audio?.play(data);
      return;
    }
    const event = safeJson(data);
    if (!event) return;
    switch (event.type) {
      case 'transcript':
        this.emit('message', { type: 'transcript', role: event.role === 'user' ? 'user' : 'assistant', text: String(event.text ?? ''), final: Boolean(event.final), ...(event.interrupted ? { interrupted: true } : {}) });
        return;
      case 'user-speech':
        this.setSpeaking('user', Boolean(event.speaking));
        return;
      case 'clear':
        this.audio?.clear();
        return;
      case 'interrupted':
        this.emit('message', { type: 'interrupted', heardText: String(event.heardText ?? '') });
        return;
      case 'tool-call':
        this.emit('message', { type: 'tool-call', name: String(event.name ?? ''), args: (event.args as Record<string, unknown>) ?? {} });
        return;
      case 'transfer':
        this.emit('message', { type: 'transfer', destination: event.destination as Extract<Message, { type: 'transfer' }>['destination'] });
        return;
      case 'error':
        this.emit('error', new OctoVoiceError('server-error', String(event.message ?? 'The voice service reported an error.'), { apiCode: String(event.stage ?? '') }));
        return;
      case 'ended':
        this.serverEndReason = String(event.reason ?? 'ended');
        return;
      default:
        // state, turn, pong: nothing to surface
        return;
    }
  }

  private onSocketClosed(code: number, reason: string): void {
    this.stopPing();
    if (!this.inCall) return;
    if (this.serverEndReason || code === 1000) {
      void this.finish(this.serverEndReason ?? 'ended');
      return;
    }
    // 4000-4998: the server refused or replaced this connection on purpose; do not retry
    if (code >= 4000 && code !== LIVENESS_CLOSE) {
      void this.finish('error', closeError(code, reason) ?? undefined);
      return;
    }
    if (this.options.reconnect?.enabled === false || !this.resumeToken) {
      void this.finish('error', new OctoVoiceError('connection-lost', 'The connection to the voice service was lost.', { closeCode: code }));
      return;
    }
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    this.setStatus('reconnecting');
    this.setSpeaking('user', false);
    const deadline = Date.now() + this.resumeGraceMs;
    const maxAttempts = this.options.reconnect?.maxAttempts ?? 20;
    let delay = this.options.reconnect?.initialDelayMs ?? 250;
    for (let attempt = 1; attempt <= maxAttempts && Date.now() < deadline; attempt++) {
      await sleep(delay);
      if (this.currentStatus !== 'reconnecting') return;
      try {
        const ready = await this.connectSocket({ type: 'resume', protocol: PROTOCOL_VERSION, resumeToken: this.resumeToken }, RESUME_READY_TIMEOUT_MS);
        if (this.currentStatus !== 'reconnecting') return;
        this.onReady(ready);
        return;
      } catch (error) {
        const closeCode = error instanceof OctoVoiceError ? error.details.closeCode : undefined;
        // The server answered and said no (call over, not resumable): stop trying
        if (closeCode !== undefined && closeCode >= 4000) {
          await this.finish('error', error as OctoVoiceError);
          return;
        }
      }
      delay = Math.min(delay * 2, 4000);
    }
    if (this.currentStatus === 'reconnecting') await this.finish('error', new OctoVoiceError('connection-lost', 'The connection to the voice service was lost and could not be restored.'));
  }

  /** Ping every few seconds; a connection with no traffic for livenessTimeoutMs is treated as dropped. */
  private startPing(): void {
    this.stopPing();
    const timeout = this.options.livenessTimeoutMs ?? 10_000;
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== 1) return;
      if (Date.now() - this.lastSeenAt > timeout) {
        // Half-open connection (e.g. the network changed): abandon it and resume on a new one
        this.generation++;
        try {
          socket.close(LIVENESS_CLOSE, 'liveness');
        } catch {
          // ignore
        }
        this.onSocketClosed(LIVENESS_CLOSE, 'liveness');
        return;
      }
      socket.send(JSON.stringify({ type: 'ping' }));
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private setSpeaking(role: Role, speaking: boolean): void {
    if (this.speaking[role] === speaking) return;
    this.speaking[role] = speaking;
    this.emit(speaking ? 'speech-start' : 'speech-end', { role });
  }

  private reset(): void {
    this.call = null;
    this.resumeToken = null;
    this.serverEndReason = null;
    this.muted = false;
    this.speaking = { user: false, assistant: false };
  }

  /** Tear down once: socket, audio (letting a goodbye finish playing), then call-end. */
  private async finish(reason: string, error?: OctoVoiceError): Promise<void> {
    if (!this.inCall) return;
    this.setStatus('ended');
    this.stopPing();
    this.generation++;
    this.attempt++;
    const socket = this.socket;
    this.socket = null;
    try {
      if (socket && (socket.readyState === 0 || socket.readyState === 1)) socket.close(1000, reason);
    } catch {
      // ignore
    }
    const audio = this.audio;
    this.audio = null;
    this.setSpeaking('user', false);
    // The server ended the call (e.g. after "goodbye"): let queued audio play out
    await audio?.close({ drain: reason !== 'client-ended' && !error }).catch(() => {});
    this.setSpeaking('assistant', false);
    if (error) this.emit('error', error);
    this.emit('call-end', { reason, ...(error ? { error } : {}) });
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
