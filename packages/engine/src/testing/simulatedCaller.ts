/**
 * Drives a transport like a real caller: streams 20 ms frames of "speech" (a voiced tone) or
 * room noise in real time. `advance` moves time forward: vi.advanceTimersByTimeAsync in tests,
 * a real sleep in simulations.
 */
import { encodeFromPcm16, type AudioFormat } from '../audio/format.ts';
import type { LoopbackTransport } from '../transport/loopback.ts';

export const FRAME_MS = 20;

export function tone(sampleRate: number, ms: number, amplitude: number, frequency = 180, startPhase = 0): Int16Array {
  const samples = new Int16Array(Math.round((sampleRate * ms) / 1000));
  for (let i = 0; i < samples.length; i++) {
    // Fundamental plus a harmonic: closer to voiced speech than a pure sine
    const t = (startPhase + i) / sampleRate;
    samples[i] = Math.round(amplitude * (0.7 * Math.sin(2 * Math.PI * frequency * t) + 0.3 * Math.sin(2 * Math.PI * 3 * frequency * t)));
  }
  return samples;
}

export function noise(sampleRate: number, ms: number, amplitude: number, seed = 1): Int16Array {
  const samples = new Int16Array(Math.round((sampleRate * ms) / 1000));
  let state = seed;
  for (let i = 0; i < samples.length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    samples[i] = Math.round(((state / 0x7fffffff) * 2 - 1) * amplitude);
  }
  return samples;
}

export class SimulatedCaller {
  private phase = 0;
  private seed = 1;

  constructor(
    private readonly transport: LoopbackTransport,
    private readonly advance: (ms: number) => Promise<void>,
    private readonly options: { speechAmplitude?: number; noiseAmplitude?: number } = {}
  ) {}

  private get format(): AudioFormat {
    return this.transport.inputFormat;
  }

  /** Talk for `ms` milliseconds. */
  async speak(ms: number): Promise<void> {
    const rate = this.format.sampleRate;
    for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) {
      const frame = tone(rate, FRAME_MS, this.options.speechAmplitude ?? 8000, 180, this.phase);
      this.phase += frame.length;
      this.transport.pushAudio(encodeFromPcm16(this.format, frame));
      await this.advance(FRAME_MS);
    }
  }

  /** Stay quiet (low room noise) for `ms` milliseconds. */
  async silence(ms: number): Promise<void> {
    const rate = this.format.sampleRate;
    for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) {
      const frame = noise(rate, FRAME_MS, this.options.noiseAmplitude ?? 30, this.seed++);
      this.transport.pushAudio(encodeFromPcm16(this.format, frame));
      await this.advance(FRAME_MS);
    }
  }

  /** Stay quiet until `predicate` holds (checked every frame) or `maxMs` passes. Returns elapsed ms. */
  async silenceUntil(predicate: () => boolean, maxMs = 30000): Promise<number> {
    let elapsed = 0;
    while (!predicate() && elapsed < maxMs) {
      await this.silence(FRAME_MS);
      elapsed += FRAME_MS;
    }
    if (!predicate()) throw new Error(`silenceUntil: condition not met within ${maxMs} ms`);
    return elapsed;
  }
}
