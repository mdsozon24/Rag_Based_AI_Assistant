/**
 * Per-turn timestamps and latency breakdown, plus p50/p95 summaries.
 *
 * All timestamps are ms epoch on the voice node. "Agent audio start" is when the first agent audio
 * of the turn left the engine (platform edge), not when the client played it.
 */

export const VOICE_TO_VOICE_TARGET_MS = 800;

export interface TurnTimestamps {
  /** Onset of the user's speech (VAD). */
  userSpeechStartAt?: number;
  /** End of the user's last speech frame (VAD). */
  userSpeechEndAt?: number;
  /** Endpoint decided (userSpeechEndAt + silence threshold); STT commit sent. */
  endpointAt?: number;
  sttFinalAt?: number;
  llmRequestAt?: number;
  llmFirstTokenAt?: number;
  /** First text chunk handed to TTS. */
  ttsRequestAt?: number;
  ttsFirstByteAt?: number;
  /** First agent audio sent to the transport. */
  agentAudioStartAt?: number;
  /** When the caller finished hearing the agent (estimated play-out end). */
  agentAudioEndAt?: number;
  /** Barge-in: user speech onset that interrupted the agent. */
  interruptSpeechAt?: number;
  /** Barge-in: playback-stop (clear) sent to the transport. */
  playbackStoppedAt?: number;
}

export interface TurnLatency {
  /** Silence waited before the endpoint (≈ configured silenceMs). */
  endpointingMs?: number;
  /** STT final after commit. */
  sttFinalMs?: number;
  /** LLM first token after request. */
  llmFirstTokenMs?: number;
  /** TTS first audio byte after request. */
  ttsFirstByteMs?: number;
  /** End of user speech to first agent audio (what the caller experiences). */
  voiceToVoiceMs?: number;
  /** Endpoint to first agent audio (pipeline time, excludes the silence wait). */
  pipelineMs?: number;
  /** User speech onset to playback stop on barge-in. */
  bargeInStopMs?: number;
}

/** typed-reply: an answer to typed text (chat mode or SDK send()); excluded from voice latency. */
export type TurnKind = 'first-message' | 'reply' | 'typed-reply' | 'idle-prompt' | 'fallback' | 'goodbye';

export interface TurnRecord {
  index: number;
  kind: TurnKind;
  userText: string;
  /** Full text the agent generated for this turn. */
  generatedText: string;
  /** Text the caller actually heard (equals generatedText unless interrupted). */
  heardText: string;
  interrupted: boolean;
  timestamps: TurnTimestamps;
  latency: TurnLatency;
}

function diff(end?: number, start?: number): number | undefined {
  return end !== undefined && start !== undefined ? Math.max(0, end - start) : undefined;
}

export function computeLatency(t: TurnTimestamps): TurnLatency {
  return {
    endpointingMs: diff(t.endpointAt, t.userSpeechEndAt),
    sttFinalMs: diff(t.sttFinalAt, t.endpointAt),
    llmFirstTokenMs: diff(t.llmFirstTokenAt, t.llmRequestAt),
    ttsFirstByteMs: diff(t.ttsFirstByteAt, t.ttsRequestAt),
    voiceToVoiceMs: diff(t.agentAudioStartAt, t.userSpeechEndAt),
    pipelineMs: diff(t.agentAudioStartAt, t.endpointAt),
    bargeInStopMs: diff(t.playbackStoppedAt, t.interruptSpeechAt),
  };
}

/** Percentile with linear interpolation between closest ranks (p in 0..100). */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export interface LatencySummary {
  count: number;
  p50?: number;
  p95?: number;
  min?: number;
  max?: number;
}

export type LatencyMetric = keyof TurnLatency;

export const LATENCY_METRICS: readonly LatencyMetric[] = [
  'endpointingMs',
  'sttFinalMs',
  'llmFirstTokenMs',
  'ttsFirstByteMs',
  'voiceToVoiceMs',
  'pipelineMs',
  'bargeInStopMs',
];

export function summarizeLatency(turns: Pick<TurnRecord, 'latency'>[]): Record<LatencyMetric, LatencySummary> {
  const summary = {} as Record<LatencyMetric, LatencySummary>;
  for (const metric of LATENCY_METRICS) {
    const values = turns.map((t) => t.latency[metric]).filter((v): v is number => v !== undefined);
    const round = (v?: number) => (v === undefined ? undefined : Math.round(v));
    summary[metric] = {
      count: values.length,
      p50: round(percentile(values, 50)),
      p95: round(percentile(values, 95)),
      min: round(values.length ? Math.min(...values) : undefined),
      max: round(values.length ? Math.max(...values) : undefined),
    };
  }
  return summary;
}

/** Rolling window of turn latencies across calls (for the dev server and future /metrics). */
export class LatencyRecorder {
  private turns: Pick<TurnRecord, 'latency'>[] = [];

  constructor(private readonly capacity = 1000) {}

  record(turn: Pick<TurnRecord, 'latency'>): void {
    this.turns.push({ latency: turn.latency });
    if (this.turns.length > this.capacity) this.turns.shift();
  }

  summary(): Record<LatencyMetric, LatencySummary> {
    return summarizeLatency(this.turns);
  }
}
