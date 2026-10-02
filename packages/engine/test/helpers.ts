import { vi } from 'vitest';
import { PCM16_16K, PCM16_24K, type AudioFormat } from '../src/audio/format.ts';
import { CallSession, type SessionMode } from '../src/engine/callSession.ts';
import type { CampaignHooks } from '../src/engine/campaign.ts';
import { parseAssistantConfig, type AssistantConfigInput } from '../src/engine/config.ts';
import { silentLogger } from '../src/logger.ts';
import { FakeLlmProvider, FakeSttProvider, FakeTtsProvider, type FakeLlmScript, type FakeSttOptions, type FakeTtsOptions } from '../src/testing/fakes.ts';
import { SimulatedCaller } from '../src/testing/simulatedCaller.ts';
import { LoopbackTransport } from '../src/transport/loopback.ts';

export interface SetupOptions {
  config?: AssistantConfigInput;
  stt?: FakeSttOptions;
  llm?: FakeLlmScript;
  llmDefaults?: { firstTokenMs?: number; tokenMs?: number };
  tts?: FakeTtsOptions;
  inputFormat?: AudioFormat;
  outputFormat?: AudioFormat;
  playbackLeadMs?: number;
  transferBehaviour?: 'accept' | 'fail';
  mode?: SessionMode;
  campaign?: CampaignHooks;
}

/** Quiet defaults: no idle reminders, no max duration, no fallback prefetch, unless a test asks. */
export function setup(options: SetupOptions = {}) {
  const transport = new LoopbackTransport(
    options.inputFormat ?? PCM16_16K,
    options.outputFormat ?? PCM16_24K,
    options.playbackLeadMs ?? 0,
    Date.now,
    options.transferBehaviour ?? 'accept'
  );
  const stt = new FakeSttProvider(options.stt);
  const llm = new FakeLlmProvider(options.llm ?? [], options.llmDefaults);
  const tts = new FakeTtsProvider(options.tts);
  const input = options.config ?? {};
  const config = parseAssistantConfig({
    ...input,
    idle: { timeoutMs: 0, ...input.idle },
    maxDurationMs: input.maxDurationMs ?? 0,
    fallback: { prefetchAudio: false, ...input.fallback },
    firstMessage: { mode: 'wait-for-user', ...input.firstMessage },
  });
  const session = new CallSession({ config, transport, providers: { transcriber: stt, model: llm, voice: tts }, logger: silentLogger, now: Date.now, callId: 'test-call', mode: options.mode, campaign: options.campaign });
  const caller = new SimulatedCaller(transport, async (ms) => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  const states: string[] = [];
  session.onEvent((e) => {
    if (e.type === 'state') states.push(e.state);
  });
  return { transport, stt, llm, tts, config, session, caller, states };
}

export function useFakeClock(): void {
  vi.useFakeTimers({ now: new Date('2026-10-01T09:00:00Z') });
}
