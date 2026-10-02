/**
 * Audio formats used at the engine edges, and the single place where audio is converted between
 * them. Inside a call the engine works on PCM16 mono at ENGINE_SAMPLE_RATE.
 */
import { decodeMulaw, encodeMulaw } from './mulaw.ts';
import { Resampler } from './resample.ts';

export type AudioEncoding = 'pcm16' | 'mulaw';

export interface AudioFormat {
  encoding: AudioEncoding;
  sampleRate: number;
}

/** Internal format: VAD and STT run on 16 kHz PCM16 mono. */
export const ENGINE_SAMPLE_RATE = 16000;

export const PCM16_16K: AudioFormat = { encoding: 'pcm16', sampleRate: 16000 };
export const PCM16_24K: AudioFormat = { encoding: 'pcm16', sampleRate: 24000 };
/** Telephony (Twilio Media Streams, Telnyx PCMU). */
export const MULAW_8K: AudioFormat = { encoding: 'mulaw', sampleRate: 8000 };

export function bytesPerSample(format: AudioFormat): number {
  return format.encoding === 'pcm16' ? 2 : 1;
}

export function durationMs(format: AudioFormat, byteLength: number): number {
  return (byteLength / bytesPerSample(format) / format.sampleRate) * 1000;
}

export function formatsEqual(a: AudioFormat, b: AudioFormat): boolean {
  return a.encoding === b.encoding && a.sampleRate === b.sampleRate;
}

export function describeFormat(format: AudioFormat): string {
  return `${format.encoding}@${format.sampleRate}`;
}

/** Little-endian PCM16 bytes to samples. The byte length must be even. */
export function bytesToPcm16(bytes: Uint8Array): Int16Array {
  const samples = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < samples.length; i++) {
    const value = bytes[2 * i] | (bytes[2 * i + 1] << 8);
    samples[i] = value >= 0x8000 ? value - 0x10000 : value;
  }
  return samples;
}

/** Samples to little-endian PCM16 bytes. */
export function pcm16ToBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] & 0xffff;
    bytes[2 * i] = value & 0xff;
    bytes[2 * i + 1] = value >> 8;
  }
  return bytes;
}

/** Decode any supported format to PCM16 samples at the same rate. */
export function decodeToPcm16(format: AudioFormat, bytes: Uint8Array): Int16Array {
  return format.encoding === 'mulaw' ? decodeMulaw(bytes) : bytesToPcm16(bytes);
}

export function encodeFromPcm16(format: AudioFormat, samples: Int16Array): Uint8Array {
  return format.encoding === 'mulaw' ? encodeMulaw(samples) : pcm16ToBytes(samples);
}

/**
 * Streaming converter from one format to another (decode, resample, encode). Keeps resampler
 * state and any half PCM16 sample between chunks, so use one instance per continuous stream and
 * call reset() when the stream restarts (for example after an interruption).
 */
export class AudioConverter {
  private readonly resampler: Resampler;
  private carry: number | null = null;

  constructor(
    readonly from: AudioFormat,
    readonly to: AudioFormat
  ) {
    this.resampler = new Resampler(from.sampleRate, to.sampleRate);
  }

  get isPassthrough(): boolean {
    return formatsEqual(this.from, this.to);
  }

  /** Convert encoded bytes in `from` to PCM16 samples at the `to` rate. */
  toPcm16(chunk: Uint8Array): Int16Array {
    let bytes = chunk;
    if (this.from.encoding === 'pcm16') {
      if (this.carry !== null) {
        const joined = new Uint8Array(chunk.length + 1);
        joined[0] = this.carry;
        joined.set(chunk, 1);
        bytes = joined;
        this.carry = null;
      }
      if (bytes.length % 2 === 1) {
        this.carry = bytes[bytes.length - 1];
        bytes = bytes.subarray(0, bytes.length - 1);
      }
    }
    return this.resampler.process(decodeToPcm16(this.from, bytes));
  }

  /** Convert encoded bytes in `from` to encoded bytes in `to`. */
  convert(chunk: Uint8Array): Uint8Array {
    if (this.isPassthrough && this.from.encoding === 'mulaw') return chunk.slice();
    return encodeFromPcm16(this.to, this.toPcm16(chunk));
  }

  reset(): void {
    this.carry = null;
    this.resampler.reset();
  }
}
