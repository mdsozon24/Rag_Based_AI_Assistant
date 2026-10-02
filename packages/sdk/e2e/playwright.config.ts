/**
 * Browser tests for the widget and SDK against the fake engine (server.ts).
 *   npm run test:e2e
 * Chromium gets a fake microphone that plays e2e/.tmp/caller.wav in a loop: 3 s of quiet (so the
 * greeting is heard in full), then 1 s of speech-like sound (harmonics with a syllable rhythm).
 */
import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wav = path.join(here, '.tmp', 'caller.wav');

function writeCallerWav(file: string): void {
  const rate = 48000;
  const samples = new Int16Array(rate * 4);
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    let v = (Math.random() - 0.5) * 60; // faint room noise
    if (t >= 3) {
      const syllables = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
      const voice = [140, 280, 420, 700, 1100].reduce((sum, f, k) => sum + Math.sin(2 * Math.PI * f * t) / (k + 1), 0);
      v += 7000 * syllables * voice;
    }
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.byteLength, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from(samples.buffer)]));
}
writeCallerWav(wav);

export default defineConfig({
  testDir: here,
  testMatch: '*.spec.ts',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4310',
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'],
    },
    permissions: ['microphone'],
  },
  webServer: {
    command: 'npx tsx packages/sdk/e2e/server.ts',
    cwd: path.resolve(here, '../../..'),
    url: 'http://127.0.0.1:4310/health',
    timeout: 60_000,
    reuseExistingServer: false,
    stdout: 'pipe',
  },
});
