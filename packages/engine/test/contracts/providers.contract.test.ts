/**
 * Provider contract tests: every Transcriber, LanguageModel and VoiceSynthesizer implementation
 * runs the same suite. A new provider adds one harness entry below and must pass all of it.
 */
import { describe, expect, it } from 'vitest';
import { CustomTranscriber } from '../../src/providers/adapters/customTranscriber.ts';
import { DeepgramTranscriber } from '../../src/providers/adapters/deepgramTranscriber.ts';
import { ElevenLabsTranscriber } from '../../src/providers/adapters/elevenlabsTranscriber.ts';
import { GoogleModel, type GeminiClientLike } from '../../src/providers/adapters/googleModel.ts';
import { OpenAiModel } from '../../src/providers/adapters/openaiModel.ts';
import { CartesiaVoice, CustomVoice, ElevenLabsVoice } from '../../src/providers/adapters/voices.ts';
import { ProviderError, type LanguageModel, type LlmEvent, type LlmRequest, type Transcriber, type TranscriberHandlers, type VoiceSynthesizer } from '../../src/providers/types.ts';
import { silentLogger } from '../../src/logger.ts';
import { FakeLlmProvider, FakeSttProvider, FakeTtsProvider } from '../../src/testing/fakes.ts';
import { tone } from '../../src/testing/simulatedCaller.ts';
import { DEEPGRAM, GEMINI_TEXT_STREAM, GEMINI_TOOL_STREAM, MODEL_TEXT, OPENAI_TEXT_STREAM, OPENAI_TOOL_STREAM, pcmFixture, SCRIBE, UTTERANCE } from './fixtures.ts';
import { fakeHttp, localWsServer, until, type FakeHttpReply } from './harness.ts';

const ctx = (signal = new AbortController().signal) => ({ callId: 'contract', logger: silentLogger, signal });
const ALLOW_LOCAL = { allowPrivateNetwork: true };

// ====================================================================== transcribers

type SttMode = 'ok' | 'auth' | 'drop';
interface TranscriberCase {
  name: string;
  modes: SttMode[];
  setup(mode: SttMode): Promise<Transcriber>;
}

const transcriberCases: TranscriberCase[] = [
  {
    name: 'elevenlabs (Scribe v2 Realtime)',
    modes: ['ok', 'auth', 'drop'],
    async setup(mode) {
      const server = await localWsServer((socket) => {
        if (mode === 'auth') {
          socket.send(JSON.stringify(SCRIBE.authError));
          socket.close(1008);
          return;
        }
        socket.send(JSON.stringify(SCRIBE.sessionStarted));
        socket.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (mode === 'drop') return socket.terminate();
          socket.send(JSON.stringify(msg.commit ? SCRIBE.committed : SCRIBE.partial));
        });
      });
      return new ElevenLabsTranscriber({ apiKey: 'test-key', baseUrl: server.url });
    },
  },
  {
    name: 'deepgram (Nova-3)',
    modes: ['ok', 'auth', 'drop'],
    async setup(mode) {
      const server = await localWsServer(
        (socket) => {
          socket.on('message', (data, binary) => {
            if (mode === 'drop') return socket.terminate();
            if (binary) return socket.send(JSON.stringify(DEEPGRAM.interim));
            if (JSON.parse(data.toString()).type === 'Finalize') {
              socket.send(JSON.stringify(DEEPGRAM.finalPart));
              socket.send(JSON.stringify(DEEPGRAM.finalizeResult));
            }
          });
        },
        mode === 'auth' ? { verifyStatus: 401 } : {}
      );
      return new DeepgramTranscriber({ apiKey: 'test-key', baseUrl: server.url });
    },
  },
  {
    name: 'custom (WebSocket endpoint)',
    modes: ['ok', 'auth', 'drop'],
    async setup(mode) {
      const server = await localWsServer(
        (socket) => {
          socket.on('message', (data, binary) => {
            if (mode === 'drop') return socket.terminate();
            if (binary) return socket.send(JSON.stringify({ type: 'partial', text: UTTERANCE.partial }));
            if (JSON.parse(data.toString()).type === 'commit') socket.send(JSON.stringify({ type: 'final', text: UTTERANCE.final }));
          });
        },
        mode === 'auth' ? { verifyStatus: 401 } : {}
      );
      return new CustomTranscriber({ url: server.url, secret: 'endpoint-secret', policy: ALLOW_LOCAL });
    },
  },
  {
    name: 'fake (test double)',
    modes: ['ok'],
    async setup() {
      return new FakeSttProvider({ utterances: [UTTERANCE.final], finalLatencyMs: 10 });
    },
  },
];

function recorder() {
  const partials: string[] = [];
  const finals: string[] = [];
  const errors: ProviderError[] = [];
  const handlers: TranscriberHandlers = { onPartial: (t) => partials.push(t), onFinal: (t) => finals.push(t), onError: (e) => errors.push(e) };
  return { partials, finals, errors, handlers };
}

function speech(ms: number): Int16Array[] {
  return Array.from({ length: ms / 20 }, () => tone(16000, 20, 5000));
}

describe.each(transcriberCases)('Transcriber contract: $name', (c) => {
  it('identifies itself', async () => {
    const t = await c.setup('ok');
    expect(t.provider).toMatch(/^[a-z0-9-]+$/);
    expect(t.model.length).toBeGreaterThan(0);
  });

  it('streams partials, then the final transcript after commit, and closes quietly', async () => {
    const r = recorder();
    const stream = await (await c.setup('ok')).connect({ sampleRate: 16000, language: 'bn' }, r.handlers, ctx());
    for (const frame of speech(300)) stream.sendAudio(frame);
    await until(() => r.partials.length > 0);
    stream.commit();
    await until(() => r.finals.length > 0);
    expect(r.finals).toEqual([UTTERANCE.final]);
    await stream.close();
    await new Promise((res) => setTimeout(res, 30));
    expect(r.errors).toEqual([]);
  });

  it.runIf(c.modes.includes('auth'))('rejects bad credentials with a non-retryable ProviderError', async () => {
    const transcriber = await c.setup('auth');
    const error = await transcriber.connect({ sampleRate: 16000, language: 'bn' }, recorder().handlers, ctx()).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ stage: 'stt', retryable: false });
  });

  it.runIf(c.modes.includes('drop'))('reports a dropped connection exactly once, as retryable', async () => {
    const r = recorder();
    const stream = await (await c.setup('drop')).connect({ sampleRate: 16000, language: 'bn' }, r.handlers, ctx());
    for (const frame of speech(200)) stream.sendAudio(frame);
    await until(() => r.errors.length > 0);
    await new Promise((res) => setTimeout(res, 50));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ stage: 'stt', retryable: true });
  });

  it('is cancellable: an aborted signal rejects connect', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await (await c.setup('ok')).connect({ sampleRate: 16000, language: 'bn' }, recorder().handlers, ctx(controller.signal)).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
  });
});

// ====================================================================== language models

type LlmMode = 'text' | 'tool' | 'auth' | 'unavailable' | 'slow';
interface NormalizedRequest {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  toolNames: string[];
  roles: string[];
  allText: string;
}
interface ModelCase {
  name: string;
  modes: LlmMode[];
  setup(mode: LlmMode): { model: LanguageModel; lastRequest(): NormalizedRequest };
}

function openAiReply(mode: LlmMode): FakeHttpReply {
  if (mode === 'auth') return { status: 401, chunks: ['{"error":{"message":"Incorrect API key provided"}}'] };
  if (mode === 'unavailable') return { status: 503, chunks: ['{"error":{"message":"overloaded"}}'] };
  return { status: 200, chunks: mode === 'tool' ? OPENAI_TOOL_STREAM : OPENAI_TEXT_STREAM, chunkDelayMs: mode === 'slow' ? 40 : 0 };
}

function normalizeOpenAi(json: Record<string, unknown>, maxField: string): NormalizedRequest {
  const messages = json.messages as { role: string; content: string | null }[];
  return {
    system: messages[0]?.role === 'system' ? (messages[0].content ?? undefined) : undefined,
    temperature: json.temperature as number | undefined,
    maxTokens: json[maxField] as number | undefined,
    toolNames: ((json.tools as { function: { name: string } }[] | undefined) ?? []).map((t) => t.function.name),
    roles: messages.filter((m) => m.role !== 'system').map((m) => m.role),
    allText: JSON.stringify(messages),
  };
}

const modelCases: ModelCase[] = [
  {
    name: 'openai (Chat Completions)',
    modes: ['text', 'tool', 'auth', 'unavailable', 'slow'],
    setup(mode) {
      const fake = fakeHttp(() => openAiReply(mode));
      const model = new OpenAiModel({ apiKey: 'sk-test', model: 'gpt-4.1-mini', http: fake.http });
      return { model, lastRequest: () => normalizeOpenAi(fake.requests.at(-1)!.json, 'max_completion_tokens') };
    },
  },
  {
    name: 'custom (OpenAI-compatible endpoint)',
    modes: ['text', 'tool', 'auth', 'unavailable', 'slow'],
    setup(mode) {
      const fake = fakeHttp((req) => {
        expect(req.url).toBe('https://llm.example.com/v1/chat/completions');
        expect(req.init.headers.Authorization).toBe('Bearer endpoint-secret');
        return openAiReply(mode);
      });
      const model = new OpenAiModel({ provider: 'custom', model: 'my-model', baseUrl: 'https://llm.example.com/v1', apiKey: 'endpoint-secret', maxTokensField: 'max_tokens', http: fake.http });
      return { model, lastRequest: () => normalizeOpenAi(fake.requests.at(-1)!.json, 'max_tokens') };
    },
  },
  {
    name: 'google (Gemini)',
    modes: ['text', 'tool', 'auth', 'unavailable', 'slow'],
    setup(mode) {
      let last: Parameters<GeminiClientLike['models']['generateContentStream']>[0] | undefined;
      const client: GeminiClientLike = {
        models: {
          async generateContentStream(params) {
            last = params;
            if (mode === 'auth') throw Object.assign(new Error('API key not valid'), { status: 403 });
            if (mode === 'unavailable') throw Object.assign(new Error('The model is overloaded'), { status: 503 });
            const chunks = mode === 'tool' ? GEMINI_TOOL_STREAM : GEMINI_TEXT_STREAM;
            const signal = params.config?.abortSignal;
            return (async function* () {
              for (const chunk of chunks) {
                if (mode === 'slow') await new Promise((r) => setTimeout(r, 40));
                if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
                yield chunk as never;
              }
            })();
          },
        },
      };
      const model = new GoogleModel({ model: 'gemini-test', client });
      return {
        model,
        lastRequest: () => ({
          system: last!.config!.systemInstruction as string,
          temperature: last!.config!.temperature,
          maxTokens: last!.config!.maxOutputTokens,
          toolNames: ((last!.config!.tools as { functionDeclarations: { name: string }[] }[] | undefined)?.[0]?.functionDeclarations ?? []).map((f) => f.name),
          roles: last!.contents.map((c) => (c.role === 'model' ? 'assistant' : 'user')),
          allText: JSON.stringify(last!.contents),
        }),
      };
    },
  },
  {
    name: 'fake (test double)',
    modes: ['text', 'tool', 'slow'],
    setup(mode) {
      const llm = new FakeLlmProvider([mode === 'tool' ? { toolCall: { name: 'endCall', args: { reason: 'done' } } } : { text: MODEL_TEXT, tokenMs: mode === 'slow' ? 40 : 1 }], { firstTokenMs: 5 });
      return {
        model: llm,
        lastRequest: () => {
          const r = llm.requests.at(-1)!;
          return { system: r.systemPrompt, temperature: r.temperature, maxTokens: r.maxTokens, toolNames: r.tools.map((t) => t.name), roles: r.messages.map((m) => m.role), allText: JSON.stringify(r.messages) };
        },
      };
    },
  },
];

const baseRequest: LlmRequest = {
  systemPrompt: 'Be brief.',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [{ name: 'endCall', description: 'End the call', parameters: { type: 'object', properties: { reason: { type: 'string' } } } }],
  temperature: 0.3,
  maxTokens: 100,
};

async function collect(model: LanguageModel, request: LlmRequest, signal = new AbortController().signal): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const e of model.stream(request, ctx(signal))) events.push(e);
  return events;
}

describe.each(modelCases)('LanguageModel contract: $name', (c) => {
  it('identifies itself', () => {
    const { model } = c.setup('text');
    expect(model.provider).toMatch(/^[a-z0-9-]+$/);
    expect(model.model.length).toBeGreaterThan(0);
  });

  it('streams text deltas and reports token usage', async () => {
    const events = await collect(c.setup('text').model, baseRequest);
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe(MODEL_TEXT);
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(1);
    const usage = events.find((e) => e.type === 'usage') as { inputTokens: number; outputTokens: number } | undefined;
    expect(usage?.inputTokens).toBeGreaterThan(0);
    expect(usage?.outputTokens).toBeGreaterThan(0);
  });

  it('passes system prompt, temperature, max tokens and tools to the provider', async () => {
    const h = c.setup('text');
    await collect(h.model, baseRequest);
    const r = h.lastRequest();
    expect(r.system).toBe('Be brief.');
    expect(r.temperature).toBe(0.3);
    expect(r.maxTokens).toBe(100);
    expect(r.toolNames).toEqual(['endCall']);
    expect(r.allText).toContain('hello');
  });

  it('emits tool calls with parsed arguments and an id', async () => {
    const events = await collect(c.setup('tool').model, baseRequest);
    const call = events.find((e) => e.type === 'tool-call');
    expect(call).toMatchObject({ type: 'tool-call', name: 'endCall', args: { reason: 'done' } });
    expect((call as { id: string }).id.length).toBeGreaterThan(0);
  });

  it('accepts assistant tool calls and tool results in history (ready for the tool runtime)', async () => {
    const h = c.setup('text');
    await collect(h.model, {
      ...baseRequest,
      messages: [
        { role: 'user', content: 'what is the weather?' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'getWeather', args: { city: 'Dhaka' } }] },
        { role: 'tool', toolCallId: 'call_1', name: 'getWeather', content: '31°C and humid' },
      ],
    });
    expect(h.lastRequest().allText).toContain('31°C and humid');
    expect(h.lastRequest().allText).toContain('getWeather');
  });

  it.runIf(c.modes.includes('auth'))('fails bad credentials with a non-retryable ProviderError', async () => {
    const error = await collect(c.setup('auth').model, baseRequest).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ stage: 'llm', retryable: false });
  });

  it.runIf(c.modes.includes('unavailable'))('fails an overloaded provider with a retryable ProviderError', async () => {
    const error = await collect(c.setup('unavailable').model, baseRequest).catch((e) => e);
    expect(error).toMatchObject({ stage: 'llm', retryable: true });
  });

  it('is cancellable mid-stream', async () => {
    const controller = new AbortController();
    const events: LlmEvent[] = [];
    const startedAt = Date.now();
    await (async () => {
      for await (const e of c.setup('slow').model.stream(baseRequest, ctx(controller.signal))) {
        events.push(e);
        if (e.type === 'text') controller.abort();
      }
    })().catch((e) => expect((e as Error).name).toMatch(/Abort/));
    expect(events.filter((e) => e.type === 'text')).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});

// ====================================================================== voices

type TtsMode = 'ok' | 'auth' | 'unavailable' | 'slow';
interface VoiceCase {
  name: string;
  modes: TtsMode[];
  /** Exact bytes expected for the fixture (undefined: any non-empty amount). */
  expectedBytes?: number;
  setup(mode: TtsMode): { voice: VoiceSynthesizer; lastRequest(): { text: string; language: string; voice?: string } };
}

function audioReply(mode: TtsMode): FakeHttpReply {
  if (mode === 'auth') return { status: 401, chunks: ['{"detail":"invalid api key"}'] };
  if (mode === 'unavailable') return { status: 503, chunks: ['busy'] };
  return { status: 200, chunks: pcmFixture().chunks, chunkDelayMs: mode === 'slow' ? 40 : 0 };
}

const voiceCases: VoiceCase[] = [
  {
    name: 'elevenlabs',
    modes: ['ok', 'auth', 'unavailable', 'slow'],
    expectedBytes: 4800,
    setup(mode) {
      const fake = fakeHttp((req) => {
        expect(req.init.headers['xi-api-key']).toBe('el-key');
        return audioReply(mode);
      });
      const voice = new ElevenLabsVoice({ apiKey: 'el-key', voiceId: 'voice123', http: fake.http });
      return {
        voice,
        lastRequest: () => {
          const r = fake.requests.at(-1)!;
          return { text: r.json.text as string, language: r.json.language_code as string, voice: /text-to-speech\/([^/]+)\/stream/.exec(r.url)?.[1] };
        },
      };
    },
  },
  {
    name: 'cartesia',
    modes: ['ok', 'auth', 'unavailable', 'slow'],
    expectedBytes: 4800,
    setup(mode) {
      const fake = fakeHttp((req) => {
        expect(req.url).toBe('https://api.cartesia.ai/tts/bytes');
        expect(req.init.headers.Authorization).toBe('Bearer ca-key');
        expect(req.init.headers['Cartesia-Version']).toBe('2026-08-14');
        expect(req.json.output_format).toEqual({ container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 });
        return audioReply(mode);
      });
      const voice = new CartesiaVoice({ apiKey: 'ca-key', voiceId: 'voice123', http: fake.http });
      return {
        voice,
        lastRequest: () => {
          const r = fake.requests.at(-1)!;
          return { text: r.json.transcript as string, language: r.json.language as string, voice: (r.json.voice as { id: string }).id };
        },
      };
    },
  },
  {
    name: 'custom (HTTPS endpoint)',
    modes: ['ok', 'auth', 'unavailable', 'slow'],
    expectedBytes: 4800,
    setup(mode) {
      const fake = fakeHttp((req) => {
        expect(req.init.headers.Authorization).toBe('Bearer endpoint-secret');
        return audioReply(mode);
      });
      const voice = new CustomVoice({ url: 'https://tts.example.com/speak', secret: 'endpoint-secret', voiceId: 'voice123', policy: { allowPrivateNetwork: false }, http: fake.http });
      return {
        voice,
        lastRequest: () => {
          const r = fake.requests.at(-1)!;
          return { text: r.json.text as string, language: r.json.language as string, voice: r.json.voiceId as string };
        },
      };
    },
  },
  {
    name: 'fake (test double)',
    modes: ['ok', 'slow'],
    setup(mode) {
      const tts = new FakeTtsProvider({ firstByteMs: 5, speed: mode === 'slow' ? 0.5 : 50 });
      return { voice: tts, lastRequest: () => ({ ...tts.requests.at(-1)!, voice: undefined }) };
    },
  },
];

async function collectAudio(voice: VoiceSynthesizer, signal = new AbortController().signal): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of voice.stream({ text: 'আমি ভালো আছি।', language: 'bn-BD' }, ctx(signal))) chunks.push(chunk);
  return chunks;
}

describe.each(voiceCases)('VoiceSynthesizer contract: $name', (c) => {
  it('identifies itself and declares a PCM16 output format', () => {
    const { voice } = c.setup('ok');
    expect(voice.provider).toMatch(/^[a-z0-9-]+$/);
    expect(voice.model.length).toBeGreaterThan(0);
    expect(voice.outputFormat.encoding).toBe('pcm16');
    expect(voice.outputFormat.sampleRate).toBeGreaterThanOrEqual(8000);
  });

  it('streams audio as whole 16-bit samples', async () => {
    const chunks = await collectAudio(c.setup('ok').voice);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk.length % 2).toBe(0);
    const total = chunks.reduce((n, ch) => n + ch.length, 0);
    if (c.expectedBytes) expect(total).toBe(c.expectedBytes);
    else expect(total).toBeGreaterThan(0);
  });

  it('sends the text, language and voice', async () => {
    const h = c.setup('ok');
    await collectAudio(h.voice);
    const r = h.lastRequest();
    expect(r.text).toBe('আমি ভালো আছি।');
    expect(r.language).toMatch(/^bn/);
    if (r.voice !== undefined) expect(r.voice).toBe('voice123');
  });

  it.runIf(c.modes.includes('auth'))('fails bad credentials with a non-retryable ProviderError', async () => {
    const error = await collectAudio(c.setup('auth').voice).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ stage: 'tts', retryable: false, code: '401' });
  });

  it.runIf(c.modes.includes('unavailable'))('fails an unavailable provider with a retryable ProviderError', async () => {
    const error = await collectAudio(c.setup('unavailable').voice).catch((e) => e);
    expect(error).toMatchObject({ stage: 'tts', retryable: true, code: '503' });
  });

  it('is cancellable mid-stream', async () => {
    const controller = new AbortController();
    const chunks: Uint8Array[] = [];
    await (async () => {
      for await (const chunk of c.setup('slow').voice.stream({ text: 'one two three four five six', language: 'en' }, ctx(controller.signal))) {
        chunks.push(chunk);
        controller.abort();
      }
    })().catch((e) => expect((e as Error).name).toMatch(/Abort/));
    expect(chunks).toHaveLength(1);
  });
});
