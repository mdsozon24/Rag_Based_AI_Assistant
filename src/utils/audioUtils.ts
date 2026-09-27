/**
 * Audio processing utilities for Gemini Live API and Gemini TTS
 * Handles PCM 16-bit little-endian conversion, base64 encoding/decoding,
 * gapless scheduling at 24kHz, and microphone capture at 16kHz.
 */

// Convert Float32 audio samples from Web Audio API to 16-bit PCM ArrayBuffer
export function float32ToInt16PCM(float32Array: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true); // little-endian
  }
  return buffer;
}

// Convert ArrayBuffer / Int16 PCM to base64 string
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// Convert base64 PCM string to Float32Array for AudioBuffer playback
export function base64ToFloat32PCM(base64: string): Float32Array {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const int16Array = new Int16Array(bytes.buffer);
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768.0;
  }
  return float32Array;
}

/**
 * Gapless Audio Queue Player for Gemini 24kHz PCM audio chunks
 */
export class GaplessPcmPlayer {
  private audioCtx: AudioContext | null = null;
  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  public isPlaying = false;
  private onEndedCallback?: () => void;

  constructor(sampleRate: number = 24000) {
    // Lazy AudioContext initialization
    if (typeof window !== 'undefined') {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtxClass) {
        this.audioCtx = new AudioCtxClass({ sampleRate });
      }
    }
  }

  public getAudioContext(): AudioContext | null {
    return this.audioCtx;
  }

  public async resume(): Promise<void> {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
  }

  public queuePcmBase64(base64: string): void {
    if (!this.audioCtx) return;

    try {
      const float32Data = base64ToFloat32PCM(base64);
      if (float32Data.length === 0) return;

      const audioBuffer = this.audioCtx.createBuffer(1, float32Data.length, this.audioCtx.sampleRate);
      audioBuffer.copyToChannel(float32Data, 0);

      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioCtx.destination);

      const currentTime = this.audioCtx.currentTime;
      if (this.nextStartTime < currentTime) {
        // Start a little ahead so network jitter between streamed chunks does not break words apart
        this.nextStartTime = currentTime + 0.12;
      }

      source.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;
      this.isPlaying = true;
      this.activeSources.push(source);

      source.onended = () => {
        const index = this.activeSources.indexOf(source);
        if (index > -1) {
          this.activeSources.splice(index, 1);
        }
        if (this.activeSources.length === 0) {
          this.isPlaying = false;
          if (this.onEndedCallback) {
            this.onEndedCallback();
          }
        }
      };
    } catch (err) {
      console.error('Error queuing PCM audio chunk:', err);
    }
  }

  public stop(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {
        // Source already ended
      }
    }
    this.activeSources = [];
    if (this.audioCtx) {
      this.nextStartTime = this.audioCtx.currentTime;
    }
    this.isPlaying = false;
  }

  public setOnEnded(callback: () => void): void {
    this.onEndedCallback = callback;
  }
}

/**
 * Detects the user starting to talk while the AI is speaking ("barge-in").
 * Mic loudness is compared with the level of the AI's own voice leaking into the mic (whatever
 * echo cancellation leaves), learned at the start of each reply, so speaker bleed does not
 * trigger it. Recent frames are kept so the start of the user's words can still be sent.
 */
export class BargeInDetector {
  private echoLevel = 0;
  private warmupFrames = 0;
  private loudFrames = 0;
  private preRoll: Float32Array[] = [];

  constructor(
    private readonly minRms = 0.02, // quietest level counted as speech
    private readonly echoFactor = 2.5, // how much louder than the echo the user must be
    private readonly triggerFrames = 4, // ~256ms of speech at 64ms frames
    private readonly warmup = 5, // frames used to learn the echo level (~320ms)
    private readonly preRollFrames = 8 // ~512ms of audio sent from before the detection
  ) {}

  /**
   * Feed one mic frame captured while the AI is speaking. Returns the buffered frames, oldest
   * first and including this one, once the user has started talking; otherwise null.
   * minSpeechRms raises the bar, e.g. to the main-speaker level so side voices cannot interrupt.
   */
  process(frame: Float32Array, rms: number, minSpeechRms = this.minRms): Float32Array[] | null {
    this.preRoll.push(new Float32Array(frame)); // the processor reuses its input buffer
    if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();

    if (this.warmupFrames < this.warmup) {
      this.warmupFrames++;
      this.echoLevel = Math.max(this.echoLevel * 0.9, rms);
      return null;
    }

    const threshold = Math.max(this.minRms, minSpeechRms, this.echoLevel * this.echoFactor);
    if (rms > threshold) {
      this.loudFrames++;
    } else {
      this.loudFrames = Math.max(0, this.loudFrames - 1);
      this.echoLevel = this.echoLevel * 0.9 + rms * 0.1;
    }
    if (this.loudFrames < this.triggerFrames) return null;

    const frames = this.preRoll;
    this.reset();
    return frames;
  }

  /** The AI stopped speaking: learn the echo level again for the next reply. */
  reset(): void {
    this.echoLevel = 0;
    this.warmupFrames = 0;
    this.loudFrames = 0;
    this.preRoll = [];
  }
}

/**
 * Lets through only the main speaker, the person close to the mic, and turns everything else
 * (other people talking nearby, TV, fans) into silence, so the model listens to one person.
 * A frame counts as the main speaker when it is well above the steady background noise and
 * within ~9 dB of the user's own speaking level; a voice across the room reaches the mic several
 * times quieter than the person at it. Until the user has spoken once, the first clear voice is
 * taken as theirs. A short pre-roll and hangover keep word starts and pauses between words.
 */
const QUIET_ROOM_RMS = 0.002;

export class MainSpeakerGate {
  private recentLevels: number[] = [];
  private noiseFloor = QUIET_ROOM_RMS;
  private speakerLevel = 0;
  private open = false;
  private loudFrames = 0;
  private hangover = 0;
  private preRoll: Float32Array[] = [];

  constructor(
    private readonly minSpeechRms = 0.004, // quietest level ever counted as speech (~-48 dBFS)
    private readonly noiseFactor = 3.5, // speech must be this much louder than the steady background
    private readonly speakerRatio = 0.35, // ...and within ~9 dB of the user's own (peak) speaking level
    private readonly noiseWindowFrames = 31, // ~2s: background = quietest moment in this window
    private readonly openFrames = 2, // ~128ms of speech opens the gate
    private readonly hangoverFrames = 12, // ~770ms: short pauses between words stay open
    private readonly preRollFrames = 5 // ~320ms sent from before the gate opened
  ) {}

  /** Level a sound must reach to count as the main speaker. */
  threshold(): number {
    return Math.max(this.noiseThreshold(), this.speakerLevel * this.speakerRatio);
  }

  /** Returns the frames to send for this mic frame, oldest first; empty means send silence. */
  process(frame: Float32Array, rms: number): Float32Array[] {
    this.trackNoiseFloor(rms);
    const threshold = this.threshold();
    const isMainSpeaker = rms > threshold;

    if (this.open) {
      if (isMainSpeaker) {
        this.hangover = this.hangoverFrames;
        this.learnSpeakerLevel(rms);
      } else if (--this.hangover <= 0) {
        this.open = false;
        this.loudFrames = 0;
      }
      return [frame];
    }

    this.preRoll.push(new Float32Array(frame)); // the processor reuses its input buffer
    if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
    // Nobody is talking: slowly forget the user's level (halves in ~20s of silence) in case they
    // moved further from the mic. Side voices do not count as silence, so they cannot lower it.
    if (rms <= this.noiseThreshold()) this.speakerLevel *= 0.998;
    this.loudFrames = isMainSpeaker ? this.loudFrames + 1 : 0;
    if (this.loudFrames < this.openFrames) return [];

    this.open = true;
    this.hangover = this.hangoverFrames;
    this.loudFrames = 0;
    const frames = this.preRoll;
    this.preRoll = [];
    frames.forEach((buffered) => {
      const level = rmsOf(buffered);
      if (level > threshold) this.learnSpeakerLevel(level);
    });
    return frames;
  }

  /** The user talked over the AI (barge-in): pass what follows as their speech. */
  forceOpen(): void {
    this.open = true;
    this.hangover = this.hangoverFrames;
    this.loudFrames = 0;
    this.preRoll = [];
  }

  private noiseThreshold(): number {
    return Math.max(this.minSpeechRms, this.noiseFloor * this.noiseFactor);
  }

  /** Steady background (fan, hum, traffic) is the quietest level of the last ~2s; speech always has gaps. */
  private trackNoiseFloor(rms: number): void {
    this.recentLevels.push(rms);
    if (this.recentLevels.length > this.noiseWindowFrames) this.recentLevels.shift();
    // For the first ~0.5s assume a quiet room, so the gate opens at once if the user talks before
    // any pause, while a fan that is already running is still learned quickly
    const minimum = Math.min(...this.recentLevels, ...(this.recentLevels.length < 8 ? [QUIET_ROOM_RMS] : []));
    // Drop at once when it gets quieter; rise gradually
    this.noiseFloor = minimum < this.noiseFloor ? minimum : this.noiseFloor * 0.9 + minimum * 0.1;
  }

  /** Follow the user's level up quickly (they get closer or louder) and down slowly. */
  private learnSpeakerLevel(rms: number): void {
    const weight = rms > this.speakerLevel ? 0.2 : 0.02;
    this.speakerLevel = this.speakerLevel ? this.speakerLevel * (1 - weight) + rms * weight : rms;
  }
}

export function rmsOf(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
