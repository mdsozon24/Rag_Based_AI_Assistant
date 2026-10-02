import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { CredentialCipher } from '../src/credentials/cipher.ts';
import { CredentialService, platformKeysFromEnv } from '../src/credentials/service.ts';
import { InMemoryCredentialStore } from '../src/credentials/store.ts';
import { parseAssistantConfig } from '../src/engine/config.ts';
import { createLogger } from '../src/logger.ts';
import { createPlatform } from '../src/platform.ts';
import { CustomTranscriber } from '../src/providers/adapters/customTranscriber.ts';
import { DeepgramTranscriber } from '../src/providers/adapters/deepgramTranscriber.ts';
import { ElevenLabsTranscriber } from '../src/providers/adapters/elevenlabsTranscriber.ts';
import { GoogleModel } from '../src/providers/adapters/googleModel.ts';
import { OpenAiModel } from '../src/providers/adapters/openaiModel.ts';
import { CartesiaVoice, CustomVoice, ElevenLabsVoice } from '../src/providers/adapters/voices.ts';
import { createDefaultRegistry, MissingCredentialError } from '../src/providers/catalog.ts';
import { PRESETS } from '../src/providers/presets.ts';
import { ProviderConfigError, UnknownProviderError, type BuildContext } from '../src/providers/registry.ts';
import { ProviderResolutionError, resolveCallProviders } from '../src/providers/resolve.ts';

const ALL_KEYS = {
  GEMINI_API_KEY: 'platform-gemini-key-0001',
  ELEVENLABS_API_KEY: 'platform-eleven-key-0002',
  DEEPGRAM_API_KEY: 'platform-deepgram-key-0003',
  OPENAI_API_KEY: 'platform-openai-key-0004',
  CARTESIA_API_KEY: 'platform-cartesia-key-0005',
};

function context(env: Record<string, string> = ALL_KEYS, overrides: Partial<BuildContext> = {}): BuildContext {
  const cipher = new CredentialCipher({ id: 'k1', key: randomBytes(32).toString('base64') });
  return {
    orgId: 'org_a',
    language: 'bn',
    credentials: new CredentialService(new InMemoryCredentialStore(), cipher, platformKeysFromEnv(env)),
    endpointPolicy: { allowPrivateNetwork: false },
    defaults: { voiceIds: { elevenlabs: 'el-voice', cartesia: 'ca-voice' } },
    ...overrides,
  };
}

describe('provider registry', () => {
  const registry = createDefaultRegistry();

  it('lists the built-in providers per component', () => {
    expect(registry.ids('transcriber').sort()).toEqual(['custom', 'deepgram', 'elevenlabs']);
    expect(registry.ids('model').sort()).toEqual(['custom', 'google', 'openai']);
    expect(registry.ids('voice').sort()).toEqual(['cartesia', 'custom', 'elevenlabs']);
  });

  it.each([
    ['transcriber', { provider: 'elevenlabs' }, ElevenLabsTranscriber, 'scribe_v2_realtime'],
    ['transcriber', { provider: 'deepgram', model: 'nova-3', language: 'bn' }, DeepgramTranscriber, 'nova-3'],
    ['transcriber', { provider: 'custom', url: 'wss://stt.example.com/ws' }, CustomTranscriber, 'custom'],
    ['model', { provider: 'google' }, GoogleModel, 'gemini-3.1-flash-lite'],
    ['model', { provider: 'openai', model: 'gpt-4.1', temperature: 0.2, maxTokens: 300 }, OpenAiModel, 'gpt-4.1'],
    ['model', { provider: 'custom', url: 'https://llm.example.com/v1/chat/completions', model: 'mine' }, OpenAiModel, 'mine'],
    ['voice', { provider: 'elevenlabs', voiceId: 'v1', stability: 0.4 }, ElevenLabsVoice, 'eleven_v3_conversational'],
    ['voice', { provider: 'cartesia', voiceId: 'v2' }, CartesiaVoice, 'sonic-3.6'],
    ['voice', { provider: 'custom', url: 'https://tts.example.com/speak', sampleRate: 16000 }, CustomVoice, 'custom'],
  ] as const)('resolves %s %j', async (kind, config, type, model) => {
    const validated = registry.validate(kind, config);
    const built = await registry.build(kind, validated, context());
    expect(built.instance).toBeInstanceOf(type);
    expect(built.instance.model).toBe(model);
  });

  it('rejects an unknown provider with a clear message listing the options', () => {
    expect(() => registry.validate('transcriber', { provider: 'whisperx' })).toThrow(UnknownProviderError);
    expect(() => registry.validate('transcriber', { provider: 'whisperx' })).toThrow('Unknown transcriber provider "whisperx". Available transcriber providers: elevenlabs, deepgram, custom');
    expect(() => registry.validate('voice', {})).toThrow(/voice.provider is required/);
  });

  it('rejects typos and invalid values with the field path', () => {
    expect(() => registry.validate('voice', { provider: 'elevenlabs', voiceID: 'x' })).toThrow(/unknown field\(s\) voiceID for provider "elevenlabs"/);
    expect(() => registry.validate('model', { provider: 'openai', temperature: 7 })).toThrow(ProviderConfigError);
    expect(() => registry.validate('transcriber', { provider: 'custom' })).toThrow(/transcriber\.url/);
  });

  it('fails clearly when no key exists for the vendor', async () => {
    const config = registry.validate('voice', { provider: 'cartesia', voiceId: 'v' });
    const error = await registry.build('voice', config, context({})).catch((e) => e);
    expect(error).toBeInstanceOf(MissingCredentialError);
    expect(error.message).toBe('No API key for "cartesia": add an org credential for cartesia or set CARTESIA_API_KEY on the platform');
  });

  it('requires a voice id when there is no platform default', async () => {
    const config = registry.validate('voice', { provider: 'cartesia' });
    await expect(registry.build('voice', config, context(ALL_KEYS, { defaults: { voiceIds: {} } }))).rejects.toThrow(/voiceId is required for "cartesia".*CARTESIA_VOICE_ID/);
  });

  it('refuses custom endpoints on private networks or without TLS', async () => {
    for (const url of ['https://127.0.0.1/v1', 'https://10.1.2.3/v1', 'http://llm.example.com/v1']) {
      const config = registry.validate('model', { provider: 'custom', url });
      await expect(registry.build('model', config, context())).rejects.toThrow(/private|reserved|must use https/);
    }
  });
});

describe('presets and assistant config', () => {
  it('defaults to the balanced preset (the current production stack)', () => {
    const config = parseAssistantConfig({});
    expect(config.preset).toBe('balanced');
    expect(config.transcriber).toMatchObject({ provider: 'elevenlabs', model: 'scribe_v2_realtime', retries: 1, connectTimeoutMs: 5000 });
    expect(config.model).toMatchObject({ provider: 'google', model: 'gemini-3.1-flash-lite' });
    expect(config.voice).toMatchObject({ provider: 'elevenlabs', model: 'eleven_v3_conversational' });
    expect(config.endpointing.silenceMs).toBe(600);
  });

  it.each(['fast', 'balanced', 'quality'] as const)('preset %s is valid and sets components and silence', (preset) => {
    const config = parseAssistantConfig({ preset });
    expect(config.transcriber.provider).toBe(PRESETS[preset].transcriber.provider);
    expect(config.model.provider).toBe(PRESETS[preset].model.provider);
    expect(config.voice.provider).toBe(PRESETS[preset].voice.provider);
    expect(config.voice.fallbacks.length).toBeGreaterThan(0);
    expect(config.endpointing.silenceMs).toBe(PRESETS[preset].silenceMs);
  });

  it('merges same-provider overrides and keeps the preset fallbacks', () => {
    const config = parseAssistantConfig({ preset: 'balanced', voice: { voiceId: 'my-voice', stability: 0.3 }, model: { temperature: 0.2, maxTokens: 150 } });
    expect(config.voice).toMatchObject({ provider: 'elevenlabs', model: 'eleven_v3_conversational', voiceId: 'my-voice', stability: 0.3 });
    expect(config.voice.fallbacks).toEqual([{ provider: 'cartesia', model: 'sonic-3.6' }]);
    expect(config.model).toMatchObject({ provider: 'google', temperature: 0.2, maxTokens: 150 });
  });

  it('replaces the component, including fallbacks, when the provider changes', () => {
    const config = parseAssistantConfig({ preset: 'balanced', transcriber: { provider: 'deepgram', model: 'nova-3' } });
    expect(config.transcriber).toMatchObject({ provider: 'deepgram', model: 'nova-3', fallbacks: [] });
  });

  it('accepts explicit fallbacks and the assistant silence over the preset', () => {
    const config = parseAssistantConfig({
      preset: 'fast',
      endpointing: { silenceMs: 700 },
      voice: { provider: 'elevenlabs', voiceId: 'v', fallbacks: [{ provider: 'cartesia', voiceId: 'c' }, { provider: 'custom', url: 'https://tts.example.com/' }] },
    });
    expect(config.endpointing.silenceMs).toBe(700);
    expect(config.voice.fallbacks.map((f) => f.provider)).toEqual(['cartesia', 'custom']);
  });

  it('reports invalid fallbacks and unknown presets with their path', () => {
    expect(() => parseAssistantConfig({ voice: { fallbacks: [{ provider: 'cartesia', bogus: 1 }] } })).toThrow(/voice\.fallbacks\[0\]: unknown field\(s\) bogus/);
    expect(() => parseAssistantConfig({ model: { provider: 'nope' } })).toThrow(/Unknown model provider "nope"/);
    expect(() => parseAssistantConfig({ preset: 'turbo' as never })).toThrow(/Unknown preset "turbo"/);
  });
});

describe('per-call resolution with credentials', () => {
  const logLines: string[] = [];
  const logger = createLogger({ level: 'warn', sink: (l) => logLines.push(l) });

  it('uses platform keys (platform-billed) when the org has none', async () => {
    const providers = await resolveCallProviders(parseAssistantConfig({}), createDefaultRegistry(), context(), logger);
    expect(providers.transcriber[0]).toMatchObject({ provider: 'elevenlabs', credentialSource: 'platform', billing: 'platform' });
    expect(providers.model.map((e) => e.provider)).toEqual(['google', 'openai']);
    expect(providers.voice.map((e) => e.provider)).toEqual(['elevenlabs', 'cartesia']);
  });

  it("uses the org's own key (customer-billed) when it stored one", async () => {
    const ctx = context();
    const credential = await ctx.credentials.create('org_a', { provider: 'google', secret: 'org-a-gemini-key-123456' });
    const providers = await resolveCallProviders(parseAssistantConfig({}), createDefaultRegistry(), ctx, logger);
    expect(providers.model[0]).toMatchObject({ provider: 'google', credentialSource: 'org', credentialId: credential.id, billing: 'customer' });
    // Other vendors still use platform keys
    expect(providers.transcriber[0].billing).toBe('platform');
  });

  it("never uses another org's key", async () => {
    const ctx = context();
    await ctx.credentials.create('org_b', { provider: 'google', secret: 'org-b-gemini-key-123456' });
    const providers = await resolveCallProviders(parseAssistantConfig({}), createDefaultRegistry(), ctx, logger);
    expect(providers.model[0]).toMatchObject({ credentialSource: 'platform', billing: 'platform' });
  });

  it('fails the call before it starts when the primary provider has no key', async () => {
    const error = await resolveCallProviders(parseAssistantConfig({ preset: 'fast' }), createDefaultRegistry(), context({ ELEVENLABS_API_KEY: 'k'.repeat(20), GEMINI_API_KEY: 'g'.repeat(20) }), logger).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderResolutionError);
    expect(error.message).toMatch(/Cannot start transcriber "deepgram": No API key for "deepgram".*DEEPGRAM_API_KEY/);
    // Every component that cannot start is reported, not just the first
    expect(error.message).toMatch(/Cannot start model "openai".*OPENAI_API_KEY/);
    expect(error.message).toMatch(/Cannot start voice "cartesia"/);
  });

  it('skips fallbacks without keys, with a warning', async () => {
    logLines.length = 0;
    const providers = await resolveCallProviders(parseAssistantConfig({}), createDefaultRegistry(), context({ ELEVENLABS_API_KEY: 'k'.repeat(20), GEMINI_API_KEY: 'g'.repeat(20) }), logger);
    expect(providers.transcriber.map((e) => e.provider)).toEqual(['elevenlabs']);
    expect(providers.model.map((e) => e.provider)).toEqual(['google']);
    expect(providers.voice.map((e) => e.provider)).toEqual(['elevenlabs']);
    expect(logLines.filter((l) => l.includes('fallback provider unavailable, skipped'))).toHaveLength(3);
    expect(logLines.join('\n')).not.toContain('k'.repeat(20));
  });

  it("custom endpoints use the org's secret by id and are customer-billed", async () => {
    const ctx = context();
    const secret = await ctx.credentials.create('org_a', { provider: 'custom', secret: 'endpoint-secret-abcdef' });
    const config = parseAssistantConfig({ model: { provider: 'custom', url: 'https://llm.example.com/v1', credentialId: secret.id } });
    const providers = await resolveCallProviders(config, createDefaultRegistry(), ctx, logger);
    expect(providers.model[0]).toMatchObject({ provider: 'custom', credentialSource: 'org', credentialId: secret.id, billing: 'customer' });

    // The same credential id from another org is not found
    const other = { ...ctx, orgId: 'org_b' };
    await expect(resolveCallProviders(config, createDefaultRegistry(), other, logger)).rejects.toThrow(/Credential .* not found for this org/);
  });

  it('createPlatform wires env keys, encryption and the dev default voice', async () => {
    const platform = createPlatform({ ...ALL_KEYS, CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    const providers = await platform.providersForCall(parseAssistantConfig({}), 'org_x', logger);
    expect(providers.voice[0].instance).toBeInstanceOf(ElevenLabsVoice);
    expect(() => createPlatform({ CUSTOM_ENDPOINTS_ALLOW_PRIVATE: 'true', NODE_ENV: 'production' })).toThrow(/not allowed/);
  });
});
