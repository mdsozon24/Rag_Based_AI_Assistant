/**
 * Streaming rational resampler for mono PCM16 (polyphase windowed-sinc FIR).
 *
 * Converts between any two integer sample rates (8, 16, 22.05, 24, 48 kHz...). The anti-alias
 * low-pass sits at 90% of the lower Nyquist frequency, so downsampling does not fold high
 * frequencies back into the speech band. Filter state carries across calls, so feeding audio in
 * chunks gives the same output as feeding it in one piece.
 */

const ROLLOFF = 0.9;
const BASE_TAPS_PER_PHASE = 32;

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function designPolyphase(up: number, down: number, fromRate: number, toRate: number): { phases: Float64Array[]; tapsPerPhase: number } {
  const tapsPerPhase = Math.ceil((BASE_TAPS_PER_PHASE * Math.max(up, down)) / up);
  const length = up * tapsPerPhase;
  const upsampledRate = fromRate * up;
  const cutoff = (0.5 * Math.min(fromRate, toRate) * ROLLOFF) / upsampledRate; // cycles per upsampled sample
  const center = (length - 1) / 2;
  const prototype = new Float64Array(length);
  for (let n = 0; n < length; n++) {
    const blackman = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (length - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (length - 1));
    prototype[n] = 2 * cutoff * sinc(2 * cutoff * (n - center)) * blackman;
  }
  const phases: Float64Array[] = [];
  for (let p = 0; p < up; p++) {
    const phase = new Float64Array(tapsPerPhase);
    let sum = 0;
    for (let j = 0; j < tapsPerPhase; j++) {
      phase[j] = prototype[p + j * up];
      sum += phase[j];
    }
    // Unity DC gain per phase, so silence stays silent and levels are preserved exactly
    for (let j = 0; j < tapsPerPhase; j++) phase[j] /= sum;
    phases.push(phase);
  }
  return { phases, tapsPerPhase };
}

export class Resampler {
  readonly fromRate: number;
  readonly toRate: number;
  private readonly up: number;
  private readonly down: number;
  private readonly phases: Float64Array[];
  private readonly tapsPerPhase: number;
  /** The last (tapsPerPhase - 1) input samples, oldest first. */
  private history: Float64Array;
  /** Input samples consumed so far. */
  private inputCount = 0;
  /** Index of the next output sample. */
  private outputIndex = 0;

  constructor(fromRate: number, toRate: number) {
    if (!Number.isInteger(fromRate) || !Number.isInteger(toRate) || fromRate <= 0 || toRate <= 0) {
      throw new Error(`Invalid sample rates ${fromRate} -> ${toRate}`);
    }
    this.fromRate = fromRate;
    this.toRate = toRate;
    const divisor = gcd(fromRate, toRate);
    this.up = toRate / divisor;
    this.down = fromRate / divisor;
    if (this.up === 1 && this.down === 1) {
      this.phases = [];
      this.tapsPerPhase = 0;
      this.history = new Float64Array(0);
      return;
    }
    if (this.up > 1000 || this.down > 1000) throw new Error(`Unsupported resampling ratio ${fromRate} -> ${toRate}`);
    const design = designPolyphase(this.up, this.down, fromRate, toRate);
    this.phases = design.phases;
    this.tapsPerPhase = design.tapsPerPhase;
    this.history = new Float64Array(this.tapsPerPhase - 1);
  }

  get isPassthrough(): boolean {
    return this.up === 1 && this.down === 1;
  }

  process(input: Int16Array): Int16Array {
    if (this.isPassthrough) return input.slice();
    const historyLength = this.history.length;
    const buffer = new Float64Array(historyLength + input.length);
    buffer.set(this.history, 0);
    for (let i = 0; i < input.length; i++) buffer[historyLength + i] = input[i];

    const total = this.inputCount + input.length;
    // Global input index of buffer[0]
    const bufferStart = this.inputCount - historyLength;
    const estimated = Math.ceil((input.length * this.up) / this.down) + 1;
    const out = new Int16Array(estimated);
    let produced = 0;
    for (;;) {
      const t = this.outputIndex * this.down;
      const newest = Math.floor(t / this.up);
      if (newest >= total) break;
      const coefficients = this.phases[t - newest * this.up];
      let acc = 0;
      let bi = newest - bufferStart;
      for (let j = 0; j < this.tapsPerPhase; j++, bi--) acc += coefficients[j] * buffer[bi];
      const sample = Math.round(acc);
      out[produced++] = sample > 32767 ? 32767 : sample < -32768 ? -32768 : sample;
      this.outputIndex++;
    }

    this.history = buffer.slice(buffer.length - historyLength);
    this.inputCount = total;
    // Keep the counters small on long calls without changing their relationship
    const period = this.up * this.down;
    if (this.inputCount > period * 1_000_000) {
      const shiftOut = Math.floor(this.outputIndex / this.up) * this.up;
      this.outputIndex -= shiftOut;
      this.inputCount -= (shiftOut * this.down) / this.up;
    }
    return produced === out.length ? out : out.slice(0, produced);
  }

  reset(): void {
    this.history.fill(0);
    this.inputCount = 0;
    this.outputIndex = 0;
  }
}

/** One-shot resample of a whole buffer. */
export function resamplePcm16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  return new Resampler(fromRate, toRate).process(input);
}
