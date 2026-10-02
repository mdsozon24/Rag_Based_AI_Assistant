import { describe, expect, it } from 'vitest';
import { decodeMulaw, decodeMulawSample, encodeMulaw, encodeMulawSample } from '../src/audio/mulaw.ts';
import { Resampler, resamplePcm16 } from '../src/audio/resample.ts';
import { AudioConverter, bytesToPcm16, durationMs, MULAW_8K, PCM16_16K, PCM16_24K, pcm16ToBytes } from '../src/audio/format.ts';

function sine(rate: number, freq: number, ms: number, amplitude = 10000): Int16Array {
  const out = new Int16Array(Math.round((rate * ms) / 1000));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}

function rms(samples: Int16Array, skip = 0): number {
  let sum = 0;
  for (let i = skip; i < samples.length - skip; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length - 2 * skip));
}

/** Magnitude of one frequency (Goertzel), normalized to amplitude. */
function toneLevel(samples: Int16Array, rate: number, freq: number, skip = 200): number {
  const k = (2 * Math.PI * freq) / rate;
  let s1 = 0;
  let s2 = 0;
  const n = samples.length - 2 * skip;
  for (let i = skip; i < samples.length - skip; i++) {
    const s = samples[i] + 2 * Math.cos(k) * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - 2 * Math.cos(k) * s1 * s2)) / n;
}

describe('mu-law codec', () => {
  it('matches G.711 reference values', () => {
    expect(encodeMulawSample(0)).toBe(0xff);
    expect(encodeMulawSample(32767)).toBe(0x80);
    expect(encodeMulawSample(-32768)).toBe(0x00);
    expect(decodeMulawSample(0xff)).toBe(0);
    expect(decodeMulawSample(0x7f)).toBe(0);
    expect(decodeMulawSample(0x80)).toBe(32124);
    expect(decodeMulawSample(0x00)).toBe(-32124);
  });

  it('round-trips every code word exactly', () => {
    for (let code = 0; code < 256; code++) {
      if (code === 0x7f) continue; // negative zero encodes back as positive zero (0xff)
      expect(encodeMulawSample(decodeMulawSample(code))).toBe(code);
    }
  });

  it('keeps quantization error within the segment step (≈ 3% relative)', () => {
    for (let s = -32000; s <= 32000; s += 97) {
      const decoded = decodeMulawSample(encodeMulawSample(s));
      expect(Math.abs(decoded - s)).toBeLessThanOrEqual(Math.max(16, Math.abs(s) * 0.035));
    }
  });

  it('encodes and decodes buffers', () => {
    const pcm = sine(8000, 440, 50);
    const back = decodeMulaw(encodeMulaw(pcm));
    expect(back.length).toBe(pcm.length);
    expect(Math.abs(rms(back) - rms(pcm)) / rms(pcm)).toBeLessThan(0.02);
  });
});

describe('resampler', () => {
  const cases: [number, number][] = [
    [8000, 16000],
    [16000, 8000],
    [16000, 24000],
    [24000, 16000],
    [24000, 8000],
    [8000, 24000],
    [44100, 16000],
  ];

  it.each(cases)('%i -> %i keeps duration, frequency and level of a 1 kHz tone', (from, to) => {
    const input = sine(from, 1000, 500);
    const output = resamplePcm16(input, from, to);
    expect(Math.abs(output.length - (input.length * to) / from)).toBeLessThanOrEqual(1);
    expect(toneLevel(output, to, 1000)).toBeGreaterThan(9000);
    expect(toneLevel(output, to, 1000)).toBeLessThan(10500);
    // Energy at an unrelated frequency stays small
    expect(toneLevel(output, to, 2500)).toBeLessThan(200);
  });

  it('removes content above the new Nyquist frequency when downsampling (anti-aliasing)', () => {
    // 7 kHz at 16 kHz would alias to 1 kHz at 8 kHz without filtering
    const output = resamplePcm16(sine(16000, 7000, 500), 16000, 8000);
    expect(toneLevel(output, 8000, 1000)).toBeLessThan(100); // < -40 dB
    // 24 kHz -> 8 kHz: 5 kHz would alias to 3 kHz
    const output2 = resamplePcm16(sine(24000, 5000, 500), 24000, 8000);
    expect(toneLevel(output2, 8000, 3000)).toBeLessThan(100);
  });

  it('gives the same output when fed in random-sized chunks', () => {
    const input = sine(24000, 700, 300);
    const whole = resamplePcm16(input, 24000, 16000);
    const resampler = new Resampler(24000, 16000);
    const parts: Int16Array[] = [];
    let offset = 0;
    let size = 1;
    while (offset < input.length) {
      parts.push(resampler.process(input.subarray(offset, offset + size)));
      offset += size;
      size = (size * 7 + 3) % 517 || 1;
    }
    const joined = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      joined.set(p, at);
      at += p.length;
    }
    expect(Array.from(joined)).toEqual(Array.from(whole));
  });

  it('keeps silence silent and passes the same rate through unchanged', () => {
    expect(Array.from(resamplePcm16(new Int16Array(800), 8000, 16000)).every((v) => v === 0)).toBe(true);
    const input = sine(16000, 300, 20);
    expect(Array.from(resamplePcm16(input, 16000, 16000))).toEqual(Array.from(input));
  });

  it('rejects invalid rates', () => {
    expect(() => new Resampler(0, 16000)).toThrow();
    expect(() => new Resampler(16000.5, 8000)).toThrow();
  });
});

describe('format conversion', () => {
  it('converts PCM16 bytes little-endian both ways', () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    const bytes = pcm16ToBytes(samples);
    expect(Array.from(bytes.subarray(0, 6))).toEqual([0, 0, 1, 0, 0xff, 0xff]);
    expect(Array.from(bytesToPcm16(bytes))).toEqual(Array.from(samples));
  });

  it('computes durations', () => {
    expect(durationMs(PCM16_16K, 32000)).toBe(1000);
    expect(durationMs(PCM16_24K, 4800)).toBe(100);
    expect(durationMs(MULAW_8K, 160)).toBe(20);
  });

  it('handles odd-length PCM16 chunks by carrying the half sample', () => {
    const samples = sine(16000, 500, 40);
    const bytes = pcm16ToBytes(samples);
    const converter = new AudioConverter(PCM16_16K, PCM16_16K);
    const a = converter.toPcm16(bytes.subarray(0, 101));
    const b = converter.toPcm16(bytes.subarray(101));
    expect([...a, ...b]).toEqual(Array.from(samples));
  });

  it('telephony round trip: PCM16 24 kHz -> mu-law 8 kHz -> PCM16 16 kHz keeps a speech-band tone', () => {
    const toPhone = new AudioConverter(PCM16_24K, MULAW_8K);
    const fromPhone = new AudioConverter(MULAW_8K, PCM16_16K);
    const source = pcm16ToBytes(sine(24000, 800, 500, 8000));
    const mulaw = toPhone.convert(source);
    expect(mulaw.length).toBe(4000); // 500 ms at 8 kHz, 1 byte per sample
    const pcm16k = fromPhone.toPcm16(mulaw);
    expect(pcm16k.length).toBe(8000);
    expect(toneLevel(pcm16k, 16000, 800)).toBeGreaterThan(7400);
  });
});
