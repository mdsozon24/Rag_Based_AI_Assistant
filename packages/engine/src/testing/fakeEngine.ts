/**
 * Offline provider set for whole-system tests (API integration tests, the SDK's Playwright run):
 * every call gets fresh fake STT, LLM and TTS, so no network or API key is needed.
 *
 * The model answers "You said: <last user message>", or calls endCall when the user says "bye".
 */
import type { AssistantConfig } from '../engine/config.ts';
import type { CallProviders } from '../providers/resolve.ts';
import { toChain, type ProviderChain } from '../providers/chain.ts';
import type { LanguageModel, LlmRequest } from '../providers/types.ts';
import { FakeLlmProvider, FakeSttProvider, FakeTtsProvider, type FakeLlmReply, type FakeSttOptions, type FakeTtsOptions } from './fakes.ts';

export interface FakeEngineOptions {
  stt?: FakeSttOptions;
  tts?: FakeTtsOptions;
  reply?: (lastUserText: string, request: LlmRequest) => string | FakeLlmReply;
}

export interface FakeCall {
  stt: FakeSttProvider;
  llm: FakeLlmProvider;
  tts: FakeTtsProvider;
}

function lastUserText(request: LlmRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (message.role === 'user') return typeof message.content === 'string' ? message.content : '';
  }
  return '';
}

export function defaultFakeReply(text: string): string | FakeLlmReply {
  if (/\bbye\b/i.test(text)) return { text: 'Goodbye!', toolCall: { name: 'endCall' } };
  return `You said: ${text.split('\n').at(-1)}`;
}

/** A providersForCall implementation backed by fakes; `calls` records each call's fakes. */
export function fakeEngine(options: FakeEngineOptions = {}) {
  const calls: FakeCall[] = [];
  const providersForCall = async (_config: AssistantConfig): Promise<CallProviders> => {
    const stt = new FakeSttProvider({ utterances: Array.from({ length: 50 }, () => 'Hello from the microphone'), finalLatencyMs: 50, ...options.stt });
    const reply = options.reply ?? defaultFakeReply;
    const llm = new FakeLlmProvider((request) => reply(lastUserText(request), request), { firstTokenMs: 30, tokenMs: 5 });
    const tts = new FakeTtsProvider({ firstByteMs: 20, msPerChar: 20, speed: 8, ...options.tts });
    calls.push({ stt, llm, tts });
    return { transcriber: toChain(stt), model: toChain(llm), voice: toChain(tts) };
  };
  /** Text conversations: a fresh fake model per turn (`llms` records them). */
  const llms: FakeLlmProvider[] = [];
  const modelForCall = async (_config: AssistantConfig): Promise<ProviderChain<LanguageModel>> => {
    const reply = options.reply ?? defaultFakeReply;
    const llm = new FakeLlmProvider((request) => reply(lastUserText(request), request), { firstTokenMs: 5, tokenMs: 2 });
    llms.push(llm);
    return toChain(llm);
  };
  return { providersForCall, modelForCall, calls, llms };
}
