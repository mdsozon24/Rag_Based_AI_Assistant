/**
 * Energy-based voice activity detection with endpointing.
 *
 * Classifies 20 ms frames as speech when they are clearly above an adaptive noise floor, then
 * turns frame decisions into two events:
 * - speech-start after `minSpeechMs` of speech (used to open a user turn and for barge-in);
 * - speech-end after `silenceMs` of non-speech (the endpoint: the user finished talking).
 *
 * While the agent is speaking the caller raises the threshold (`extraMarginDb`) and the minimum
 * speech length, so residual echo does not count as the user talking.
 */

export interface SpeechDetectorOptions {
  sampleRate: number;
  frameMs: number;
  /** Frame must be this many dB above the noise floor to count as speech. */
  marginDb: number;
  /** Frames quieter than this (dBFS) are never speech, whatever the noise floor. */
  minSpeechDb: number;
  /** Speech this long opens a turn. */
  minSpeechMs: number;
  /** Silence this long after speech ends the turn. */
  silenceMs: number;
}

export type SpeechEvent =
  | { type: 'speech-start'; /** Onset of the first speech frame (ms epoch). */ at: number }
  | { type: 'speech-end'; /** End of the last speech frame (ms epoch). */ at: number; durationMs: number };

export const DEFAULT_DETECTOR_OPTIONS: SpeechDetectorOptions = {
  sampleRate: 16000,
  frameMs: 20,
  marginDb: 12,
  minSpeechDb: -50,
  minSpeechMs: 120,
  silenceMs: 600,
};

const MIN_NOISE_FLOOR_DB = -90;
/**
 * Noise floor = quietest frame in this window (minimum statistics). It follows steady background
 * noise within one window, but not speech, which always has quieter gaps between syllables.
 */
const NOISE_WINDOW_MS = 1500;
/**
 * Prior for the window before anything is observed: a quiet room. Without it a caller who
 * talks from the first frame would be learned as "noise". Steady noise louder than this is
 * learned within one window (it may open one empty turn first, which STT returns as no text).
 */
const PRIOR_NOISE_DB = -65;
/** A single quiet frame inside a word does not reset the speech run. */
const GAP_TOLERANCE_FRAMES = 1;

export function frameDb(samples: Int16Array, start = 0, end = samples.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, end - start));
  return rms > 0 ? 20 * Math.log10(rms / 32768) : -120;
}

export class SpeechDetector {
  private options: SpeechDetectorOptions;
  private extraMarginDb = 0;
  private readonly frameSamples: number;
  private pending: Int16Array = new Int16Array(0);
  private noiseFloor = MIN_NOISE_FLOOR_DB;
  private readonly recentDb: Float64Array;
  private recentCount = 0;
  private recentNext = 0;
  private speaking = false;
  private speechRunMs = 0;
  private gapFrames = 0;
  private runStartAt = 0;
  private silenceRunMs = 0;
  private speechStartAt = 0;
  private lastSpeechAt = 0;

  constructor(
    options: Partial<SpeechDetectorOptions> = {},
    private readonly now: () => number = Date.now
  ) {
    this.options = { ...DEFAULT_DETECTOR_OPTIONS, ...options };
    this.frameSamples = Math.round((this.options.sampleRate * this.options.frameMs) / 1000);
    this.recentDb = new Float64Array(Math.max(1, Math.round(NOISE_WINDOW_MS / this.options.frameMs))).fill(PRIOR_NOISE_DB);
    this.recentCount = this.recentDb.length;
  }

  get inSpeech(): boolean {
    return this.speaking;
  }

  get noiseFloorDb(): number {
    return this.noiseFloor;
  }

  /** Change turn-taking thresholds mid-call, e.g. stricter while the agent is speaking. */
  configure(update: { minSpeechMs?: number; silenceMs?: number; extraMarginDb?: number }): void {
    if (update.minSpeechMs !== undefined) this.options.minSpeechMs = update.minSpeechMs;
    if (update.silenceMs !== undefined) this.options.silenceMs = update.silenceMs;
    if (update.extraMarginDb !== undefined) this.extraMarginDb = update.extraMarginDb;
  }

  /** Forget the current speech run (keeps the learned noise floor). */
  resetSpeech(): void {
    this.speaking = false;
    this.speechRunMs = 0;
    this.gapFrames = 0;
    this.silenceRunMs = 0;
  }

  /** Feed PCM16 mono audio at `sampleRate`; returns the events this audio produced. */
  push(samples: Int16Array): SpeechEvent[] {
    const events: SpeechEvent[] = [];
    let audio = samples;
    if (this.pending.length > 0) {
      audio = new Int16Array(this.pending.length + samples.length);
      audio.set(this.pending, 0);
      audio.set(samples, this.pending.length);
    }
    const { frameMs } = this.options;
    const frameCount = Math.floor(audio.length / this.frameSamples);
    const arrivedAt = this.now();
    for (let f = 0; f < frameCount; f++) {
      const start = f * this.frameSamples;
      // Wall-clock end of this frame: the last sample of the chunk arrived "now"
      const remainingSamples = audio.length - (start + this.frameSamples);
      const frameEnd = arrivedAt - (remainingSamples / this.options.sampleRate) * 1000;
      const event = this.processFrame(frameDb(audio, start, start + this.frameSamples), frameEnd - frameMs, frameEnd);
      if (event) events.push(event);
    }
    this.pending = audio.slice(frameCount * this.frameSamples);
    return events;
  }

  private updateNoiseFloor(db: number): void {
    this.recentDb[this.recentNext] = db;
    this.recentNext = (this.recentNext + 1) % this.recentDb.length;
    this.recentCount = Math.min(this.recentCount + 1, this.recentDb.length);
    let min = Infinity;
    for (let i = 0; i < this.recentCount; i++) if (this.recentDb[i] < min) min = this.recentDb[i];
    this.noiseFloor = Math.max(MIN_NOISE_FLOOR_DB, min);
  }

  private processFrame(db: number, frameStart: number, frameEnd: number): SpeechEvent | null {
    const { frameMs, marginDb, minSpeechDb, minSpeechMs, silenceMs } = this.options;
    this.updateNoiseFloor(db);
    const isSpeech = db > Math.max(this.noiseFloor + marginDb + this.extraMarginDb, minSpeechDb + this.extraMarginDb);

    if (isSpeech) {
      if (this.speechRunMs === 0) this.runStartAt = frameStart;
      this.speechRunMs += frameMs;
      this.gapFrames = 0;
      this.lastSpeechAt = frameEnd;
      this.silenceRunMs = 0;
      if (!this.speaking && this.speechRunMs >= minSpeechMs) {
        this.speaking = true;
        this.speechStartAt = this.runStartAt;
        return { type: 'speech-start', at: this.runStartAt };
      }
      return null;
    }

    if (!this.speaking) {
      if (this.speechRunMs > 0 && ++this.gapFrames > GAP_TOLERANCE_FRAMES) {
        this.speechRunMs = 0;
        this.gapFrames = 0;
      }
      return null;
    }

    this.silenceRunMs += frameMs;
    if (this.silenceRunMs >= silenceMs) {
      const event: SpeechEvent = { type: 'speech-end', at: this.lastSpeechAt, durationMs: this.lastSpeechAt - this.speechStartAt };
      this.resetSpeech();
      return event;
    }
    return null;
  }
}
