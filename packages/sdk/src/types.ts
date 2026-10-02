/**
 * Public types of @octo/web. The wire protocol (v1) is documented in docs/API.md
 * ("Browser call protocol") and implemented server-side in packages/engine/src/transport/browser.ts.
 */
import type { OctoVoiceError } from './errors.ts';

export type CallMode = 'voice' | 'chat';

/** A call created by your server with a private key (POST /v1/calls), handed to the browser. */
export interface ServerCreatedCall {
  id: string;
  connectToken: string;
  wsUrl: string;
}

export interface StartOptions {
  /** Values for the assistant's {{variables}}. */
  variables?: Record<string, string>;
  /**
   * Per-call overrides. With a public key only firstMessage, firstMessageMode, language,
   * endpointing, interruption, idle and voice.voiceId are allowed; anything else needs a call
   * created by your server (start({ call })).
   */
  overrides?: Record<string, unknown>;
  /** A specific published version instead of the live one. */
  version?: number;
  /** voice (default): microphone and speaker. chat: typed messages only, no microphone. */
  mode?: CallMode;
}

export interface CallInfo {
  id: string;
  mode: CallMode;
}

export type CallStatus = 'idle' | 'connecting' | 'active' | 'reconnecting' | 'ended';

export type Role = 'user' | 'assistant';

export type Message =
  /** Speech or text. Partial (final=false) transcripts are replaced by the next one for the same role. */
  | { type: 'transcript'; role: Role; text: string; final: boolean; interrupted?: boolean }
  /** The user interrupted the assistant; heardText is what they heard before it stopped. */
  | { type: 'interrupted'; heardText: string }
  | { type: 'tool-call'; name: string; args: Record<string, unknown> }
  /** The assistant asked to transfer the caller (a browser call cannot be bridged; handle it in your page). */
  | { type: 'transfer'; destination: { name: string; target: string } };

export interface VoiceClientEvents {
  'call-start': (call: CallInfo) => void;
  /** reason: an end reason from the server (customer-hung-up, assistant-ended, silence-timeout, ...), or client-ended / error. */
  'call-end': (event: { reason: string; error?: OctoVoiceError }) => void;
  'speech-start': (event: { role: Role }) => void;
  'speech-end': (event: { role: Role }) => void;
  message: (message: Message) => void;
  /** 0..1, about 20 times a second while audio flows. */
  'volume-level': (level: number, source: Role) => void;
  error: (error: OctoVoiceError) => void;
  /** Connection status changes (connecting, active, reconnecting, ended). */
  status: (status: CallStatus) => void;
}

/** The minimal WebSocket surface the client uses (the browser's WebSocket satisfies it). */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

/** Microphone capture and speaker playback (BrowserAudio in browsers; a fake in tests). */
export interface AudioIO {
  /** Ask for the microphone. Rejects with an OctoVoiceError (mic-permission-denied, ...). */
  open(formats: { inputSampleRate: number; outputSampleRate: number }): Promise<void>;
  /** Deliver PCM16 mono frames at inputSampleRate. Frames keep coming while muted (as silence). */
  startCapture(onFrame: (pcm16: ArrayBuffer) => void): void;
  setMuted(muted: boolean): void;
  /** Queue PCM16 mono audio at outputSampleRate for gapless playback. */
  play(pcm16: ArrayBuffer): void;
  /** Stop playback now and drop everything queued (barge-in). */
  clear(): void;
  /** Release the microphone and audio output; drain lets queued audio finish first. */
  close(options?: { drain?: boolean }): Promise<void>;
  onLevel(listener: (level: number, source: Role) => void): void;
  /** Assistant audio started (true) or ran out (false). */
  onPlayback(listener: (playing: boolean) => void): void;
}

export interface VoiceClientOptions {
  /**
   * A public key (pk_...). Never put a private key (sk_...) in a browser or app. Needed only to
   * start calls by assistant id: start({ call }) with a call your server created needs none.
   */
  publicKey?: string;
  /** API base URL, e.g. https://api.voiceofocto.com */
  apiUrl: string;
  /** Audio implementation; default BrowserAudio (Web Audio + getUserMedia). */
  audio?: () => AudioIO;
  /** WebSocket factory; default the browser WebSocket. */
  createSocket?: (url: string) => SocketLike;
  fetch?: typeof fetch;
  /** Reconnect after a network drop. Default: on, for as long as the server keeps the call. */
  reconnect?: { enabled?: boolean; maxAttempts?: number; initialDelayMs?: number };
  /** No pong from the server for this long → treat the connection as dropped (ms). Default 10000. */
  livenessTimeoutMs?: number;
}
