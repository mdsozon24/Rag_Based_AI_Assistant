/**
 * G.711 μ-law codec (ITU-T G.711), used by telephony media streams (8 kHz, 1 byte per sample).
 */

const BIAS = 0x84;
const CLIP = 32635;

const DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  DECODE_TABLE[i] = sign ? -magnitude : magnitude;
}

/** Encode one signed 16-bit sample to a μ-law byte. */
export function encodeMulawSample(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function decodeMulawSample(byte: number): number {
  return DECODE_TABLE[byte & 0xff];
}

export function encodeMulaw(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = encodeMulawSample(samples[i]);
  return out;
}

export function decodeMulaw(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = DECODE_TABLE[bytes[i]];
  return out;
}
